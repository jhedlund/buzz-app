// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  activityKey,
  titleRevision,
} from "../../features/messages/thread-titles";
import type { RelaySession } from "../../features/relay/session";
import { SessionBadge } from "./ThreadsBadge";
import { unreadByThread, workingByThread } from "./thread-signals";

afterEach(cleanup);

const ALPHA = "11111111-1111-4111-8111-111111111111";
const A = "a".repeat(64);
const B = "b".repeat(64);

describe("thread signals", () => {
  it("counts unread replies per thread, and unknown activity as none", () => {
    expect(
      unreadByThread([
        {
          channelId: ALPHA,
          items: [
            { channelId: ALPHA, rootId: A.toUpperCase(), unreadCount: 2 },
            { channelId: ALPHA, rootId: B, unreadCount: 0 },
          ],
        },
        { channelId: "other", items: null },
      ] as never),
    ).toEqual(new Map([[activityKey(ALPHA, A), 2]]));
  });

  it("finds agents working in threads, local work first, earliest start kept", () => {
    const working = workingByThread({
      status: "listening",
      turns: [
        // In a thread, counted.
        { agent: "relay", channelId: ALPHA, threadRootId: B, state: "working" },
        // Channel-level, ignored.
        { agent: "chan", channelId: ALPHA, state: "working" },
        // Local work decides this agent's state here.
        { agent: "local", channelId: ALPHA, threadRootId: B, state: "working" },
      ],
      typing: [
        {
          agent: "typer",
          channelId: ALPHA,
          threadRootId: A,
          startedAt: 500,
          working: true,
        },
      ],
      local: [
        {
          agent: "local",
          channelId: ALPHA,
          threadRootId: A,
          thread: true,
          state: "working",
          startedAt: 300,
        },
        {
          agent: "local",
          channelId: ALPHA,
          threadRootId: A,
          thread: true,
          state: "done",
          startedAt: 100,
        },
      ],
    } as never);
    expect(working).toEqual(
      new Map([
        [activityKey(ALPHA, A), { agents: ["local", "typer"], startedAt: 300 }],
        [activityKey(ALPHA, B), { agents: ["relay"] }],
      ]),
    );
  });
});

describe("sidebar badge", () => {
  it("shows nothing, an unread dot, or how many threads have agents working", async () => {
    const template = await titleRevision(ALPHA, A, { op: "create" }, "Plan");
    const state = {
      unread: [] as { rootId: string; unreadCount: number }[],
      local: [] as unknown[],
      listeners: new Set<() => void>(),
    };
    const listen = (listener: () => void) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    };
    const emit = () => {
      for (const listener of [...state.listeners]) listener();
    };
    const session = {
      snapshotRead: async () => [
        { ...template, id: "e1", pubkey: "", sig: "" },
      ],
      artifacts: { follow: () => () => {} },
      channels: {
        list: () => ({ status: "ready", channels: [{ id: ALPHA }] }),
        ensureList: () => {},
        subscribeList: () => () => {},
      },
      unread: {
        activity: (channelId: string) => ({
          channelId,
          items: state.unread.map((t) => ({ ...t, channelId })),
        }),
        subscribeActivity: (_: string, listener: () => void) =>
          listen(listener),
      },
      agentActivity: {
        snapshot: () => ({
          status: "listening",
          turns: [],
          typing: [],
          local: state.local,
        }),
        subscribe: listen,
      },
    } as unknown as RelaySession;
    const { container } = render(<SessionBadge session={session} />);
    expect(container).toBeEmptyDOMElement();
    act(() => {
      state.unread = [{ rootId: A, unreadCount: 1 }];
      emit();
    });
    expect(
      await screen.findByRole("img", { name: "1 unread named thread" }),
    ).toBeInTheDocument();
    act(() => {
      state.local = [
        {
          agent: "x",
          channelId: ALPHA,
          threadRootId: A,
          thread: true,
          state: "working",
          startedAt: 1,
        },
      ];
      emit();
    });
    expect(
      await screen.findByRole("img", {
        name: "Agents working in 1 named thread",
      }),
    ).toHaveTextContent("1");
    act(() => {
      state.unread = [];
      state.local = [];
      emit();
    });
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
