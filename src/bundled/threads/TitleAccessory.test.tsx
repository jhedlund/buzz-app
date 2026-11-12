// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ComposerAccessoryProps } from "../../features/conversation/contracts";
import { titleRevision } from "../../features/messages/thread-titles";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { TitleAccessory } from "./TitleAccessory";

afterEach(cleanup);

const ALPHA = "11111111-1111-4111-8111-111111111111";
const ROOT = "a".repeat(64);

async function session() {
  const template = await titleRevision(
    ALPHA,
    ROOT,
    { op: "create" },
    "Launch plan",
  );
  return {
    snapshotRead: async () => [{ ...template, id: "e1", pubkey: "", sig: "" }],
    artifacts: { follow: () => () => {} },
    channels: {
      list: () => ({ status: "ready", channels: [{ id: ALPHA }] }),
      ensureList: () => () => {},
      subscribeList: () => () => {},
    },
  } as unknown as RelaySession;
}

const props = (
  s: RelaySession,
  message: Partial<ChannelMessage>,
  openThread?: () => boolean,
) =>
  ({
    session: s,
    scope: "scope",
    channelId: ALPHA,
    message: { id: ROOT, channelId: ALPHA, ...message } as ChannelMessage,
    openThread,
    canOpen: () => false,
    open: () => false,
  }) satisfies ComposerAccessoryProps;

it("shows a thread root's title and opens the thread", async () => {
  const s = await session();
  const openThread = vi.fn(() => true);
  render(<TitleAccessory {...props(s, {}, openThread)} />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Open thread: Launch plan" }),
  );
  expect(openThread).toHaveBeenCalledOnce();
});

it("shows nothing on replies, untitled roots or where the thread can't open", async () => {
  const s = await session();
  const open = () => true;
  const { rerender } = render(<TitleAccessory {...props(s, {}, open)} />);
  // Loaded: the titled root that can open shows it.
  await screen.findByRole("button", { name: "Open thread: Launch plan" });
  for (const message of [
    { threadRootId: "b".repeat(64) },
    { id: "c".repeat(64) },
  ]) {
    rerender(<TitleAccessory {...props(s, message, open)} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  }
  rerender(<TitleAccessory {...props(s, {})} />);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  // A root that names itself as its thread root is still the root.
  rerender(<TitleAccessory {...props(s, { threadRootId: ROOT }, open)} />);
  expect(screen.getByRole("button")).toHaveTextContent("Launch plan");
});
