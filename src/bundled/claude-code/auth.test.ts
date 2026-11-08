import { beforeEach, expect, it, vi } from "vitest";
import type { AgentStore } from "../../features/agents/store";
import type { HostProcessOptions } from "../../features/host/service";
import { ClaudeAuth } from "./auth";
import { ENV, type Spawn } from "./claude";

const KEY = "sk-ant-api03-saved";

/** Native's key store (`claude_key.rs`): whether a key is saved, the asks
 * and saves it took, and a refusal to answer the next save with. */
const state = vi.hoisted(() => ({
  saved: true,
  asked: 0,
  saves: [] as string[],
  refusals: [] as string[],
  /** Secure storage refuses to say whether a key is saved. */
  unreadable: false,
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: async (command: string, args?: { value: string }) => {
    if (command === "claude_api_key_status") {
      state.asked += 1;
      if (state.unreadable) throw "Secure storage is unavailable";
      return state.saved;
    }
    if (command !== "claude_api_key_set" || !args) return null;
    const refusal = state.refusals.shift();
    if (refusal) throw refusal;
    state.saves.push(args.value);
    state.saved = true;
    return null;
  },
}));
/** Starts with a key saved or not. */
function store(saved = true) {
  Object.assign(state, {
    saved,
    asked: 0,
    saves: [],
    refusals: [],
    unreadable: false,
  });
}
beforeEach(() => void store());

/** A host whose `claude.sh review` prints a review folder and whose
 * `claude auth status` reports `account`; every start is recorded. */
function host(
  account: { loggedIn: boolean; authMethod?: string; email?: string } = {
    loggedIn: false,
  },
) {
  const started: { id: string; options: HostProcessOptions | undefined }[] = [];
  const spawn: Spawn = async (id, options) => {
    started.push({ id, options });
    if (id === "review")
      queueMicrotask(() => options?.onStdout?.("/Users/me/review\n"));
    const status = options?.args?.join(" ") === "auth status --json";
    if (status)
      queueMicrotask(() => options.onStdout?.(JSON.stringify(account)));
    return {
      write: async () => undefined,
      // As native code does once the process exited, as a status soon is.
      end: async () => {
        if (status) throw new Error("No such process");
      },
      kill: async () => undefined,
      // As Claude does, signed out exits 1, having said so.
      exited: new Promise((resolve) =>
        setTimeout(() => resolve(status && !account.loggedIn ? 1 : 0), 0),
      ),
    };
  };
  return { spawn, started };
}

it("asks native code to start every claude, the protected release included, with the key", async () => {
  const { spawn, started } = host();
  const auth = new ClaudeAuth(spawn);
  const authorized = auth.authorize(spawn, true);
  for (const id of ["claude", "claude-protected-arm64"])
    await authorized(id, { args: ["--verbose"], env: { ...ENV, A: "1" } });
  await authorized("platform", { env: { ...ENV } });
  expect(started.map(({ id }) => id)).toEqual([
    "claude",
    "claude-protected-arm64",
    "platform",
  ]);
  for (const { options } of started.slice(0, 2)) {
    expect(options).toEqual({
      args: ["--verbose"],
      env: { ...ENV, A: "1" },
      secrets: ["anthropic-api-key"],
    });
    // The key itself never reaches the app.
    expect(JSON.stringify(options)).not.toContain("sk-ant-");
  }
  expect(started[2]?.options).toEqual({ env: { ...ENV } });
});

it("refuses a turn's claude without a key, but lets setup run its checks", async () => {
  const { spawn, started } = host();
  store(false);
  const auth = new ClaudeAuth(spawn);
  await expect(
    auth.authorize(spawn, true)("claude", { env: ENV }),
  ).rejects.toThrow("Claude needs an Anthropic API key.");
  // Only the look for an account it could use instead, which finds none.
  expect(started.map(({ options }) => options?.args)).toEqual([
    ["auth", "status", "--json"],
  ]);
  await auth.authorize(spawn)("claude", { args: ["--version"], env: ENV });
  expect(started.at(-1)).toEqual({
    id: "claude",
    options: {
      args: ["--version"],
      env: ENV,
      secrets: ["anthropic-api-key"],
    },
  });
});

it("asks again until a key is saved, then once until it is saved or checked", async () => {
  const { spawn } = host();
  store(false);
  const auth = new ClaudeAuth(spawn);
  await expect(auth.check()).resolves.toBeUndefined();
  // No key is not kept: another Buzz on this computer may save one.
  state.saved = true;
  await auth.authorize(spawn, true)("claude");
  expect(state.asked).toBe(2);
  // A key is kept until it is checked or saved.
  state.saved = false;
  await auth.authorize(spawn, true)("claude");
  expect(state.asked).toBe(2);
  await expect(auth.check()).resolves.toBeUndefined();
  state.saved = true;
  await expect(auth.check()).resolves.toEqual({});
  await auth.save(KEY);
  await auth.authorize(spawn, true)("claude");
  expect(state.asked).toBe(5);
});

