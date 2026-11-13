// Claude and Codex on Windows, where the host starts the `bash`, `uname` and
// other POSIX programs their manifests declare from Git for Windows.
import type { HostProcessOptions } from "../features/host/service";

/** Whether this desktop is Windows. */
export const onWindows = () => /^Win/i.test(navigator.platform);

/** The machine in Git for Windows' `uname -sm`: `MINGW64_NT-10.0-26100
 * x86_64`, or `MSYS_NT-…` when started outside its own bash. */
export const windowsMachine = (uname: string) =>
  /^(?:MINGW(?:32|64)|MSYS|CYGWIN)_NT-\S+ (\S+)$/.exec(uname.trim())?.[1];

/** Starts a step of a launch script under `bash -c`. Git for Windows' bash
 * cuts any one argument at 8 KB, so there the script waits in the
 * environment, cleared before it runs so its programs don't inherit it;
 * `$0` and the step's arguments are the same either way. */
export function scriptOptions(
  script: string,
  name: string,
  args: readonly string[],
  options: HostProcessOptions | undefined,
  windows: boolean,
): HostProcessOptions {
  if (!windows) return { ...options, args: [script, name, ...args] };
  return {
    ...options,
    args: [
      'buzz_script=$BUZZ_SCRIPT; unset BUZZ_SCRIPT; eval "$buzz_script"',
      name,
      ...args,
    ],
    env: { ...options?.env, BUZZ_SCRIPT: script },
  };
}

/** Git's `pwd` prints `/c/Users/me`; its bash's `pwd -W` prints the folder
 * as Windows names it, `C:/Users/me`, which is what Claude and Codex use. */
export const WINDOWS_PWD = "pwd -W";
