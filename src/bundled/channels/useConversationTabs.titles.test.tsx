// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  enableThreadTitles,
  threadTitleStore,
} from "../../features/messages/thread-title-store";
import { titleRevision } from "../../features/messages/thread-titles";
import type { Panels } from "../../features/panels/service";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import { PublishRejected } from "../../features/relay/outbox";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { channelTabs, useChannelTabState } from "./useChannelTabState";
import { useConversationTabs } from "./useConversationTabs";

const toasts = vi.hoisted(() => ({
  notify: vi.fn<
    (
      title: string,
      tone: string,
      action?: { label: string; onClick(): void },
    ) => string
  >(() => ""),
}));
vi.mock("../../shared/design-system/ui/Toast", () => ({
  useToastNotification: () => toasts.notify,
}));

// The Named threads plugin turns shared titles on while it runs.
let disable: (() => void) | undefined;
beforeEach(() => {
  disable = enableThreadTitles();
  toasts.notify.mockClear();
});
afterEach(() => {
  cleanup();
  disable?.();
});

const ALPHA = "11111111-1111-4111-8111-111111111111";
const ROOT = "a".repeat(64);
const TAB = `thread:${ALPHA}:${ROOT}`;

async function harness({
  title,
  publish = vi.fn(async () => ""),
}: {
  title?: string;
  publish?: (event: RelayEvent) => Promise<unknown>;
} = {}) {
  const heads: RelayEvent[] = [];
  if (title) {
    const template = await titleRevision(ALPHA, ROOT, { op: "create" }, title);
    heads.push({
      ...template,
      id: "e1",
      pubkey: "f".repeat(64),
      sig: "",
    } as unknown as RelayEvent);
  }
  const snapshotRead = vi.fn(async (filters: readonly ReadFilter[]) => {
    const [filter] = filters;
    return heads.filter((head) =>
      head.tags.some(([k, v]) =>
        filter?.["#d"] ? k === "d" && v === filter["#d"][0] : k === "h",
      ),
    );
  });
  const channels = [{ id: ALPHA, name: "alpha" }];
  const writer = {
    sign: vi.fn(async (t: { tags: string[][]; content: string }) => ({
      ...t,
      kind: 45010,
      created_at: 1,
      id: "new",
      pubkey: "f".repeat(64),
      sig: "",
    })),
    publish,
  };
  const writerTaken = vi.fn();
  const session = {
    viewer: "viewer",
    snapshotRead,
    // Counted: only a shared title write takes the writer.
    get configArtifactWriter() {
      writerTaken();
      return writer;
    },
    artifacts: { follow: () => () => {} },
    channels: {
      list: () => ({ status: "ready", channels }),
      ensureList: () => () => {},
      subscribeList: () => () => {},
      window: () => ({
        rows: [{ id: ROOT, content: "Original message" }],
      }),
    },
  } as unknown as RelaySession;
  const available: never[] = [];
  const panels = {
    snapshot: () => available,
    subscribe: () => () => {},
  } as unknown as Panels;
  const relay = {
    snapshot: () => ({ status: "ready", session }),
  } as unknown as RelayData;
  const h = renderHook(() => {
    const state = useChannelTabState(session, ALPHA);
    const workspace = useConversationTabs({
      profiles: new Map(),
      state,
      relay,
      session,
      panels,
      current: channels[0],
      channels,
      scope: "scope:viewer",
      conversationIcon: () => null,
      leadingIds: [],
      continuingVisit: true,
      isLive: () => true,
      openLink: () => false,
    });
    return { state, workspace };
  });
  act(() => h.result.current.state.openThreadTab(ALPHA, ROOT, ROOT));
  const item = () =>
    h.result.current.workspace.items.find((tab) => tab.id === TAB) as
      | { label: string; rename?: (name: string) => void }
      | undefined;
  const localName = () =>
    (
      h.result.current.state.tabs.find((tab) => tab.id === TAB) as
        | { name?: string }
        | undefined
    )?.name;
  return {
    session,
    heads,
    publish,
    snapshotRead,
    writerTaken,
    item,
    localName,
  };
}

it("labels a thread tab with its local name, then its shared title, then its text", async () => {
  const h = await harness({ title: "Launch plan" });
  await waitFor(() => expect(h.item()?.label).toBe("Launch plan"));
  act(() => {
    channelTabs(h.session).rename(ALPHA, ROOT, "Mine");
  });
  expect(h.item()?.label).toBe("Mine");
  act(() => {
    channelTabs(h.session).rename(ALPHA, ROOT, "");
  });
  expect(h.item()?.label).toBe("Launch plan");
  expect(h.publish).not.toHaveBeenCalled();
});

