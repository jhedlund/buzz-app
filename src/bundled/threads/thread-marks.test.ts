import { describe, expect, it } from "vitest";
import {
  encodeMarks,
  isDone,
  MAX_MARKS,
  markedRoots,
  parseMarks,
  setMark,
} from "./thread-marks";

const A = "a".repeat(64);
const B = "b".repeat(64);

describe("thread marks", () => {
  it("reads 0.x records, dropping the entries 0.x drops", () => {
    const pins = parseMarks("pins", {
      version: 1,
      roots: {
        [A]: { pinned: true, updatedAt: 1_794_000_000_000 },
        [B]: { pinned: false, updatedAt: 5 },
        [A.toUpperCase()]: { pinned: true, updatedAt: 1 },
        ["c".repeat(64)]: { pinned: "yes", updatedAt: 1 },
        ["d".repeat(64)]: { pinned: true, updatedAt: -1 },
      },
    });
    expect([...pins.keys()]).toEqual([A, B]);
    expect(markedRoots(pins)).toEqual(new Set([A]));
    const done = parseMarks("done", {
      version: 1,
      roots: {
        [A]: { done: true, updatedAt: 9, activityAt: 100, activityIds: [B] },
        [B]: { done: true, updatedAt: 9, activityAt: 100, activityIds: [1] },
      },
    });
    expect(done.get(A)).toEqual({
      on: true,
      updatedAt: 9,
      activityAt: 100,
      activityIds: [B],
    });
    expect(done.has(B)).toBe(false);
  });

  it("treats no record as none and refuses a record it can't read", () => {
    expect(parseMarks("pins", undefined).size).toBe(0);
    for (const bad of [
      null,
      "x",
      [],
      { version: 2, roots: {} },
      { version: 1 },
      { version: 1, roots: [] },
    ])
      expect(() => parseMarks("done", bad)).toThrow();
  });

  it("writes the shape 0.x reads, keeping other roots' frontiers", () => {
    const done = parseMarks("done", {
      version: 1,
      roots: { [A]: { done: true, updatedAt: 9, activityAt: 100 } },
    });
    expect(
      encodeMarks("done", setMark(done, B.toUpperCase(), true, 50)),
    ).toEqual({
      version: 1,
      roots: {
        [A]: { done: true, updatedAt: 9, activityAt: 100 },
        [B]: { done: true, updatedAt: 50 },
      },
    });
  });

  it("stamps a change after the previous one even when the clock went back", () => {
    const marks = setMark(new Map(), A, true, 1000);
    expect(setMark(marks, A, false, 10).get(A)).toEqual({
      on: false,
      updatedAt: 1001,
    });
  });

  it("keeps at most 500 roots, dropping tombstones before marks", () => {
    let marks = new Map(
      Array.from({ length: MAX_MARKS }, (_, i) => [
        i.toString(16).padStart(64, "0"),
        { on: i !== 7, updatedAt: 1000 + i },
      ]),
    );
    marks = new Map(setMark(marks, A, true, 1));
    expect(marks.size).toBe(MAX_MARKS);
    expect(marks.has((7).toString(16).padStart(64, "0"))).toBe(false);
    expect(marks.get(A)?.on).toBe(true);
  });

  it("reopens a done thread on later activity", () => {
    // Marked here: compared with the mark's time.
    expect(isDone({ on: true, updatedAt: 100_000 }, 100)).toBe(true);
    expect(isDone({ on: true, updatedAt: 100_000 }, 101)).toBe(false);
    // Marked by 0.x with a frontier: compared with that second.
    const frontier = { on: true, updatedAt: 1, activityAt: 100 };
    expect(isDone(frontier, 100)).toBe(true);
    expect(isDone(frontier, 101)).toBe(false);
    expect(isDone({ on: false, updatedAt: 1 }, 0)).toBe(false);
    expect(isDone(undefined, 0)).toBe(false);
  });
});
