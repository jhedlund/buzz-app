// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { titleRevision } from "../../features/messages/thread-titles";
import type { Panels } from "../../features/panels/service";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import { PublishRejected } from "../../features/relay/outbox";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { channelTabs, useChannelTabState } from "./useChannelTabState";
import { useConversationTabs } from "./useConversationTabs";

afterEach(cleanup);

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
  const session = {
    viewer: "viewer",
    snapshotRead,
    configArtifactWriter: {
      sign: vi.fn(async (t: { tags: string[][]; content: string }) => ({
        ...t,
        kind: 45010,
        created_at: 1,
        id: "new",
        pubkey: "f".repeat(64),
        sig: "",
      })),
      publish,
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
  return { session, publish, snapshotRead, item, localName };
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

it("keeps the typed name on the tab when the shared write fails", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const h = await harness({
    publish: vi.fn(async () => {
      throw new PublishRejected("Rejected", "restricted: not a member");
    }),
  });
  await waitFor(() => expect(h.snapshotRead).toHaveBeenCalled());
  act(() => h.item()?.rename?.("Launch plan"));
  await waitFor(() => expect(warn).toHaveBeenCalled());
  expect(h.localName()).toBe("Launch plan");
  expect(h.item()?.label).toBe("Launch plan");
  // Over the byte limit never reaches the relay and stays local too.
  const long = "x".repeat(513);
  act(() => h.item()?.rename?.(long));
  expect(h.localName()).toBe(long);
  expect(h.publish).toHaveBeenCalledTimes(1);
  warn.mockRestore();
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
