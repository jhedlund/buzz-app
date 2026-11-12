/**
 * Plain-text pastes past either limit become a `.txt` attachment instead of
 * message text. Both sit below the composer's 16,000-character cap; they mark
 * where a draft stops being readable, not where sending fails.
 */
export const LARGE_PASTE_MAX_CHARS = 10_000;
export const LARGE_PASTE_MAX_LINES = 200;

export function isLargeTextPaste(text: string): boolean {
  return (
    text.length > LARGE_PASTE_MAX_CHARS ||
    text.split("\n").length > LARGE_PASTE_MAX_LINES
  );
}

const pad = (value: number) => String(value).padStart(2, "0");

/** The text as `pasted-text-YYYY-MM-DD-HHMMSS.txt`, named in local time. */
export function largePasteFile(text: string, date: Date): File {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return new File([text], `pasted-text-${day}-${time}.txt`, {
    type: "text/plain",
  });
}
