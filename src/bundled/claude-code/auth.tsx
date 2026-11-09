// How Buzz's Claude authenticates, as the owner chooses: with an Anthropic
// API key, pasted in setup and kept by native code in the OS credential store
// (`claude_key.rs`), which gives it to every `claude` as `ANTHROPIC_API_KEY`,
// never as an argument, and never back to the app; or with the Claude account
// (a subscription) that `claude auth login` signs in to, which Claude keeps
// itself.
//
// Builds can replace this one file with another way to sign in, so the rest
// of the plugin reaches authentication only through its exports: keep their
// names and shapes when changing it.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import inlineStyles from "../../shared/InlineReference.module.css";
import type { AgentStore } from "../../features/agents/store";
import { ENV, type Spawn } from "./claude";
import type { ClaudeSetup } from "./setup";

const NO_KEY =
  "Claude needs an Anthropic API key. Add one in Settings → Agent setup → Harness defaults → Claude → Edit configuration.";
const NO_REVIEW_KEY =
  "Claude security reviews need an Anthropic API key, even when Claude runs with your Claude account. Add one in Settings → Agent setup → Harness defaults → Claude → Edit configuration.";
/** What setup says first: this is one for all of Claude, not per agent. */
const KEY_ONCE =
  "Sign in with your Claude account (Pro, Max, Team or Enterprise), or create an API key at console.anthropic.com and paste it below. You only have to set this up once, and Buzz keeps the key securely on this computer.";
const REJECTED_KEY =
  "Anthropic rejected the Claude API key. It may have been revoked or run out of credit. Paste a working key in Settings → Agent setup → Harness defaults → Claude → Edit configuration.";

/** Runs one process as a setup step, its output shown; throws unless it
 * succeeds. */
export type Step = (
  id: string,
  args: readonly string[],
  label: string,
) => Promise<void>;
type Env = Readonly<Record<string, string | null>>;
/** The two ways Claude can authenticate. */
export type Method = "api-key" | "account";
/** The owner's choice, in agent storage, which every program running this
 * computer's agents shares. */
const METHOD_KEY = "buzz.claude-code.auth-method.v1";
const isMethod = (value: unknown): value is Method =>
  value === "api-key" || value === "account";

/** Runs a `claude.sh` step; its output, or throws what it printed. */
async function output(spawn: Spawn, id: string) {
  let stdout = "";
  let stderr = "";
  const process = await spawn(id, {
    onStdout: (text) => {
      stdout += text;
    },
    onStderr: (text) => {
      stderr += text;
    },
  });
  await process.end();
  const code = await process.exited;
  if (code !== 0)
    throw new Error(stderr.trim() || `${id} ended (${code ?? "stopped"}).`);
  return stdout;
}

/** The key's native store (`claude_key.rs`): the OS credential store,
 * which hands the key to the Claude processes that ask for it. Nothing
 * here reads it back; native code relies on that, as it gives the key to
 * `claude-sh`, which runs whatever script it is given. */
const nativeStore = ():
  | Readonly<{
      /** Whether a key is saved. */
      status(): Promise<boolean>;
      /** Saves the key; it is never read back. */
      save(key: string): Promise<void>;
    }>
  | undefined =>
  isTauri()
    ? {
        status: async () => (await invoke("claude_api_key_status")) === true,
        save: (value) => invoke("claude_api_key_set", { value }),
      }
    : undefined;

/** Whether Claude leads the Harness list and is new agents' default
 * (`src/bundled/index.ts`). Not here: Claude asks for an API key before its
 * first agent, so Codex leads. A build whose Claude signs in without that
 * friction can put it first. */
export const leadsHarnesses = false;

/** Claude's credentials on this computer. */
export class ClaudeAuth {
  /** Which ways this build authenticates. */
  readonly id = "buzz-claude-auth:api-key+account";
  /** What the last check found: the way in use, whether a key is saved, and
   * the Claude account signed in, when it asked. */
  found: Readonly<{
    method: Method;
    key: boolean;
    account?: Readonly<{ label: string }>;
  }> = { method: "api-key", key: false };
  private saved: Promise<boolean> | undefined;
  private readonly listeners = new Set<() => void>();
  /** The choice, without agent storage. */
  private picked: Method | undefined;
  /** Counts choices made, so a check under way when one is made looks again. */
  private changes = 0;

  private readonly store;

  constructor(
    private readonly spawn: Spawn | undefined,
    private readonly storage?: AgentStore,
  ) {
    this.store = spawn ? nativeStore() : undefined;
  }