it("saves the key with native code alone and tells listeners, but not of a refused one", async () => {
  const { spawn, started } = host();
  store(false);
  state.refusals.push("That is not an Anthropic API key.");
  const auth = new ClaudeAuth(spawn);
  const told = vi.fn();
  auth.subscribe(told);
  await expect(auth.save("nope")).rejects.toBe(
    "That is not an Anthropic API key.",
  );
  expect(told).not.toHaveBeenCalled();
  await expect(auth.save(KEY)).resolves.toBe("Saved the Anthropic API key.");
  expect(told).toHaveBeenCalledTimes(1);
  expect(state.saves).toEqual([KEY]);
  expect(started).toEqual([]);
  // A save stopped before it reaches the store saves nothing.
  const stopped = new AbortController();
  stopped.abort();
  await expect(auth.save(KEY, stopped.signal)).rejects.toThrow();
  expect(state.saves).toEqual([KEY]);
});

it("gives a review its own folder, the key coming from native code", async () => {
  const { spawn } = host();
  await expect(new ClaudeAuth(spawn).review()).resolves.toEqual({
    home: "/Users/me/review",
    env: {},
  });
  store(false);
  await expect(new ClaudeAuth(spawn).review()).rejects.toThrow(
    "Claude needs an Anthropic API key.",
  );
});

it("links a turn that failed for want of a working key to Settings", async () => {
  const auth = new ClaudeAuth(undefined);
  const settings = "buzz://settings?section=agents";
  const missing = await auth
    .authorize(async () => {
      throw new Error("unreachable");
    }, true)("claude")
    .then(
      () => "",
      (error: unknown) => String(error),
    );
  expect(auth.explainTurn(missing, settings)).toBe(
    `Claude is missing an API key. Head to [Settings](${settings}) to add one.`,
  );
  expect(
    auth.explainTurn("Invalid API key · Fix external API key", settings),
  ).toBe(
    `Anthropic rejected Claude's API key. It may have been revoked or run out of credit. Head to [Settings](${settings}) to replace it.`,
  );
  expect(auth.explainTurn("Error: overloaded", settings)).toBe(
    "Error: overloaded",
  );
});

/** Agent storage holding only what it is given. `stale` keeps this
 * program's copy from ever seeing it, as another program's writes. */
function storage(
  values = new Map<string, string>(),
  stale = false,
): AgentStore {
  return {
    keys: () => [...values.keys()],
    get: (key) => (stale ? null : (values.get(key) ?? null)),
    read: async (key) => values.get(key) ?? null,
    scan: async () => Object.fromEntries(values),
    set: async (key, value) => {
      if (value === null) values.delete(key);
      else values.set(key, value);
    },
    add: async (key, value) => values.get(key) ?? value,
  };
}

it("runs Claude on the account it signed in to when no key is saved, as before keys", async () => {
  const { spawn, started } = host({ loggedIn: true, email: "me@example.org" });
  store(false);
  const auth = new ClaudeAuth(spawn, storage());
  await expect(auth.check()).resolves.toEqual({ account: "me@example.org" });
  expect(auth.found.method).toBe("account");
  expect(auth.needs).toBe("is not signed in to a Claude account");
  // No key is asked for, and none is required.
  await auth.authorize(spawn, true)("claude", { env: ENV });
  expect(started.at(-1)).toEqual({ id: "claude", options: { env: ENV } });
  // A review's own Claude folder can't reach the account: it needs the key.
  await expect(auth.review()).rejects.toThrow(
    "Claude security reviews need an Anthropic API key, even when Claude runs with your Claude account.",
  );
  store(true);
  await auth.use("account");
  await auth.authorize(spawn)("claude-protected-arm64", {
    env: { ...ENV, CLAUDE_CONFIG_DIR: "/Users/me/review" },
  });
  expect(started.at(-1)?.options?.secrets).toEqual(["anthropic-api-key"]);
});

it("uses a saved key until the owner picks the account, and the key again once one is saved", async () => {
  const { spawn, started } = host({ loggedIn: true });
  const auth = new ClaudeAuth(spawn, storage());
  const told = vi.fn();
  auth.subscribe(told);
  // A key saved leads, and the account isn't asked about.
  await expect(auth.check()).resolves.toEqual({});
  expect(auth.found.method).toBe("api-key");
  expect(started).toEqual([]);
  await auth.use("account");
  expect(told).toHaveBeenCalledTimes(1);
  await expect(auth.check()).resolves.toEqual({});
  expect(auth.found).toMatchObject({ method: "account", key: true });
  await auth.authorize(spawn, true)("claude", { env: ENV });
  expect(started.at(-1)?.options?.secrets).toBeUndefined();
  await auth.save(KEY);
  expect(told).toHaveBeenCalledTimes(2);
  await expect(auth.check()).resolves.toEqual({});
  expect(auth.found.method).toBe("api-key");
});

