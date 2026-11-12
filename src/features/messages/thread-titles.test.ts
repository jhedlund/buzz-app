import { describe, expect, it, vi } from "vitest";
import { PublishRejected } from "../relay/outbox";
import type { ReadFilter, RelayEvent } from "../relay/events";
import type { RelayWriter } from "../relay/transport";
import {
  activityKey,
  normalizeTitle,
  parseTitle,
  planTitle,
  readActivity,
  readTitles,
  staleChannels,
  type ThreadTitle,
  threadTitleId,
  TitleConflict,
  titleRevision,
  noteReplies,
  writeTitle,
} from "./thread-titles";

// The 0.x SDK's test vector (`buzz_sdk::thread_title`, id_is_uuidv5_of_type_and_root_hex).
const ROOT = "a".repeat(64);
const ROOT_ID = "0d943738-f875-5089-91fe-135fe16d0f72";
const CHANNEL = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const event = (
  id: string,
  tags: string[][],
  content = "",
  created_at = 100,
): RelayEvent =>
  ({
    id,
    pubkey: "f".repeat(64),
    kind: 45010,
    created_at,
    content,
    tags,
    sig: "",
  }) as unknown as RelayEvent;
async function titleEvent(
  id: string,
  title: string,
  { root = ROOT, channel = CHANNEL, created_at = 100 } = {},
) {
  const template = await titleRevision(channel, root, { op: "create" }, title);
  return event(id, template.tags, title, created_at);
}

const reply = (id: string, channel: string, root: string, at: number) => ({
  ...event(
    id,
    [
      ["h", channel],
      ["e", root, "", "reply"],
    ],
    "",
    at,
  ),
  kind: 9,
});

describe("convention", () => {
  it("derives the same d as the SDK, whatever the root's case", async () => {
    expect(await threadTitleId(ROOT)).toBe(ROOT_ID);
    expect(await threadTitleId(ROOT.toUpperCase())).toBe(ROOT_ID);
  });

  it("trims titles, treats blank as clearing and bounds UTF-8 bytes", () => {
    expect(normalizeTitle("  Spaced  ")).toBe("Spaced");
    expect(normalizeTitle("   ")).toBeUndefined();
    expect(normalizeTitle("é".repeat(256))).toBe("é".repeat(256));
    expect(() => normalizeTitle("é".repeat(257))).toThrow("512 bytes");
  });

  it("plans the SDK's lifecycle", () => {
    const live = { id: "h", deleted: false, title: "x" };
    const gone = { id: "h", deleted: true };
    expect(planTitle(undefined, "x")).toEqual({ op: "create" });
    expect(planTitle(undefined)).toEqual({ op: "unchanged" });
    expect(planTitle(live, "x")).toEqual({ op: "unchanged" });
    expect(planTitle(live, "y")).toEqual({ op: "update", prev: "h" });
    expect(planTitle(live)).toEqual({ op: "delete", prev: "h" });
    expect(planTitle(gone, "y")).toEqual({ op: "restore", prev: "h" });
    expect(planTitle(gone)).toEqual({ op: "unchanged" });
  });

  it("builds revisions with the SDK's tags and content", async () => {
    const prev = "b".repeat(64);
    const base = [
      ["ar", "1"],
      ["d", ROOT_ID],
      ["h", CHANNEL],
      ["type", "buzz.thread-title"],
    ];
    const upper = ROOT.toUpperCase();
    expect(
      await titleRevision(CHANNEL, upper, { op: "create" }, "Release"),
    ).toMatchObject({
      kind: 45010,
      content: "Release",
      tags: [...base, ["op", "create"], ["root", ROOT], ["title", "Release"]],
    });
    for (const op of ["update", "restore"] as const)
      expect(
        await titleRevision(CHANNEL, ROOT, { op, prev }, "Renamed"),
      ).toMatchObject({
        content: "Renamed",
        tags: [
          ...base,
          ["op", op],
          ["root", ROOT],
          ["prev", prev],
          ["title", "Renamed"],
        ],
      });
    const cleared = await titleRevision(CHANNEL, ROOT, { op: "delete", prev });
    expect(cleared).toMatchObject({
      content: "",
      tags: [...base, ["op", "delete"], ["root", ROOT], ["prev", prev]],
    });
    await expect(
      titleRevision(CHANNEL, ROOT, { op: "update", prev }),
    ).rejects.toThrow("title is required");
    expect(parseTitle(event("x", cleared.tags))).toBeUndefined();
  });

  it("parses live titles only", async () => {
    expect(parseTitle(await titleEvent("e1", "Release", {}))).toEqual({
      title: "Release",
      channel: CHANNEL,
      root: ROOT,
      revision: "e1",
      updatedAt: 100,
    });
    expect(
      parseTitle(
        event("e2", [
          ["type", "buzz.task"],
          ["title", "x"],
          ["h", CHANNEL],
          ["root", ROOT],
        ]),
      ),
    ).toBeUndefined();
  });
});