  /** What the agent type's row asks for while Claude cannot run. It names
   * the "Sign in" or "Add key" button beside Harness, so it follows `signIn`. */
  get attentionLabel() {
    return this.signIn ? "Sign in to Claude" : "Add Claude API key";
  }
  /** Ends "Claude 2.1.0 …" while Claude cannot run. */
  get needs() {
    return this.found.method === "account"
      ? "is not signed in to a Claude account"
      : "needs an Anthropic API key";
  }

  /** Signs in to the Claude account as setup's step, which setup can
   * cancel, and uses it from then on. */
  readonly signIn: ((step: Step) => Promise<void>) | undefined = async (
    step,
  ) => {
    await step("claude", ["auth", "login"], "Sign-in");
    await this.use("account");
  };

  /** Uses `method` for every `claude` started from now on. */
  async use(method: Method) {
    if (this.storage) await this.storage.set(METHOD_KEY, method);
    else this.picked = method;
    this.changes++;
    this.found = { ...this.found, method };
    for (const listener of this.listeners) listener();
  }

  /** The way the owner chose, if they have, as saved: another program on
   * this computer may have chosen since this one read it. */
  private async chosen() {
    const chosen = this.storage
      ? await this.storage.read(METHOD_KEY)
      : this.picked;
    return isMethod(chosen) ? chosen : undefined;
  }

  /** The way chosen, or, until one is, the key when one is saved, and
   * otherwise the account, once a check finds Claude signed in to one. Until
   * then each asks again: setup may not have checked yet, or the person may
   * have signed in from a terminal since. */
  private async method(): Promise<Method> {
    const chosen = await this.chosen();
    if (chosen) return chosen;
    if (await this.has()) return "api-key";
    if (!this.found.account) await this.check();
    return this.found.method;
  }

  /** The Claude account (a subscription) Claude is signed in to, or
   * undefined. Signed out, `claude auth status` exits 1 and says so; an API
   * key Claude holds, as from an `apiKeyHelper`, is not an account. */
  private async account(): Promise<{ label: string } | undefined> {
    const spawn = this.spawn;
    if (!spawn) return undefined;
    let stdout = "";
    try {
      const process = await spawn("claude", {
        args: ["auth", "status", "--json"],
        env: ENV,
        onStdout: (text) => {
          stdout += text;
        },
      });
      // Not `end()`: it rejects once the process has already exited.
      const timer = setTimeout(() => void process.kill(), 15_000);
      await process.exited;
      clearTimeout(timer);
      const status = JSON.parse(stdout) as {
        loggedIn?: boolean;
        authMethod?: string;
        email?: string;
        orgName?: string;
      };
      if (!status.loggedIn || /api.?key/i.test(status.authMethod ?? ""))
        return undefined;
      // A personal account's organization is "<email>'s Organization".
      const personal = status.email && status.orgName?.includes(status.email);
      return {
        label: [status.email, !personal && status.orgName]
          .filter(Boolean)
          .join(" · "),
      };
    } catch {
      return undefined;
    }
  }

  /** Told when the credentials change, so running sessions start again. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Whether a key is saved, asked once until it is saved again or checked;
   * no key is asked again each time. */
  private has() {
    const store = this.store;
    if (!store) return Promise.resolve(false);
    if (this.saved) return this.saved;
    const asking = store.status();
    this.saved = asking;
    // Only a saved key is kept: another Buzz on this computer may save one.
    const forget = () => {
      if (this.saved === asking) this.saved = undefined;
    };
    asking.then((saved) => saved || forget(), forget);
    return asking;
  }

  /** Whether Claude can run turns the chosen way: an account to show, or
   * undefined. */
  async check(): Promise<Readonly<{ account?: string }> | undefined> {
    for (;;) {
      const changes = this.changes;
      this.saved = undefined;
      const chosen = await this.chosen();
      // The account doesn't need the key store, so a refused one can't stop it.
      const key = await this.has().catch((error: unknown) => {
        if (chosen === "account") return false;
        throw error;
      });
      // The account matters only when Claude may use it: chosen, or, until
      // the owner chooses, when no key is saved, as Claude ran before keys.
      const account =
        chosen === "account" || (!chosen && !key)
          ? await this.account()
          : undefined;
      // A choice made meanwhile, such as a key saved, outdates all this.
      if (changes !== this.changes) continue;
      const method = chosen ?? (account ? "account" : "api-key");
      this.found = { method, key, ...(account && { account }) };
      if (method === "api-key") return key ? {} : undefined;
      if (!account) return undefined;
      return account.label ? { account: account.label } : {};
    }
  }

