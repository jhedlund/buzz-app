// Shared thread titles: NIP-AR artifacts (kind 45010) in the thread's channel.
// Mirrors `buzz_sdk::thread_title` in Buzz 0.x, so titles set by the `buzz`
// CLI, agents and 0.x desktops show here and titles set here show there:
// - `type` = THREAD_TITLE_TYPE; `d` = UUIDv5(THREAD_TITLE_NAMESPACE,
//   "<type>:<lowercase root hex>"), so a thread has at most one title.
// - tags `h` = channel, `root` = thread root, `title`; `content` = the title.
// - Clearing is a soft `delete`; setting a cleared title is a `restore`.
import {
  ARTIFACT_KIND,
  artifactOp,
  deliver,
  readHead,
  type SnapshotRead,
  uuidv5,
} from "../agents/agent-config-artifacts";
import type { EventData, RelayEvent } from "../relay/events";
import type { RelaySession } from "../relay/session";
import type { RelayWriter } from "../relay/transport";

export const THREAD_TITLE_TYPE = "buzz.thread-title";
export const THREAD_TITLE_NAMESPACE = "2039f9bf-c754-483e-a7cf-56f1ec0e4abe";
export const MAX_THREAD_TITLE_BYTES = 512;
/** Channels or roots named by one read; the relay caps artifact predicates at 256. */
const BATCH = 100;
/** The session reader's page cap. */
const PAGE = 500;
/** Stream and forum reply kinds; edits and diffs are not new activity. */
const REPLY_KINDS = [9, 40002, 45003];

export const threadTitleId = (root: string) =>
  uuidv5(THREAD_TITLE_NAMESPACE, `${THREAD_TITLE_TYPE}:${root.toLowerCase()}`);

/** Trimmed title, or undefined when blank (clearing is its own operation). */
export function normalizeTitle(title: string) {
  const trimmed = title.trim();
  if (!trimmed) return undefined;
  if (new TextEncoder().encode(trimmed).length > MAX_THREAD_TITLE_BYTES)
    throw new Error(`Titles can be at most ${MAX_THREAD_TITLE_BYTES} bytes.`);
  return trimmed;
}

const tag = (event: EventData, name: string) =>
  event.tags.find((t) => t[0] === name)?.[1];

export type ThreadTitle = Readonly<{
  title: string;
  channel: string;
  root: string;
  /** Current revision id: the next write's `prev`. */
  revision: string;
  updatedAt: number;
}>;

/** A live title, or undefined for other types, deletions or malformed events. */
export function parseTitle(event: EventData): ThreadTitle | undefined {
  const [title, channel, root] = ["title", "h", "root"].map((t) =>
    tag(event, t),
  );
  if (
    event.kind !== ARTIFACT_KIND ||
    tag(event, "type") !== THREAD_TITLE_TYPE ||
    artifactOp(event) === "delete" ||
    !title ||
    !channel ||
    !root
  )
    return undefined;
  return {
    title,
    channel,
    root,
    revision: event.id,
    updatedAt: event.created_at,
  };
}

/** A title row with its newest activity: last reply or title revision. */
export type Row = ThreadTitle & Readonly<{ activeAt: number }>;
/** Activity is per channel and root, so a reply counts only in its channel. */
export const activityKey = (channel: string, root: string) =>
  `${channel} ${root}`;

/** Channels a live title revision may have changed: those of revisions
 * passing readTitles' checks. Only a fresh current read says what changed;
 * NIP-AR orders revisions by `prev`, not by time. */
export async function staleChannels(
  events: readonly EventData[],
  channels: ReadonlySet<string>,
) {
  const stale = new Set<string>();
  for (const event of events) {
    const root = tag(event, "root");
    const channel = tag(event, "h");
    if (
      event.kind === ARTIFACT_KIND &&
      tag(event, "type") === THREAD_TITLE_TYPE &&
      root &&
      channel &&
      channels.has(channel) &&
      tag(event, "d") === (await threadTitleId(root))
    )
      stale.add(channel);
  }
  return stale;
}

/** Records reply times in place: a root of a titled row (`titled`, keyed by
 * activityKey) keeps its newest reply in `latest`, and when given, the ids
 * of the replies in that second in `ids` (Buzz 0.x's activity frontier).
 * Order-independent. Returns whether a titled row's frontier changed. */
export function noteReplies(
  events: readonly EventData[],
  channels: ReadonlySet<string>,
  titled: ReadonlySet<string>,
  latest: Map<string, number>,
  ids?: Map<string, ReadonlySet<string>>,
) {
  let advanced = false;
  for (const event of events) {
    const channel = tag(event, "h");
    if (!REPLY_KINDS.includes(event.kind) || !channel || !channels.has(channel))
      continue;
    for (const [name, value] of event.tags) {
      if (name !== "e" || !value) continue;
      const key = activityKey(channel, value);
      const at = event.created_at;
      const was = latest.get(key) ?? 0;
      if (!titled.has(key) || at < was) continue;
      if (at > was) {
        latest.set(key, at);
        ids?.set(key, new Set([event.id]));
        advanced = true;
      } else if (ids && !ids.get(key)?.has(event.id)) {
        ids.set(key, new Set([...(ids.get(key) ?? []), event.id]));
        advanced = true;
      }
    }
  }
  return advanced;
}

export type Head = Readonly<{
  id: string;
  deleted: boolean;
  title?: string | undefined;
}>;
export type Plan =
  | Readonly<{ op: "create" }>
  | Readonly<{ op: "update" | "restore" | "delete"; prev: string }>
  | Readonly<{ op: "unchanged" }>;