it("renaming a thread tab publishes the shared title and drops the local name", async () => {
  const h = await harness();
  await waitFor(() => expect(h.snapshotRead).toHaveBeenCalled());
  expect(h.item()?.label).toBe("Original message");
  act(() => h.item()?.rename?.("  Launch plan "));
  // The typed name shows while the write is in flight.
  expect(h.item()?.label).toBe("Launch plan");
  await waitFor(() => expect(h.localName()).toBeFalsy());
  expect(h.item()?.label).toBe("Launch plan");
  const [signed] = vi.mocked(h.publish).mock.calls[0] ?? [];
  expect(signed?.tags).toContainEqual(["op", "create"]);
  expect(signed?.tags).toContainEqual(["title", "Launch plan"]);
});

it("renaming against a titled thread updates it from the shown revision", async () => {
  const h = await harness({ title: "Launch plan" });
  await waitFor(() => expect(h.item()?.label).toBe("Launch plan"));
  act(() => h.item()?.rename?.("Ship plan"));
  await waitFor(() => expect(h.publish).toHaveBeenCalled());
  const [signed] = vi.mocked(h.publish).mock.calls[0] ?? [];
  expect(signed?.tags).toContainEqual(["op", "update"]);
  expect(signed?.tags).toContainEqual(["prev", "e1"]);
  await waitFor(() => expect(h.localName()).toBeFalsy());
  expect(h.item()?.label).toBe("Ship plan");
});

it("a failed shared write drops the typed name and offers a retry", async () => {
  const publish = vi.fn(async (_event: RelayEvent): Promise<unknown> => {
    throw new PublishRejected("Rejected", "restricted: not a member");
  });
  const h = await harness({ title: "Launch plan", publish });
  await waitFor(() => expect(h.item()?.label).toBe("Launch plan"));
  act(() => h.item()?.rename?.("Ship plan"));
  expect(h.item()?.label).toBe("Ship plan");
  await waitFor(() => expect(toasts.notify).toHaveBeenCalledOnce());
  const [message, tone, action] = toasts.notify.mock.calls[0] ?? [];
  expect(message).toMatch(/^Couldn’t save the thread title\./);
  expect(tone).toBe("error");
  expect(action?.label).toBe("Retry");
  // The local name can't hide the shared title once the write failed.
  expect(h.localName()).toBeFalsy();
  expect(h.item()?.label).toBe("Launch plan");
  // Retry writes the same name again, and this time it lands.
  publish.mockResolvedValueOnce("");
  act(() => action?.onClick());
  expect(h.item()?.label).toBe("Ship plan");
  await waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(h.localName()).toBeFalsy());
  expect(h.item()?.label).toBe("Ship plan");
  expect(publish.mock.calls[1]?.[0].tags).toContainEqual([
    "title",
    "Ship plan",
  ]);
});

it("Retry keeps the revision it was typed over, and a conflict offers none", async () => {
  const publish = vi.fn(async (_event: RelayEvent): Promise<unknown> => {
    throw new PublishRejected("Rejected", "relay unavailable");
  });
  const h = await harness({ title: "Launch plan", publish });
  await waitFor(() => expect(h.item()?.label).toBe("Launch plan"));
  act(() => h.item()?.rename?.("Ship plan"));
  await waitFor(() => expect(toasts.notify).toHaveBeenCalledOnce());
  const retry = toasts.notify.mock.calls[0]?.[2];
  // Meanwhile someone else retitles the thread, and this client sees it.
  const theirs = await titleRevision(
    ALPHA,
    ROOT,
    { op: "update", prev: "e1" },
    "Their plan",
  );
  const head = { ...theirs, id: "e2", pubkey: "", sig: "" };
  h.heads.splice(0, 1, head as unknown as RelayEvent);
  act(() =>
    threadTitleStore(h.session).apply(ALPHA, ROOT, {
      title: "Their plan",
      channel: ALPHA,
      root: ROOT,
      revision: "e2",
      updatedAt: 2,
    }),
  );
  // Retry still expects e1, so it conflicts instead of replacing their title.
  act(() => retry?.onClick());
  await waitFor(() => expect(toasts.notify).toHaveBeenCalledTimes(2));
  const [message, , action] = toasts.notify.mock.calls[1] ?? [];
  expect(message).toMatch(/Someone else changed this thread/);
  expect(action).toBeUndefined();
  expect(publish).toHaveBeenCalledOnce();
  expect(h.localName()).toBeFalsy();
  expect(h.item()?.label).toBe("Their plan");
});

