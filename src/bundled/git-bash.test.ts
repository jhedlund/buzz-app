import { execFile, execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { scriptOptions, windowsMachine } from "./git-bash";

const execFileAsync = promisify(execFile);
/** The bash Buzz runs: on Windows, Git for Windows' own, never WSL's. Its
 * exec path is `<git>/mingw64/libexec/git-core` (or `clangarm64/…`). */
const bash =
  process.platform === "win32"
    ? resolve(
        execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(),
        "../../../bin/bash.exe",
      )
    : "bash";

it("reads the machine from Git for Windows' uname only", () => {
  expect(windowsMachine("MINGW64_NT-10.0-26100 x86_64\n")).toBe("x86_64");
  expect(windowsMachine("MSYS_NT-10.0-26100 x86_64")).toBe("x86_64");
  expect(windowsMachine("MINGW64_NT-10.0-26100-ARM64 aarch64")).toBe("aarch64");
  expect(windowsMachine("Darwin arm64")).toBeUndefined();
  expect(windowsMachine("Linux x86_64")).toBeUndefined();
  expect(windowsMachine("")).toBeUndefined();
});

it("passes the script as bash's argument off Windows", () => {
  expect(
    scriptOptions("echo hi", "x.sh", ["run", "--version"], { cwd: "~" }, false),
  ).toEqual({ cwd: "~", args: ["echo hi", "x.sh", "run", "--version"] });
});

it("runs a script past Git for Windows' 8 KB argument limit with its arguments intact", async () => {
  // Padding past the limit, a check its programs don't inherit the script,
  // and every argument back.
  const script = [
    `# ${"x".repeat(16_000)}`,
    "sh -c '[ -z \"$BUZZ_SCRIPT\" ] && echo clean'",
    'printf "%s\\n" "$0" "$@"',
  ].join("\n");
  const options = scriptOptions(
    script,
    "x.sh",
    // Arguments as the launcher quotes them; the host's own quoting, which
    // keeps Git's runtime from expanding `*`, is tested natively.
    ["run", "two words", '{"a":"b"}', ""],
    { env: { KEPT: "1" } },
    true,
  );
  expect(options.env).toEqual({ KEPT: "1", BUZZ_SCRIPT: script });
  expect(options.args?.every((arg) => arg.length < 8_000)).toBe(true);
  const { stdout } = await execFileAsync(
    bash,
    ["-c", ...(options.args ?? [])],
    {
      env: { ...process.env, BUZZ_SCRIPT: options.env?.BUZZ_SCRIPT ?? "" },
      encoding: "utf8",
    },
  );
  expect(stdout.split("\n")).toEqual([
    "clean",
    "x.sh",
    "run",
    "two words",
    '{"a":"b"}',
    "",
    "",
  ]);
});