describe("reads", () => {
  it("reads titles in batches of 100 channels, keeping only derived ids in asked channels", async () => {
    const channels = Array.from(
      { length: 101 },
      (_, i) => `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`,
    );
    const good = await titleEvent("e1", "Good", { channel: channels[0] });
    const forged = event(
      "e2",
      good.tags.map(([k, v]) =>
        k === "d" ? ["d", OTHER] : [k ?? "", v ?? ""],
      ),
      "Forged",
    );
    const elsewhere = await titleEvent("e3", "Elsewhere", {
      root: "c".repeat(64),
      channel: OTHER,
    });
    const read = vi.fn(async (filters: readonly ReadFilter[]) =>
      filters[0]?.["#h"]?.includes(channels[0] ?? "")
        ? [good, forged, elsewhere]
        : [],
    );
    const result = await readTitles(
      read,
      channels,
      new AbortController().signal,
    );
    expect(result).toEqual({
      titles: [expect.objectContaining({ title: "Good", revision: "e1" })],
      partial: false,
    });
    expect(read.mock.calls.map(([[filter]]) => filter)).toEqual([
      {
        kinds: [45010],
        "#h": channels.slice(0, 100),
        "#type": ["buzz.thread-title"],
        artifact: "current",
        limit: 500,
      },
      expect.objectContaining({ "#h": channels.slice(100) }),
    ]);
  });

  it("finds each root's newest reply per channel and survives a failed read", async () => {
    const other = "c".repeat(64);
    const titles = [
      { channel: CHANNEL, root: ROOT },
      { channel: OTHER, root: other },
    ] as ThreadTitle[];
    const read = vi.fn(async (filters: readonly ReadFilter[]) => {
      if (filters[0]?.["#h"]?.[0] === OTHER) throw new Error("offline");
      return [reply("r1", CHANNEL, ROOT, 300), reply("r2", CHANNEL, ROOT, 200)];
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const latest = await readActivity(
      { read },
      titles,
      new AbortController().signal,
    );
    expect([...latest]).toEqual([[activityKey(CHANNEL, ROOT), 300]]);
    expect(read.mock.calls[0]?.[0]).toEqual([
      { kinds: [9, 40002, 45003], "#e": [ROOT], "#h": [CHANNEL], limit: 500 },
    ]);
  });

  it("reads at most four channels at once, and one held read blocks none of the others", async () => {
    const channels = Array.from(
      { length: 6 },
      (_, i) => `${i}`.repeat(8) + "-1111-4111-8111-111111111111",
    );
    const titles = channels.map((channel) => ({ channel, root: ROOT }));
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inFlight = 0;
    let most = 0;
    const read = vi.fn(async (filters: readonly ReadFilter[]) => {
      const channel = filters[0]?.["#h"]?.[0] ?? "";
      inFlight++;
      most = Math.max(most, inFlight);
      try {
        if (channel === channels[0]) await held;
        await Promise.resolve();
        return [reply(`r${channel}`, channel, ROOT, 300)];
      } finally {
        inFlight--;
      }
    });
    const done = readActivity(
      { read },
      titles as ThreadTitle[],
      new AbortController().signal,
    );
    // Every other channel finishes while the first is held.
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(6));
    expect(most).toBe(4);
    release();
    expect((await done).size).toBe(6);
  });
});

describe("writes", () => {
  const current: ThreadTitle = {
    title: "Old",
    channel: CHANNEL,
    root: ROOT,
    revision: "e1",
    updatedAt: 100,
  };
  function fixture(head: RelayEvent | undefined, publish = vi.fn()) {
    const read = vi.fn(async () => (head ? [head] : []));
    const writer: RelayWriter = {
      sign: vi.fn(async (template) =>
        event("new", template.tags, template.content),
      ),
      publish,
    };
    return { read, writer, publish };
  }

  it("renames against the shown revision with a strong head read", async () => {
    const f = fixture(await titleEvent("e1", "Old"));
    const signal = new AbortController().signal;
    await expect(
      writeTitle(f.read, f.writer, current, "New", signal),
    ).resolves.toBe("new");
    expect(f.read).toHaveBeenCalledWith(
      [
        {
          kinds: [45010],
          "#h": [CHANNEL],
          "#d": [ROOT_ID],
          limit: 1,
          consistency: "strong",
        },
      ],
      { signal },
    );
    const [signed] = f.publish.mock.calls[0] ?? [];
    expect(signed.tags).toContainEqual(["op", "update"]);
    expect(signed.tags).toContainEqual(["prev", "e1"]);
  });

  it("clears with a delete and writes nothing when unchanged", async () => {
    const f = fixture(await titleEvent("e1", "Old"));
    const signal = new AbortController().signal;
    await expect(
      writeTitle(f.read, f.writer, current, undefined, signal),
    ).resolves.toBeUndefined();
    expect(f.publish.mock.calls[0]?.[0].tags).toContainEqual(["op", "delete"]);
    f.publish.mockClear();
    await expect(
      writeTitle(f.read, f.writer, current, "Old", signal),
    ).resolves.toBe("e1");
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("names an untitled thread with create, and a cleared one with restore", async () => {
    const signal = new AbortController().signal;
    const untitled = { channel: CHANNEL, root: ROOT };
    const fresh = fixture(undefined);
    await expect(
      writeTitle(fresh.read, fresh.writer, untitled, "New", signal),
    ).resolves.toBe("new");
    expect(fresh.publish.mock.calls[0]?.[0].tags).toContainEqual([
      "op",
      "create",
    ]);
    const deletion = await titleRevision(CHANNEL, ROOT, {
      op: "delete",
      prev: "e1",
    });
    const cleared = fixture(event("e2", deletion.tags));
    await expect(
      writeTitle(cleared.read, cleared.writer, untitled, "New", signal),
    ).resolves.toBe("new");
    const tags = cleared.publish.mock.calls[0]?.[0].tags;
    expect(tags).toContainEqual(["op", "restore"]);
    expect(tags).toContainEqual(["prev", "e2"]);
    // Expecting no title while one is live is a conflict.
    const taken = fixture(await titleEvent("e1", "Theirs"));
    await expect(
      writeTitle(taken.read, taken.writer, untitled, "New", signal),
    ).rejects.toBeInstanceOf(TitleConflict);
    expect(taken.publish).not.toHaveBeenCalled();
  });

  it("reports a conflict when the head moved or a CAS race is lost", async () => {
    const signal = new AbortController().signal;
    const moved = fixture(await titleEvent("e9", "Theirs"));
    await expect(
      writeTitle(moved.read, moved.writer, current, "New", signal),
    ).rejects.toBeInstanceOf(TitleConflict);
    expect(moved.publish).not.toHaveBeenCalled();
    await expect(
      writeTitle(fixture(undefined).read, moved.writer, current, "New", signal),
    ).rejects.toBeInstanceOf(TitleConflict);
    const lost = fixture(
      await titleEvent("e1", "Old"),
      vi.fn(async () => {
        throw new PublishRejected(
          "Rejected",
          "conflict: artifact head changed",
        );
      }),
    );
    await expect(
      writeTitle(lost.read, lost.writer, current, "New", signal),
    ).rejects.toBeInstanceOf(TitleConflict);
    const denied = fixture(
      await titleEvent("e1", "Old"),
      vi.fn(async () => {
        throw new PublishRejected("Rejected", "restricted: not a member");
      }),
    );
    await expect(
      writeTitle(denied.read, denied.writer, current, "New", signal),
    ).rejects.toThrow("restricted: not a member");
  });
});

describe("live updates", () => {
  it("marks only the channels of checked title revisions stale", async () => {
    const good = await titleEvent("e1", "Good");
    const forged = event(
      "e2",
      (await titleEvent("e2", "Forged", { channel: OTHER })).tags.map(
        ([k, v]) => (k === "d" ? ["d", "x"] : [k ?? "", v ?? ""]),
      ),
    );
    const elsewhere = await titleEvent("e3", "x", {
      channel: "33333333-3333-4333-8333-333333333333",
    });
    expect(
      await staleChannels([good, forged, elsewhere], new Set([CHANNEL, OTHER])),
    ).toEqual(new Set([CHANNEL]));
  });

  it("keeps the newest reply only for titled roots, in any order", () => {
    const joined = new Set([CHANNEL]);
    const key = activityKey(CHANNEL, ROOT);
    const titled = new Set([key]);
    const latest = new Map<string, number>();
    const parent = "d".repeat(64);
    // A reply naming its parent too: only the titled root is kept.
    const nested = {
      ...reply("r1", CHANNEL, ROOT, 300),
      tags: [
        ["h", CHANNEL],
        ["e", ROOT, "", "root"],
        ["e", parent, "", "reply"],
      ],
    };
    expect(
      noteReplies(
        [nested, reply("r2", CHANNEL, ROOT, 200)],
        joined,
        titled,
        latest,
      ),
    ).toBe(true);
    expect([...latest]).toEqual([[key, 300]]);
    // Older replies, untitled roots, other channels and other kinds change nothing.
    expect(
      noteReplies(
        [
          reply("r3", CHANNEL, ROOT, 100),
          reply("r4", CHANNEL, "b".repeat(64), 400),
          reply("r5", OTHER, ROOT, 400),
          { ...reply("r6", CHANNEL, ROOT, 500), kind: 7 },
        ],
        joined,
        titled,
        latest,
      ),
    ).toBe(false);
    expect([...latest]).toEqual([[key, 300]]);
  });
});
