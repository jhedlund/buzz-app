import { describe, expect, it, vi } from "vitest";
import type { ReadFilter, RelayEvent } from "../relay/events";
import type { RelaySession } from "../relay/session";
import {
  enableThreadTitles,
  retryDelay,
  threadTitlesEnabled,
  threadTitleStore,
} from "./thread-title-store";
import { titleRevision } from "./thread-titles";

const ALPHA = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const ROOT = "a".repeat(64);

async function head(id: string, text: string, channel = ALPHA, root = ROOT) {
  const template = await titleRevision(channel, root, { op: "create" }, text);
  return { ...template, id, pubkey: "f".repeat(64), sig: "" } as RelayEvent;
}

function fixture(heads: RelayEvent[]) {
  const relay = { heads, channels: [ALPHA] };
  const listListeners = new Set<() => void>();
  const follow: {
    ids?: readonly string[];
    listener?: ((events: readonly RelayEvent[]) => void) | undefined;
  } = {};
  const snapshotRead = vi.fn(async (filters: readonly ReadFilter[]) =>
    relay.heads.filter((h) =>
      h.tags.some(
        ([k, v]) => k === "h" && filters[0]?.["#h"]?.includes(v ?? ""),
      ),
    ),
  );
  const session = {
    snapshotRead,
    artifacts: {
      follow: vi.fn(
        (ids: readonly string[], listener: typeof follow.listener) => {
          follow.ids = ids;
          follow.listener = listener;
          return () => {
            follow.listener = undefined;
          };
        },
      ),
    },
    channels: {
      list: () => ({
        status: "ready",
        channels: relay.channels.map((id) => ({ id })),
      }),
      ensureList: () => () => {},
      subscribeList: (listener: () => void) => {
        listListeners.add(listener);
        return () => listListeners.delete(listener);
      },
    },
  } as unknown as RelaySession;
  const changeList = (channels: string[]) => {
    relay.channels = channels;
    for (const listener of listListeners) listener();
  };
  return { session, relay, follow, snapshotRead, changeList };
}