it("an older failure's Retry does nothing after a newer rename", async () => {
  const publish = vi.fn(async (_event: RelayEvent): Promise<unknown> => {
    throw new PublishRejected("Rejected", "relay unavailable");
  });
  const h = await harness({ title: "Launch plan", publish });
  await waitFor(() => expect(h.item()?.label).toBe("Launch plan"));
  act(() => h.item()?.rename?.("Ship plan"));
  await waitFor(() => expect(toasts.notify).toHaveBeenCalledOnce());
  const stale = toasts.notify.mock.calls[0]?.[2];
  publish.mockResolvedValueOnce("");
  act(() => h.item()?.rename?.("Final plan"));
  await waitFor(() => expect(h.localName()).toBeFalsy());
  expect(h.item()?.label).toBe("Final plan");
  act(() => stale?.onClick());
  expect(h.item()?.label).toBe("Final plan");
  expect(publish).toHaveBeenCalledTimes(2);
});

it("a failed rename's Retry does nothing once titles are off or the tab was renamed", async () => {
  const publish = vi.fn(async (_event: RelayEvent): Promise<unknown> => {
    throw new PublishRejected("Rejected", "relay unavailable");
  });
  const h = await harness({ title: "Launch plan", publish });
  await waitFor(() => expect(h.item()?.label).toBe("Launch plan"));
  const fail = async (name: string) => {
    const before = toasts.notify.mock.calls.length;
    act(() => h.item()?.rename?.(name));
    await waitFor(() =>
      expect(toasts.notify).toHaveBeenCalledTimes(before + 1),
    );
    return toasts.notify.mock.calls[before]?.[2];
  };
  publish.mockResolvedValue("");
  publish.mockRejectedValueOnce(new Error("relay unavailable"));
  // Shared titles switched off: Retry publishes nothing.
  const whileOff = await fail("Ship plan");
  act(() => disable?.());
  act(() => whileOff?.onClick());
  // A local rename while off, then back on: the old Retry stays retired.
  act(() => h.item()?.rename?.("Mine"));
  act(() => {
    disable = enableThreadTitles();
  });
  act(() => whileOff?.onClick());
  expect(h.localName()).toBe("Mine");
  // A blank rename retires it too.
  act(() => h.item()?.rename?.(""));
  publish.mockRejectedValueOnce(new Error("relay unavailable"));
  const beforeBlank = await fail("Ship plan");
  act(() => h.item()?.rename?.(""));
  act(() => beforeBlank?.onClick());
  expect(publish).toHaveBeenCalledTimes(2);
  expect(h.localName()).toBeFalsy();
});

it("a name over the byte limit says so and changes nothing", async () => {
  const h = await harness({ title: "Launch plan" });
  await waitFor(() => expect(h.item()?.label).toBe("Launch plan"));
  act(() => h.item()?.rename?.("x".repeat(513)));
  expect(toasts.notify).toHaveBeenCalledWith(
    "Titles can be at most 512 bytes.",
    "error",
  );
  expect(h.localName()).toBeFalsy();
  expect(h.item()?.label).toBe("Launch plan");
  expect(h.publish).not.toHaveBeenCalled();
});

it("an empty rename clears only the local name, never the shared title", async () => {
  const h = await harness({ title: "Launch plan" });
  await waitFor(() => expect(h.item()?.label).toBe("Launch plan"));
  act(() => {
    channelTabs(h.session).rename(ALPHA, ROOT, "Mine");
  });
  act(() => h.item()?.rename?.(""));
  expect(h.localName()).toBeFalsy();
  expect(h.item()?.label).toBe("Launch plan");
  expect(h.publish).not.toHaveBeenCalled();
});

it("with shared titles off, a tab shows no shared title and renames stay local", async () => {
  disable?.();
  const h = await harness({ title: "Launch plan" });
  expect(h.item()?.label).toBe("Original message");
  act(() => h.item()?.rename?.("Mine"));
  expect(h.localName()).toBe("Mine");
  expect(h.item()?.label).toBe("Mine");
  // A shared write takes the writer as it starts, before any await.
  expect(h.writerTaken).not.toHaveBeenCalled();
  expect(h.snapshotRead).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
});

it("follows shared titles being switched off and on while a tab is open", async () => {
  const h = await harness({ title: "Launch plan" });
  await waitFor(() => expect(h.item()?.label).toBe("Launch plan"));
  act(() => disable?.());
  expect(h.item()?.label).toBe("Original message");
  act(() => h.item()?.rename?.("Mine"));
  expect(h.localName()).toBe("Mine");
  expect(h.writerTaken).not.toHaveBeenCalled();
  act(() => h.item()?.rename?.(""));
  act(() => {
    disable = enableThreadTitles();
  });
  await waitFor(() => expect(h.item()?.label).toBe("Launch plan"));
  act(() => h.item()?.rename?.("Ship plan"));
  await waitFor(() => expect(h.publish).toHaveBeenCalledTimes(1));
});