  /** Saves `key` for every `claude` started from now on; what to say. A
   * save can't be stopped once it reaches the store, so `signal` only
   * stops one that hasn't. */
  async save(key: string, signal?: AbortSignal) {
    const store = this.store;
    if (!store) throw new Error("Claude runs only in the desktop app");
    signal?.throwIfAborted();
    try {
      await store.save(key);
    } finally {
      // A refused save leaves the key as it was; anything else may not.
      this.saved = undefined;
    }
    // A key saved is the one to use.
    await this.use("api-key");
    return "Saved the Anthropic API key.";
  }

  /** `spawn`, starting each `claude` the chosen way: with the saved key,
   * which native code sets itself, or with the account Claude signed in to.
   * One with its own Claude folder (a review's) can't reach that account, so
   * it always gets the key. `required` refuses to start one meant to use a
   * key without one, so no such turn falls back on an account sign-in that
   * `~/.claude` may hold. */
  authorize(spawn: Spawn, required = false): Spawn {
    return async (id, options) => {
      // Buzz's copy, and the protected release (`claude-protected-*`).
      if (id !== "claude" && !id.startsWith("claude-protected-"))
        return spawn(id, options);
      if (
        options?.env?.CLAUDE_CONFIG_DIR == null &&
        (await this.method()) === "account"
      )
        return spawn(id, options);
      if (required && !(await this.has())) throw new Error(NO_KEY);
      return spawn(id, {
        ...options,
        secrets: [...(options?.secrets ?? []), "anthropic-api-key"],
      });
    };
  }

  /** Security reviews' own Claude folder (absolute), which contained agents
   * cannot write, and what they authenticate with: the key, which
   * `authorize` asks native code for. */
  async review(): Promise<Readonly<{ home: string; env: Env }>> {
    const spawn = this.spawn;
    if (!spawn) throw new Error("Claude reviews need the desktop app");
    if (!(await this.has()))
      throw new Error(this.found.method === "account" ? NO_REVIEW_KEY : NO_KEY);
    const home = (await output(spawn, "review")).trim();
    if (!home.startsWith("/"))
      throw new Error("Claude's review folder is unreadable");
    return { home, env: {} };
  }

  /** A failed review's error, as the person can act on it. */
  explain(error: string) {
    return rejected(error) ? REJECTED_KEY : error;
  }

  /** A failed turn's error as its report in the conversation says it, in
   * Markdown: a missing or rejected key, or a lapsed sign-in, links to
   * `settings`, where it is fixed once for every Claude agent. */
  explainTurn(error: string, settings: string) {
    if (error.includes(NO_KEY))
      return `Claude is missing an API key. Head to [Settings](${settings}) to add one.`;
    if (signedOut(error))
      return `Claude is not signed in to your Claude account. Head to [Settings](${settings}) to sign in.`;
    return rejected(error)
      ? `Anthropic rejected Claude's API key. It may have been revoked or run out of credit. Head to [Settings](${settings}) to replace it.`
      : error;
  }
}

/** Whether a turn's error is Buzz's own refusal to start Claude without a
 * key, rather than anything Claude said. */
export const refusedByBuzz = (error: string) => error.includes(NO_KEY);

/** Whether Claude's error says Anthropic refused the key; turns end with
 * "Invalid API key · Fix external API key". */
const rejected = (error: string) =>
  /authentication_error|invalid x-api-key|invalid api key/i.test(error);
/** Whether Claude's error says the account sign-in is missing or lapsed:
 * "Not logged in · Please run /login", or an expired or revoked token. */
const signedOut = (error: string) =>
  /not logged in|please run \/login|oauth token .*(expired|revoked)/i.test(
    error,
  );

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Switches Claude to the key already saved. */
function UseKey({ setup }: { setup: ClaudeSetup }) {
  return (
    <div>
      <Button
        type="button"
        size="sm"
        disabled={!!setup.snapshot().running}
        onClick={() =>
          void setup.auth.use("api-key").then(
            () => setup.check(),
            () => undefined,
          )
        }
      >
        Use your API key
      </Button>
    </div>
  );
}

/** Setup's ask while Claude cannot run: the key, once for every agent.
 * `onSaved` follows a saved key, so a surface can close. */
export function SignIn({
  setup,
  disabled = false,
  variant = "full",
  onSaved,
}: {
  setup: ClaudeSetup;
  disabled?: boolean;
  variant?: "full" | "compact";
  onSaved?: (() => void) | undefined;
}) {
  return (
    <div className="grid gap-3">
      {/* One paragraph says it all; the field adds no description of its own. */}
      <p className="m-0 text-body-sm text-secondary">{KEY_ONCE}</p>
      {/* An account's sign-in lapsed: the key saved before still works. */}
      {setup.auth.found.method === "account" && setup.auth.found.key && (
        <UseKey setup={setup} />
      )}
      <KeyForm
        setup={setup}
        disabled={disabled}
        compact={variant === "compact"}
        onSaved={onSaved}
      />
    </div>
  );
}

