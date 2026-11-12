import { expect, it } from "vitest";
import {
  isLargeTextPaste,
  LARGE_PASTE_MAX_CHARS,
  LARGE_PASTE_MAX_LINES,
  largePasteFile,
} from "./large-paste";

it("converts text past either limit, not at it", () => {
  expect(isLargeTextPaste("x".repeat(LARGE_PASTE_MAX_CHARS))).toBe(false);
  expect(isLargeTextPaste("x".repeat(LARGE_PASTE_MAX_CHARS + 1))).toBe(true);
  const lines = (count: number, eol = "\n") =>
    Array.from({ length: count }, (_, i) => `line ${i}`).join(eol);
  expect(isLargeTextPaste(lines(LARGE_PASTE_MAX_LINES))).toBe(false);
  expect(isLargeTextPaste(lines(LARGE_PASTE_MAX_LINES + 1))).toBe(true);
  // Windows clipboards end lines with CRLF; each still counts once.
  expect(isLargeTextPaste(lines(LARGE_PASTE_MAX_LINES, "\r\n"))).toBe(false);
  expect(isLargeTextPaste(lines(LARGE_PASTE_MAX_LINES + 1, "\r\n"))).toBe(true);
  expect(isLargeTextPaste("")).toBe(false);
});

it("names the file for the local paste time and keeps the text", async () => {
  const file = largePasteFile("log\nline", new Date(2026, 0, 5, 7, 8, 9));
  expect(file.name).toBe("pasted-text-2026-01-05-070809.txt");
  expect(file.type).toBe("text/plain");
  expect(await file.text()).toBe("log\nline");
});
