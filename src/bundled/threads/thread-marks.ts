// Pinned and done threads: personal triage flags, never shared thread data.
// Each is one private record per account (kind 30078, `d` = thread-pins or
// thread-done), in the shape Buzz 0.x reads and writes (threadPins.ts and
// threadDone.ts on its feat/thread-done branch), so both apps and every
// device agree. Each change reads the latest record, changes one root and
// writes it back, so no local copy needs merging. Turning a mark off keeps a
// tombstone, so 0.x's per-root last-writer-wins merge cannot bring it back.
import type { ThreadMarkCoordinate } from "../../features/relay/transport";

export type MarkKind = "pins" | "done";
export const MARK_COORDINATE: Record<MarkKind, ThreadMarkCoordinate> = {
  pins: "thread-pins",
  done: "thread-done",
};
const FLAG = { pins: "pinned", done: "done" } as const;
/** Roots kept, marks and tombstones together. */
export const MAX_MARKS = 500;
const MAX_ACTIVITY_IDS = 50;
const ROOT = /^[0-9a-f]{64}$/;

export type Mark = Readonly<{
  on: boolean;
  /** Milliseconds. */
  updatedAt: number;
  /** Done only: the thread's latest activity (seconds) when 0.x marked it. */
  activityAt?: number;
  activityIds?: readonly string[];
}>;
export type Marks = ReadonlyMap<string, Mark>;

const time = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** The record's marks; no record is none. Throws on a record that isn't one,
 * so a write never replaces what it can't read. Entries 0.x would drop are
 * dropped here too. */
export function parseMarks(kind: MarkKind, value: unknown): Marks {
  if (value === undefined) return new Map();
  const record = value as { version?: unknown; roots?: unknown } | null;
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    record.version !== 1 ||
    !record.roots ||
    typeof record.roots !== "object" ||
    Array.isArray(record.roots)
  )
    throw new Error("Your saved thread marks couldn't be read");
  const marks = new Map<string, Mark>();
  for (const [root, raw] of Object.entries(record.roots)) {
    const entry = raw as Record<string, unknown> | null;
    const on = entry?.[FLAG[kind]];
    if (
      !ROOT.test(root) ||
      !entry ||
      typeof entry !== "object" ||
      typeof on !== "boolean" ||
      !time(entry.updatedAt)
    )
      continue;
    const ids = entry.activityIds;
    const frontier =
      kind === "done" &&
      time(entry.activityAt) &&
      (ids === undefined ||
        (Array.isArray(ids) &&
          ids.length <= MAX_ACTIVITY_IDS &&
          ids.every((id) => typeof id === "string")));
    if (kind === "done" && entry.activityAt !== undefined && !frontier)
      continue;
    marks.set(root, {
      on,
      updatedAt: entry.updatedAt,
      ...(frontier && {
        activityAt: entry.activityAt as number,
        ...(ids !== undefined && { activityIds: ids as string[] }),
      }),
    });
  }
  return marks;
}

export function encodeMarks(kind: MarkKind, marks: Marks) {
  return {
    version: 1,
    roots: Object.fromEntries(
      [...marks].map(([root, { on, ...rest }]) => [
        root,
        { [FLAG[kind]]: on, ...rest },
      ]),
    ),
  };
}

/** Sets one root's mark, stamped strictly after its last write so a clock
 * that stepped back still wins the merge, then bounds the record: tombstones
 * go first, then the oldest marks. A done mark set here carries no activity
 * frontier, so every app compares the thread's activity with `updatedAt`. */
export function setMark(
  marks: Marks,
  rootId: string,
  on: boolean,
  nowMs: number,
): Marks {
  const root = rootId.toLowerCase();
  const updatedAt = Math.max(nowMs, (marks.get(root)?.updatedAt ?? 0) + 1);
  const next = new Map(marks).set(root, { on, updatedAt });
  if (next.size <= MAX_MARKS) return next;
  return new Map(
    [...next]
      .sort(
        ([, a], [, b]) =>
          Number(b.on) - Number(a.on) || b.updatedAt - a.updatedAt,
      )
      .slice(0, MAX_MARKS),
  );
}

/** Roots marked on. */
export const markedRoots = (marks: Marks) =>
  new Set([...marks].filter(([, mark]) => mark.on).map(([root]) => root));

/** Done only while nothing has happened since it was marked, by Buzz 0.x's
 * rule: with a frontier, activity in a later second, or a reply in its second
 * that the frontier doesn't list, reopens it; without one, activity after the
 * mark does. `ids` are the replies in the thread's `activeAt` second. */
export function isDone(
  mark: Mark | undefined,
  activeAt: number,
  ids: readonly string[] = [],
) {
  if (!mark?.on) return false;
  if (mark.activityAt === undefined) return activeAt * 1000 <= mark.updatedAt;
  const frontier = mark.activityIds ?? [];
  return (
    activeAt < mark.activityAt ||
    (activeAt === mark.activityAt && ids.every((id) => frontier.includes(id)))
  );
}