/** Claude's settings once it can run: the way it signs in, replacing the
 * key, and switching to the other way. `onSaved` follows a saved key, so a
 * surface can close. */
export function SignedIn({
  setup,
  onSaved,
}: {
  setup: ClaudeSetup;
  onSaved?: (() => void) | undefined;
}) {
  const { method, key, account } = setup.auth.found;
  const busy = !!setup.snapshot().running;
  if (method === "api-key")
    return (
      <div className="grid gap-2">
        <p className="m-0 text-body-sm text-subtle">
          Claude runs with your Anthropic API key.
        </p>
        <KeyForm setup={setup} replace onSaved={onSaved} />
        <div>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => void setup.run("sign-in")}
          >
            Use Claude account
          </Button>
        </div>
      </div>
    );
  return (
    <div className="grid gap-2">
      <p className="m-0 text-body-sm text-subtle">
        Claude runs with your Claude account
        {account?.label ? ` (${account.label})` : ""}.
      </p>
      {key ? (
        <UseKey setup={setup} />
      ) : (
        <KeyForm setup={setup} onSaved={onSaved} />
      )}
    </div>
  );
}

/** Where an agent's own surface, such as its library card, says Claude
 * cannot run: setup is one step in Settings, not one per agent. */
export function Missing({
  openSettings,
}: {
  openSettings?: (() => void) | undefined;
}) {
  return (
    <p className="m-0 text-body-sm text-secondary">
      Claude is not set up.{" "}
      {openSettings ? (
        <>
          Head to{" "}
          <button
            type="button"
            className={inlineStyles.link}
            onClick={openSettings}
          >
            Settings
          </button>{" "}
          to sign in or add an API key.
        </>
      ) : (
        "Sign in or add an API key in Settings → Agent setup."
      )}
    </p>
  );
}

function KeyForm({
  setup,
  disabled: off = false,
  compact = false,
  replace = false,
  onSaved,
}: {
  setup: ClaudeSetup;
  disabled?: boolean;
  compact?: boolean;
  replace?: boolean;
  onSaved?: (() => void) | undefined;
}) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState<AbortController>();
  // Kept until the form closes.
  const [saved, setSaved] = useState<{ ok: boolean; text: string }>();
  // A sign-in under way would choose the account after a key saved now.
  const signingIn =
    useSyncExternalStore(setup.subscribe, setup.snapshot).running === "sign-in";
  const disabled = off || signingIn;
  // Closing the form cancels a save.
  useEffect(() => () => saving?.abort(), [saving]);
  const save = async () => {
    if (!key.trim() || saving || disabled) return;
    const controller = new AbortController();
    setSaving(controller);
    setSaved(undefined);
    try {
      const text = await setup.auth.save(key.trim(), controller.signal);
      setKey("");
      setSaved({ ok: true, text });
      await setup.check();
      onSaved?.();
    } catch (error) {
      if (!controller.signal.aborted)
        setSaved({ ok: false, text: message(error) });
    } finally {
      setSaving(undefined);
    }
  };
  return (
    // Not a form: it sits inside agent creation's and Settings' own.
    <div className="grid gap-2" aria-busy={saving ? true : undefined}>
      <Field
        label={replace ? "Replace API key" : "Anthropic API key"}
        {...(replace && {
          description:
            "Create a key at console.anthropic.com. Buzz keeps it securely on this computer and gives it only to Claude, so commands your Claude agents run can read it.",
        })}
      >
        <Input
          type="password"
          autoComplete="off"
          value={key}
          readOnly={!!saving}
          aria-disabled={saving || disabled ? true : undefined}
          onValueChange={setKey}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void save();
          }}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          {...(!replace && { variant: "prominent" as const })}
          size={compact ? "sm" : "md"}
          disabled={disabled || !key.trim()}
          focusableWhenDisabled
          loading={!!saving}
          onClick={() => void save()}
        >
          Save key
        </Button>
        {saved && (
          <p
            role={saved.ok ? "status" : "alert"}
            className={
              saved.ok ? "m-0 text-body-sm text-subtle" : "buzz-field-error m-0"
            }
          >
            {saved.text}
          </p>
        )}
      </div>
    </div>
  );
}
