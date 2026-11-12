// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Navigation } from "../../features/navigation/controller";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";
import { titleRevision } from "../../features/messages/thread-titles";
import { ThreadsView } from "./ThreadsPage";

const ALPHA = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const scope = {
  viewer: "f".repeat(64),
  communityOrigin: "https://example.org",
};
const event = (
  id: string,
  tags: string[][],
  content: string,
  created_at: number,
) =>
  ({
    id,
    pubkey: scope.viewer,
    kind: 45010,
    created_at,
    content,
    tags,
    sig: "",
  }) as unknown as RelayEvent;
async function title(
  id: string,
  text: string,
  root: string,
  channel: string,
  at: number,
) {
  const template = await titleRevision(channel, root, { op: "create" }, text);
  return event(id, template.tags, text, at);
}

const reply = (id: string, channel: string, root: string, at: number) => ({
  ...event(
    id,
    [
      ["h", channel],
      ["e", root, "", "reply"],
    ],
    "hi",
    at,
  ),
  kind: 9,
});

async function fixture({
  empty = false,
  writable = true,
  hold,
  holdActivity,
  marks,
}: {
  empty?: boolean;
  writable?: boolean;
  hold?: Promise<void>;
  /** Holds every reply read open until it resolves. */
  holdActivity?: Promise<void>;
  /** Private pin and done records by coordinate; omitted: no host for them. */
  marks?: Record<string, unknown>;
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  // The relay's current heads and stored replies; a test changes them as the
  // relay would.
  const relay = {
    heads: [] as RelayEvent[],
    replies: [reply("r1", ALPHA, "a".repeat(64), now - 10)] as RelayEvent[],
  };
  const titles = empty
    ? []
    : [
        await title("e1", "Launch plan", "a".repeat(64), ALPHA, now - 500),
        await title("e2", "Bug triage", "b".repeat(64), BETA, now - 400),
        await title("e3", "Retro notes", "c".repeat(64), ALPHA, now - 300),
      ];
  const publish = vi.fn(async () => "");
  relay.heads = titles;
  const snapshotRead = vi.fn(async (filters: readonly ReadFilter[]) => {
    const [filter] = filters;
    // A head read names one `d`.
    if (filter?.["#d"])
      return relay.heads.filter((t) =>
        t.tags.some(([k, v]) => k === "d" && v === filter["#d"]?.[0]),
      );
    // The first list read can be held open; it answers with the heads it
    // started with, as a relay would.
    const heads = relay.heads;
    if (hold && snapshotRead.mock.calls.length === 1) await hold;
    return heads.filter((t) =>
      t.tags.some(([k, v]) => k === "h" && filter?.["#h"]?.includes(v ?? "")),
    );
  });
  // A newer reply moves Launch plan to the top.
  const read = vi.fn(async (filters: readonly ReadFilter[]) => {
    await holdActivity;
    return relay.replies.filter((r) =>
      r.tags.some(
        ([k, v]) => k === "e" && filters[0]?.["#e"]?.includes(v ?? ""),
      ),
    );
  });
  const list = {
    status: "ready",
    channels: [
      { id: ALPHA, name: "alpha" },
      { id: BETA, name: "beta" },
    ],
  };
  const live: {
    titles?: ((events: readonly RelayEvent[]) => void) | undefined;
    events?:
      | ((batch: { events: readonly RelayEvent[]; replay?: boolean }) => void)
      | undefined;
    replay?: boolean | undefined;
    followed?: readonly string[];
  } = {};
  const records = marks;
  const writeThreadMarks = vi.fn(
    async (
      coordinate: string,
      update: (current: unknown) => Record<string, unknown>,
    ) => {
      if (!records) throw new Error("no host");
      records[coordinate] = update(records[coordinate]);
      return records[coordinate];
    },
  );
  const session = {
    ...(records && {
      readThreadMarks: vi.fn(async (coordinate: string) => records[coordinate]),
      writeThreadMarks,
    }),
    artifacts: {
      follow: vi.fn((ids: readonly string[], listener: typeof live.titles) => {
        live.followed = ids;
        live.titles = listener;
        return () => {
          live.titles = undefined;
        };
      }),
    },
    subscribeLive: vi.fn(
      (listener: typeof live.events, options?: { replay?: boolean }) => {
        live.events = listener;
        live.replay = options?.replay;
        return () => {
          live.events = undefined;
        };
      },
    ),
    channels: {
      ensureList: () => () => {},
      subscribeList: () => () => {},
      list: () => list,
    },
    snapshotRead,
    read,
    configArtifactWriter: writable
      ? {
          sign: vi.fn(async (t: { tags: string[][]; content: string }) =>
            event("new", t.tags, t.content, now),
          ),
          publish,
        }
      : undefined,
  } as unknown as RelaySession;
  const open = vi.fn(async () => ({ status: "opened" }));
  const mount = () =>
    render(
      <ThreadsView
        session={session}
        scope={scope}
        navigator={{ open } as unknown as Navigation}
      />,
    );
  const view = mount();
  return {
    publish,
    open,
    snapshotRead,
    read,
    live,
    now,
    relay,
    view,
    mount,
    writeThreadMarks,
  };
}
const rows = async () =>
  within(await screen.findByRole("list", { name: "Named threads" }))
    .queryAllByRole("listitem")
    .map((item) => item.textContent?.split("·")[0]?.trim());

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("lists titles newest activity first with their channel, and opens the thread root", async () => {
  const f = await fixture();
  expect(await rows()).toEqual([
    "Launch planalpha",
    "Retro notesalpha",
    "Bug triagebeta",
  ]);
  await userEvent.click(screen.getByRole("button", { name: /^Launch plan/ }));
  expect(f.open).toHaveBeenCalledWith({
    version: 1,
    kind: "conversation",
    scope,
    channelId: ALPHA,
    messageId: "a".repeat(64),
    threadRootId: "a".repeat(64),
  });
});

it("filters by channel", async () => {
  await fixture();
  await rows();
  await userEvent.click(screen.getByRole("combobox", { name: "Channel" }));
  await userEvent.click(await screen.findByRole("option", { name: "beta" }));
  await waitFor(async () => expect(await rows()).toEqual(["Bug triagebeta"]));
});

it("offers a clear-filter button only while a channel is chosen", async () => {
  await fixture();
  await rows();
  expect(
    screen.queryByRole("button", { name: "Show all channels" }),
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("combobox", { name: "Channel" }));
  await userEvent.click(await screen.findByRole("option", { name: "alpha" }));
  await waitFor(async () => expect(await rows()).toHaveLength(2));
  await userEvent.click(
    screen.getByRole("button", { name: "Show all channels" }),
  );
  expect(await rows()).toHaveLength(3);
  expect(screen.getByRole("combobox", { name: "Channel" })).toHaveFocus();
  expect(
    screen.queryByRole("button", { name: "Show all channels" }),
  ).not.toBeInTheDocument();
});

it("draws rows by title time before any reply read returns, then reorders", async () => {
  let release = () => {};
  const holdActivity = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture({ holdActivity });
  try {
    await waitFor(() => expect(f.read).toHaveBeenCalled());
    expect(await rows()).toEqual([
      "Retro notesalpha",
      "Bug triagebeta",
      "Launch planalpha",
    ]);
  } finally {
    release();
  }
  await waitFor(async () => expect((await rows())[0]).toBe("Launch planalpha"));
});

it("takes a reply missed while disconnected from the reconnect replay", async () => {
  const f = await fixture();
  await waitFor(async () => expect((await rows())[0]).toBe("Launch planalpha"));
  await waitFor(() => expect(f.read).toHaveBeenCalledTimes(2));
  expect(f.live.replay).toBe(true);
  f.view.unmount();
  // After a reconnect, the route replays a reply sent while offline.
  act(() =>
    f.live.events?.({
      events: [reply("r8", ALPHA, "c".repeat(64), f.now)],
      replay: true,
    }),
  );
  f.mount();
  expect((await rows())[0]).toBe("Retro notesalpha");
  expect(f.read).toHaveBeenCalledTimes(2);
});

it("reopens with no relay reads and keeps replies that arrived while closed", async () => {
  const f = await fixture();
  await waitFor(async () => expect((await rows())[0]).toBe("Launch planalpha"));
  await waitFor(() => expect(f.read).toHaveBeenCalledTimes(2));
  const titleReads = f.snapshotRead.mock.calls.length;
  f.view.unmount();
  // Bug triage gets a newer reply while the page is closed.
  act(() =>
    f.live.events?.({
      events: [reply("r9", BETA, "b".repeat(64), f.now)],
    }),
  );
  f.mount();
  expect(await rows()).toEqual([
    "Bug triagebeta",
    "Launch planalpha",
    "Retro notesalpha",
  ]);
  expect(f.snapshotRead).toHaveBeenCalledTimes(titleReads);
  expect(f.read).toHaveBeenCalledTimes(2);
});

it("renames inline with Enter and cancels with Escape", async () => {
  const f = await fixture();
  await rows();
  await userEvent.click(
    screen.getByRole("button", { name: "Rename Bug triage" }),
  );
  await userEvent.keyboard("{Escape}");
  expect(f.publish).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("button", { name: "Rename Bug triage" }),
  );
  const field = screen.getByRole("textbox", { name: "Title for Bug triage" });
  await userEvent.clear(field);
  await userEvent.type(field, "  Bugs  {Enter}");
  expect(
    await screen.findByRole("button", { name: /^Bugs/ }),
  ).toBeInTheDocument();
  const [signed] = f.publish.mock.calls[0] as unknown as [RelayEvent];
  expect(signed.tags).toContainEqual(["op", "update"]);
  expect(signed.tags).toContainEqual(["prev", "e2"]);
  expect(signed.tags).toContainEqual(["title", "Bugs"]);
  expect(f.publish).toHaveBeenCalledTimes(1);
});