it("signs in as setup's step, then uses the account, but not once cancelled", async () => {
  const { spawn } = host({ loggedIn: true });
  const auth = new ClaudeAuth(spawn, storage());
  const step = vi.fn(async () => undefined);
  await auth.signIn?.(step);
  expect(step.mock.calls).toEqual([["claude", ["auth", "login"], "Sign-in"]]);
  await auth.check();
  expect(auth.found.method).toBe("account");
  // A cancelled step throws, as setup's does, and the choice stays.
  const other = new ClaudeAuth(spawn, storage());
  await expect(
    other.signIn?.(async () => {
      throw new Error("Sign-in ended (stopped).");
    }),
  ).rejects.toThrow("stopped");
  await other.check();
  expect(other.found.method).toBe("api-key");
});

it("asks for a key, not a sign-in, when Claude has neither", async () => {
  const { spawn } = host();
  store(false);
  const auth = new ClaudeAuth(spawn, storage());
  await expect(auth.check()).resolves.toBeUndefined();
  expect(auth.found.method).toBe("api-key");
  await expect(
    auth.authorize(spawn, true)("claude", { env: ENV }),
  ).rejects.toThrow("Claude needs an Anthropic API key.");
});

it("links a turn whose account sign-in lapsed to Settings", () => {
  const settings = "buzz://settings?section=agents";
  expect(
    new ClaudeAuth(undefined).explainTurn(
      "Not logged in · Please run /login",
      settings,
    ),
  ).toBe(
    `Claude is not signed in to your Claude account. Head to [Settings](${settings}) to sign in.`,
  );
});

it("looks for the account before a first check, so an early turn isn't refused", async () => {
  const { spawn, started } = host({ loggedIn: true });
  store(false);
  const auth = new ClaudeAuth(spawn, storage());
  await auth.authorize(spawn, true)("claude", { env: ENV });
  expect(started.at(-1)).toEqual({ id: "claude", options: { env: ENV } });
  expect(auth.found.method).toBe("account");
});

it("takes an API key Claude holds, as from a helper, for no account", async () => {
  const { spawn } = host({ loggedIn: true, authMethod: "api_key_helper" });
  store(false);
  const auth = new ClaudeAuth(spawn, storage());
  await expect(auth.check()).resolves.toBeUndefined();
  expect(auth.found).toEqual({ method: "api-key", key: false });
});

it("uses another program's choice, saved after this one read its copy", async () => {
  const { spawn, started } = host({ loggedIn: true });
  const saved = new Map<string, string>();
  await new ClaudeAuth(spawn, storage(saved)).use("account");
  const other = new ClaudeAuth(spawn, storage(saved, true));
  await other.authorize(spawn, true)("claude", { env: ENV });
  expect(started.at(-1)?.options?.secrets).toBeUndefined();
});

it("checks again when a key is saved while a check is under way", async () => {
  let answer: (() => void) | undefined;
  const { spawn: base } = host({ loggedIn: false });
  // The account's status waits, as a slow `claude` would.
  const spawn: Spawn = async (id, options) => {
    if (options?.args?.[0] === "auth")
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
    return base(id, options);
  };
  store(false);
  const auth = new ClaudeAuth(spawn, storage());
  const checking = auth.check();
  await vi.waitFor(() => expect(answer).toBeDefined());
  await auth.save(KEY);
  answer?.();
  await expect(checking).resolves.toEqual({});
  expect(auth.found).toEqual({ method: "api-key", key: true });
});

it("finds an account signed in from a terminal after a check found none", async () => {
  const account = { loggedIn: false };
  const { spawn, started } = host(account);
  store(false);
  const auth = new ClaudeAuth(spawn, storage());
  await expect(auth.check()).resolves.toBeUndefined();
  account.loggedIn = true;
  await auth.authorize(spawn, true)("claude", { env: ENV });
  expect(started.at(-1)).toEqual({ id: "claude", options: { env: ENV } });
});

it("runs on the chosen account when secure storage can't be read, but not on the key", async () => {
  const { spawn } = host({ loggedIn: true, email: "me@example.org" });
  store(false);
  state.unreadable = true;
  const values = new Map<string, string>();
  const auth = new ClaudeAuth(spawn, storage(values));
  await expect(auth.check()).rejects.toThrow();
  await auth.use("account");
  await expect(auth.check()).resolves.toEqual({ account: "me@example.org" });
});

it("offers the saved key once the account's sign-in lapses", async () => {
  const account = { loggedIn: true };
  const { spawn } = host(account);
  const auth = new ClaudeAuth(spawn, storage());
  await auth.use("account");
  account.loggedIn = false;
  await expect(auth.check()).resolves.toBeUndefined();
  expect(auth.found).toEqual({ method: "account", key: true });
});