describe("thread title store", () => {
  it("is one store per session and reads nothing until someone subscribes", async () => {
    const f = fixture([await head("e1", "Launch plan")]);
    const store = threadTitleStore(f.session);
    expect(threadTitleStore(f.session)).toBe(store);
    expect(f.snapshotRead).not.toHaveBeenCalled();
    const stop = store.subscribe(() => {});
    await vi.waitFor(() =>
      expect(store.get(ALPHA, ROOT.toUpperCase())?.title).toBe("Launch plan"),
    );
    expect(f.follow.ids).toEqual([ALPHA]);
    stop();
    expect(f.follow.listener).toBeUndefined();
  });

  it("re-reads a channel a live revision names, and drops a cleared title", async () => {
    const f = fixture([await head("e1", "Launch plan")]);
    const store = threadTitleStore(f.session);
    const seen = vi.fn();
    const stop = store.subscribe(seen);
    await vi.waitFor(() => expect(store.get(ALPHA, ROOT)).toBeDefined());
    const renamed = await head("e2", "Ship plan");
    f.relay.heads = [renamed];
    f.follow.listener?.([renamed]);
    await vi.waitFor(() =>
      expect(store.get(ALPHA, ROOT)?.title).toBe("Ship plan"),
    );
    const cleared = await titleRevision(ALPHA, ROOT, {
      op: "delete",
      prev: "e2",
    });
    f.relay.heads = [];
    f.follow.listener?.([
      { ...cleared, id: "e3", pubkey: "", sig: "" } as unknown as RelayEvent,
    ]);
    await vi.waitFor(() => expect(store.get(ALPHA, ROOT)).toBeUndefined());
    expect(f.snapshotRead).toHaveBeenCalledTimes(3);
    stop();
  });

  it("follows and reads again when the joined channels change, not on a same-set refresh", async () => {
    const f = fixture([
      await head("e1", "Launch plan"),
      await head("e2", "Bug triage", BETA, "b".repeat(64)),
    ]);
    const store = threadTitleStore(f.session);
    const stop = store.subscribe(() => {});
    await vi.waitFor(() => expect(store.get(ALPHA, ROOT)).toBeDefined());
    f.changeList([ALPHA]);
    expect(f.snapshotRead).toHaveBeenCalledTimes(1);
    f.changeList([BETA, ALPHA]);
    await vi.waitFor(() =>
      expect(store.get(BETA, "b".repeat(64))?.title).toBe("Bug triage"),
    );
    expect(f.follow.ids).toEqual([ALPHA, BETA]);
    // Leaving a channel drops its titles at once.
    f.changeList([BETA]);
    expect(store.get(ALPHA, ROOT)).toBeUndefined();
    stop();
  });

  it("reports a failed read and retries it after a backoff", async () => {
    // Only timers are faked: reads settle through real crypto and promises.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 100 && !done(); i++) await tick();
      expect(done()).toBe(true);
    };
    // A live revision is checked against its derived id before it marks a
    // channel stale; wait for that hash, then for the store to act on it.
    const digest = vi.spyOn(crypto.subtle, "digest");
    try {
      const f = fixture([await head("e1", "Launch plan")]);
      const live = async (event: RelayEvent) => {
        const before = digest.mock.results.length;
        f.follow.listener?.([event]);
        await until(() => digest.mock.results.length > before);
        await digest.mock.results.at(-1)?.value;
        await tick();
      };
      f.snapshotRead.mockRejectedValueOnce(new Error("Relay offline"));
      const store = threadTitleStore(f.session);
      const stop = store.subscribe(() => {});
      await until(() => store.snapshot().error === "Relay offline");
      expect(store.snapshot().titles?.size).toBe(0);
      // A live change in a failed channel waits for the backoff too.
      const renamed = await head("e2", "Launch plan");
      await live(renamed);
      vi.advanceTimersByTime(4_999);
      await tick();
      expect(f.snapshotRead).toHaveBeenCalledTimes(1);
      // The second failure waits twice as long, even when a live change
      // arrived while that read was pending.
      let fail: (cause: Error) => void = () => {};
      f.snapshotRead.mockImplementationOnce(
        () => new Promise((_, reject) => (fail = reject)),
      );
      vi.advanceTimersByTime(1);
      await until(() => f.snapshotRead.mock.calls.length === 2);
      await live(renamed);
      fail(new Error("Still offline"));
      await until(() => store.snapshot().error === "Still offline");
      vi.advanceTimersByTime(300);
      await tick();
      expect(f.snapshotRead).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(9_699);
      await tick();
      expect(f.snapshotRead).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(1);
      await until(() => store.get(ALPHA, ROOT)?.title === "Launch plan");
      expect(store.snapshot().error).toBeUndefined();
      expect(f.snapshotRead.mock.calls[2]?.[0][0]?.["#h"]).toEqual([ALPHA]);
      // Leaving stops a pending retry.
      f.snapshotRead.mockRejectedValueOnce(new Error("Offline again"));
      f.changeList([ALPHA, BETA]);
      await until(() => store.snapshot().error === "Offline again");
      stop();
      vi.advanceTimersByTime(60_000);
      await tick();
      expect(f.snapshotRead).toHaveBeenCalledTimes(4);
    } finally {
      digest.mockRestore();
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("spreads and caps the retry delay", () => {
    expect(retryDelay(1, () => 0)).toBe(2_500);
    expect(retryDelay(1, () => 0.5)).toBe(5_000);
    expect(retryDelay(3, () => 0.5)).toBe(20_000);
    expect(retryDelay(30, () => 0.5)).toBe(300_000);
    expect(retryDelay(30, () => 0.999)).toBeLessThan(450_000);
  });

  it("is empty and inert without a snapshot reader", () => {
    const f = fixture([]);
    const session = { ...f.session, snapshotRead: undefined } as RelaySession;
    const store = threadTitleStore(session);
    const stop = store.subscribe(() => {});
    expect(store.snapshot().titles?.size).toBe(0);
    expect(f.session.artifacts.follow).not.toHaveBeenCalled();
    stop();
  });
});

describe("shared title switch", () => {
  it("stays on while any enabler is live, so a late dispose of a replaced plugin can't turn it off", () => {
    expect(threadTitlesEnabled()).toBe(false);
    const first = enableThreadTitles();
    const second = enableThreadTitles();
    first();
    first();
    expect(threadTitlesEnabled()).toBe(true);
    second();
    expect(threadTitlesEnabled()).toBe(false);
  });
});