it("clears a title saved blank with a soft delete and removes its row", async () => {
  const f = await fixture();
  await rows();
  expect(
    screen.queryByRole("button", { name: /^Clear title/ }),
  ).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Rename Retro notes" }),
  );
  await userEvent.clear(
    screen.getByRole("textbox", { name: "Title for Retro notes" }),
  );
  await userEvent.keyboard("{Enter}");
  await waitFor(async () =>
    expect(await rows()).toEqual(["Launch planalpha", "Bug triagebeta"]),
  );
  const [signed] = f.publish.mock.calls[0] as unknown as [RelayEvent];
  expect(signed.tags).toContainEqual(["op", "delete"]);
  expect(signed.content).toBe("");
});

it("reports a title someone else changed instead of overwriting it", async () => {
  const f = await fixture();
  await rows();
  // The head is now another revision.
  f.snapshotRead.mockImplementationOnce(async () => [
    await title("e9", "Theirs", "a".repeat(64), ALPHA, 1),
  ]);
  await userEvent.click(
    screen.getByRole("button", { name: "Rename Launch plan" }),
  );
  await userEvent.type(
    screen.getByRole("textbox", { name: "Title for Launch plan" }),
    " v2{Enter}",
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Someone else changed this thread's title",
  );
  expect(f.publish).not.toHaveBeenCalled();
  expect(await rows()).toHaveLength(3);
});