/** What a write must do given the head; `desired` undefined clears. */
export function planTitle(head: Head | undefined, desired?: string): Plan {
  if (!head) return desired ? { op: "create" } : { op: "unchanged" };
  if (desired === undefined)
    return head.deleted ? { op: "unchanged" } : { op: "delete", prev: head.id };
  if (head.deleted) return { op: "restore", prev: head.id };
  return head.title === desired
    ? { op: "unchanged" }
    : { op: "update", prev: head.id };
}

/** The unsigned revision for `plan`, as `build_thread_title_revision` builds it. */
export async function titleRevision(
  channel: string,
  root: string,
  plan: Exclude<Plan, { op: "unchanged" }>,
  title?: string,
) {
  const lower = root.toLowerCase();
  if (plan.op !== "delete" && !title)
    throw new Error("A title is required for this operation");
  const text = plan.op === "delete" ? "" : (title ?? "");
  return {
    kind: ARTIFACT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: text,
    tags: [
      ["ar", "1"],
      ["d", await threadTitleId(lower)],
      ["h", channel],
      ["type", THREAD_TITLE_TYPE],
      ["op", plan.op],
      ["root", lower],
      ...("prev" in plan ? [["prev", plan.prev]] : []),
      ...(text ? [["title", text]] : []),
    ],
  };
}

/** Live titles in `channels`. A title counts only when its `d` is derived
 * from its root and its channel is one asked for. */
export async function readTitles(
  read: SnapshotRead,
  channels: readonly string[],
  signal: AbortSignal,
) {
  const titles: ThreadTitle[] = [];
  let partial = false;
  for (let at = 0; at < channels.length; at += BATCH) {
    const batch = channels.slice(at, at + BATCH);
    const events = await read(
      [
        {
          kinds: [ARTIFACT_KIND],
          "#h": batch,
          "#type": [THREAD_TITLE_TYPE],
          artifact: "current",
          limit: PAGE,
        },
      ],
      { signal },
    );
    partial ||= events.length >= PAGE;
    for (const event of events) {
      const title = parseTitle(event);
      if (
        title &&
        batch.includes(title.channel) &&
        tag(event, "d") === (await threadTitleId(title.root))
      )
        titles.push({ ...title, root: title.root.toLowerCase() });
    }
  }
  return { titles, partial };
}

/** Activity reads in flight at once. */
const ACTIVITY_CONCURRENCY = 4;

/** Newest reply per channel and root (see activityKey), read by `#e` on the
 * roots in each channel, ACTIVITY_CONCURRENCY reads at a time. Activity only
 * refines the order: a failed read leaves those roots at their title time. */
export async function readActivity(
  session: Pick<RelaySession, "read">,
  titles: readonly ThreadTitle[],
  signal: AbortSignal,
  /** Filled with each root's newest-second reply ids, when given. */
  ids?: Map<string, ReadonlySet<string>>,
) {
  const latest = new Map<string, number>();
  const roots = new Map<string, string[]>();
  for (const { channel, root } of titles)
    roots.set(channel, [...(roots.get(channel) ?? []), root]);
  const batches: [string, string[]][] = [];
  for (const [channel, all] of roots)
    for (let at = 0; at < all.length; at += BATCH)
      batches.push([channel, all.slice(at, at + BATCH)]);
  const next = async (): Promise<void> => {
    const item = batches.shift();
    if (!item) return;
    const [channel, batch] = item;
    try {
      const replies = await session.read(
        [{ kinds: REPLY_KINDS, "#e": batch, "#h": [channel], limit: PAGE }],
        { signal },
      );
      noteReplies(
        replies,
        new Set([channel]),
        new Set(batch.map((root) => activityKey(channel, root))),
        latest,
        ids,
      );
    } catch (error) {
      signal.throwIfAborted();
      console.warn("Thread activity read failed", error);
    }
    return next();
  };
  await Promise.all(Array.from({ length: ACTIVITY_CONCURRENCY }, next));
  return latest;
}

export class TitleConflict extends Error {
  constructor() {
    super(
      "Someone else changed this thread's title. Refresh to see the current one.",
    );
  }
}

/** Where a write goes and the live revision the writer last saw: undefined
 * when the thread had no title. */
export type TitleTarget = Readonly<{
  channel: string;
  root: string;
  revision?: string | undefined;
}>;

/** Names (`desired`) or clears (undefined) a thread's title, provided its
 * live head is still `expected.revision`. A lost race is a conflict, never
 * retried: with an expected revision, a retry could only find the same
 * change. Resolves to the new live revision, or undefined once cleared. */
export async function writeTitle(
  read: SnapshotRead,
  writer: RelayWriter,
  expected: TitleTarget,
  desired: string | undefined,
  signal: AbortSignal,
) {
  const event = await readHead(
    read,
    expected.channel,
    await threadTitleId(expected.root),
    signal,
  );
  const head = event && {
    id: event.id,
    deleted: artifactOp(event) === "delete",
    title: tag(event, "title"),
  };
  const live = head && !head.deleted ? head.id : undefined;
  if (live !== expected.revision) throw new TitleConflict();
  const plan = planTitle(head, desired);
  if (plan.op === "unchanged") return live;
  const signed: RelayEvent = await writer.sign(
    await titleRevision(expected.channel, expected.root, plan, desired),
    signal,
  );
  const delivery = await deliver(writer, signed, signal);
  if (delivery.status === "refused") {
    if (
      /artifact head changed|artifact identity is taken/.test(delivery.message)
    )
      throw new TitleConflict();
    throw new Error(delivery.message);
  }
  if (delivery.status === "uncertain")
    throw new Error(
      `The title may not have saved (${delivery.message}). Refresh to check.`,
    );
  return desired === undefined ? undefined : signed.id;
}
