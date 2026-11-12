import { expect, it } from "vitest";
import { MENTION_PROMPT } from "../../features/agent-harness/base-prompt";
import type { EventData } from "../../features/relay/events";
import { developerInstructions, turnInput } from "./prompt";

const event = {
  id: "1".repeat(64),
  pubkey: "a".repeat(64),
  kind: 9,
  created_at: 1_800_000_000,
  content: "@Codex what changed?",
  tags: [["h", "chan"]],
  sig: "",
} as EventData;
const conversation = { channelId: "chan", name: "general", root: event.id };

it("tells a turn a mention starts what it owes the mention, and a wake's turn nothing of the kind", () => {
  const asked = turnInput("agent", event, conversation, "what changed?");
  expect(asked).toContain(`${MENTION_PROMPT}\n<buzz-event>`);
  expect(
    turnInput("agent", event, conversation, "what changed?", true),
  ).toContain(MENTION_PROMPT);
  const woken = turnInput("agent", event, conversation, "", false, undefined, {
    type: "attention",
    channel: "chan",
    root: event.id,
    text: '<watch-task>\nThis turn was started by watch "w".\n</watch-task>',
    id: "w".repeat(64),
    at: 1_800_000_000_000,
  });
  expect(woken).not.toContain("<mention>");
  expect(woken).not.toContain("MUST reply");
  // What a mention is owed is no longer in every turn's prompt.
  const instructions = developerInstructions({
    name: "Codex",
    pubkey: "b".repeat(64),
  });
  expect(instructions).not.toContain("MUST reply");
  expect(instructions).not.toContain("MUST publish");
});

it("asks the first agent a person names in a new top-level message to title it", () => {
  const ask = "call `thread_title` with `if_unset: true`";
  const agent = "c".repeat(64);
  const mention = (tags: string[][]) =>
    ({ ...event, tags: [["h", "chan"], ...tags] }) as EventData;
  const root = { channelId: "chan", name: "general" };
  expect(turnInput(agent, mention([["p", agent]]), root, "hi")).toContain(ask);
  expect(
    turnInput(
      agent,
      mention([
        ["p", "b".repeat(64)],
        ["p", agent],
      ]),
      root,
      "hi",
    ),
  ).not.toContain(ask);
  expect(
    turnInput(
      agent,
      mention([
        ["p", agent],
        ["e", "d".repeat(64), "", "reply"],
      ]),
      root,
      "hi",
    ),
  ).not.toContain(ask);
  expect(
    turnInput(
      agent,
      mention([["p", agent]]),
      { ...root, topLevel: true },
      "hi",
    ),
  ).not.toContain(ask);
});