it("shows an empty state when no thread has a title, and no edit actions without a writer", async () => {
  await fixture({ empty: true });
  expect(await screen.findByText("No named threads")).toBeInTheDocument();
  cleanup();
  await fixture({ writable: false });
  await rows();
  expect(
    screen.queryByRole("button", { name: /^Rename/ }),
  ).not.toBeInTheDocument();
});

it("moves a locally renamed old thread to the top with a fresh time", async () => {
  await fixture();
  expect(await rows()).toEqual([
    "Launch planalpha",
    "Retro notesalpha",
    "Bug triagebeta",
  ]);
  await userEvent.click(
    screen.getByRole("button", { name: "Rename Bug triage" }),
  );
  const field = screen.getByRole("textbox", { name: "Title for Bug triage" });
  await userEvent.clear(field);
  await userEvent.type(field, "Bugs{Enter}");
  await waitFor(async () =>
    expect(await rows()).toEqual([
      "Bugsbeta",
      "Launch planalpha",
      "Retro notesalpha",
    ]),
  );
  expect(screen.getByRole("button", { name: /^Bugs/ })).toHaveTextContent(
    "beta · just now",
  );
});

it("takes titles from the relay's current read, not live event order", async () => {
  const f = await fixture();
  await rows();
  expect(f.live.followed).toEqual([ALPHA, BETA]);
  const reads = f.snapshotRead.mock.calls.length;
  // NIP-AR orders revisions by `prev`: the head e5 is older than the e4 it
  // replaces, and a newest-first replay delivers e5 before e4.
  const b = "b".repeat(64);
  const e4 = await title("e4", "Bug board", b, BETA, f.now - 5);
  const e5 = await title("e5", "Bug list", b, BETA, f.now - 50);
  f.relay.heads = f.relay.heads.map((head) => (head.id === "e2" ? e5 : head));
  act(() => f.live.titles?.([e5, e4]));
  await waitFor(async () =>
    expect(await rows()).toEqual([
      "Launch planalpha",
      "Bug listbeta",
      "Retro notesalpha",
    ]),
  );
  // One read for the burst, of the stale channel only.
  expect(f.snapshotRead.mock.calls.slice(reads)).toEqual([
    [[expect.objectContaining({ "#h": [BETA] })], expect.anything()],
  ]);
  // A clear followed by its same-second predecessor: the relay has no head.
  const c = "c".repeat(64);
  const cleared = await titleRevision(ALPHA, c, { op: "delete", prev: "e3" });
  f.relay.heads = f.relay.heads.filter((head) => head.id !== "e3");
  const predecessor = await title("e3", "Retro notes", c, ALPHA, f.now - 300);
  act(() =>
    f.live.titles?.([event("e6", cleared.tags, "", f.now - 300), predecessor]),
  );
  await waitFor(async () =>
    expect(await rows()).toEqual(["Launch planalpha", "Bug listbeta"]),
  );
  // A revision whose `d` is not derived from its root changes nothing.
  const forged = (
    await title("e7", "Forged", "d".repeat(64), ALPHA, f.now)
  ).tags.map(([k, v]) => (k === "d" ? ["d", "x"] : [k ?? "", v ?? ""]));
  const before = f.snapshotRead.mock.calls.length;
  act(() => f.live.titles?.([event("e7", forged, "Forged", f.now)]));
  // A reply is the completion barrier: it lands after the forged revision.
  act(() =>
    f.live.events?.({ events: [reply("r2", BETA, "b".repeat(64), f.now)] }),
  );
  await waitFor(async () =>
    expect(await rows()).toEqual(["Bug listbeta", "Launch planalpha"]),
  );
  expect(f.snapshotRead.mock.calls.length).toBe(before);
});

it("keeps a rename and a reply that arrive while the first read is open", async () => {
  let release = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture({ hold });
  try {
    await waitFor(() => expect(f.snapshotRead).toHaveBeenCalledTimes(1));
    const b = "b".repeat(64);
    const renamed = await title("e4", "Bug board", b, BETA, f.now - 5);
    f.relay.heads = f.relay.heads.map((head) =>
      head.id === "e2" ? renamed : head,
    );
    act(() => f.live.titles?.([renamed]));
    // The relay stores the reply before it is delivered live.
    const late = reply("r2", ALPHA, "c".repeat(64), f.now);
    f.relay.replies.push(late);
    act(() => f.live.events?.({ events: [late] }));
    // Both are pending until the read settles; no read starts meanwhile.
    expect(f.snapshotRead).toHaveBeenCalledTimes(1);
  } finally {
    release();
  }
  await waitFor(async () =>
    expect(await rows()).toEqual([
      "Retro notesalpha",
      "Bug boardbeta",
      "Launch planalpha",
    ]),
  );
  expect(f.snapshotRead).toHaveBeenCalledTimes(2);
});

it("clears a failed automatic re-read's error once a later one succeeds", async () => {
  const f = await fixture();
  await rows();
  const b = "b".repeat(64);
  const renamed = await title("e4", "Bug board", b, BETA, f.now - 5);
  f.snapshotRead.mockRejectedValueOnce(new Error("Relay offline"));
  act(() => f.live.titles?.([renamed]));
  expect(await screen.findByRole("alert")).toHaveTextContent("Relay offline");
  f.relay.heads = f.relay.heads.map((head) =>
    head.id === "e2" ? renamed : head,
  );
  act(() => f.live.titles?.([renamed]));
  await waitFor(async () => expect(await rows()).toContain("Bug boardbeta"));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("reads a restored thread's replies again, even when its successor is older", async () => {
  const f = await fixture();
  await rows();
  const a = "a".repeat(64);
  const historyReads = () =>
    f.read.mock.calls.filter(([[filter]]) => filter?.["#e"]?.includes(a))
      .length;
  expect(historyReads()).toBe(1);
  // Cleared: the relay has no head for the thread.
  const cleared = await titleRevision(ALPHA, a, { op: "delete", prev: "e1" });
  f.relay.heads = f.relay.heads.filter((head) => head.id !== "e1");
  act(() => f.live.titles?.([event("e8", cleared.tags, "", f.now - 2)]));
  await waitFor(async () =>
    expect(await rows()).toEqual(["Retro notesalpha", "Bug triagebeta"]),
  );
  // Restored by a successor stamped before its reply at now - 10.
  const restored = await title("e9", "Launch plan", a, ALPHA, f.now - 600);
  f.relay.heads = [...f.relay.heads, restored];
  act(() => f.live.titles?.([restored]));
  await waitFor(async () =>
    expect(await rows()).toEqual([
      "Launch planalpha",
      "Retro notesalpha",
      "Bug triagebeta",
    ]),
  );
  expect(historyReads()).toBe(2);
});

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const list = async (name: string) =>
  within(await screen.findByRole("list", { name }))
    .queryAllByRole("listitem")
    .map((item) => item.textContent?.split("·")[0]?.trim());

it("shows pinned threads first and done ones collapsed, a pinned done one staying pinned", async () => {
  const later = Date.now() + 60_000;
  await fixture({
    marks: {
      "thread-pins": {
        version: 1,
        roots: {
          [B]: { pinned: true, updatedAt: 1 },
          [C]: { pinned: false, updatedAt: 1 },
        },
      },
      "thread-done": {
        version: 1,
        roots: {
          [B]: { done: true, updatedAt: later },
          [C]: { done: true, updatedAt: later },
        },
      },
    },
  });
  expect(await list("Pinned threads")).toEqual(["Bug triagebeta"]);
  await waitFor(async () =>
    expect(await list("Named threads")).toEqual(["Launch planalpha"]),
  );
  expect(
    screen.getByRole("button", { name: "Reopen Bug triage" }),
  ).toBeInTheDocument();
  const toggle = screen.getByRole("button", { name: "Done (1)" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(toggle);
  expect(await list("Done threads")).toEqual(["Retro notesalpha"]);
});

it("pins and marks done by changing one root of the latest record", async () => {
  const f = await fixture({
    marks: {
      "thread-pins": {
        version: 1,
        roots: { [C]: { pinned: true, updatedAt: 1 } },
      },
    },
  });
  await screen.findByRole("list", { name: "Pinned threads" });
  await userEvent.click(
    screen.getByRole("button", { name: "Pin Launch plan" }),
  );
  await waitFor(async () =>
    expect(await list("Pinned threads")).toEqual([
      "Launch planalpha",
      "Retro notesalpha",
    ]),
  );
  const [coordinate, update] = f.writeThreadMarks.mock.calls[0] ?? [];
  expect(coordinate).toBe("thread-pins");
  expect(update?.(undefined)).toMatchObject({
    version: 1,
    roots: { [A]: { pinned: true } },
  });
  await userEvent.click(
    screen.getByRole("button", { name: "Mark done Bug triage" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Done (1)" }),
    ).toBeInTheDocument(),
  );
  expect(f.writeThreadMarks.mock.calls[1]?.[0]).toBe("thread-done");
});

it("reopens a done thread once it has newer activity", async () => {
  // Marked done before Launch plan's reply at now - 10.
  const before = (Math.floor(Date.now() / 1000) - 100) * 1000;
  await fixture({
    marks: {
      "thread-done": {
        version: 1,
        roots: { [A]: { done: true, updatedAt: before } },
      },
    },
  });
  await waitFor(async () => expect((await rows())[0]).toBe("Launch planalpha"));
  expect(
    screen.queryByRole("button", { name: /^Done/ }),
  ).not.toBeInTheDocument();
});

it("writes nothing over a record it can't read", async () => {
  const f = await fixture({
    marks: { "thread-pins": { version: 7 } },
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "couldn't be read",
  );
  expect(
    screen.queryByRole("button", { name: "Pin Launch plan" }),
  ).not.toBeInTheDocument();
  expect(f.writeThreadMarks).not.toHaveBeenCalled();
});

it("offers no pin or done without the host's private records", async () => {
  await fixture();
  await rows();
  expect(
    screen.queryByRole("button", { name: /^Pin / }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /^Mark done / }),
  ).not.toBeInTheDocument();
});
