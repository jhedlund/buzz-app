// Live per-thread signals for titled threads, from session state that is
// already live: unread from the session's thread activity (the source of the
// channel's own thread dots), and working agents from agent activity (the
// source the channel's working indicator reads). No relay reads.
import { useMemo, useSyncExternalStore } from "react";
import { localWorkRoot } from "../../features/agents/local-activity";
import { activityKey } from "../../features/messages/thread-titles";
import type { ThreadActivitySnapshot } from "../../features/relay/unread";
import type { RelaySession } from "../../features/relay/session";

type AgentSnapshot = ReturnType<RelaySession["agentActivity"]["snapshot"]>;

export type ThreadWork = Readonly<{
  agents: readonly string[];
  /** Earliest known start in ms; absent when only a relay turn shows it. */
  startedAt?: number;
}>;

/** Unread replies per thread, by activityKey. Unknown or denied activity
 * (`items: null`) counts as none. */
export function unreadByThread(snapshots: Iterable<ThreadActivitySnapshot>) {
  const unread = new Map<string, number>();
  for (const snapshot of snapshots)
    for (const item of snapshot.items ?? [])
      if (item.unreadCount > 0)
        unread.set(
          activityKey(item.channelId, item.rootId.toLowerCase()),
          item.unreadCount,
        );
  return unread;
}

/** Agents working in each thread, by activityKey. Local work wins over the
 * relay's view of the same agent in that channel, as the channel's own
 * indicator rules; work with no thread root belongs to the channel. */
export function workingByThread(snapshot: AgentSnapshot) {
  const work = new Map<string, { agents: Set<string>; startedAt?: number }>();
  const add = (
    channel: string,
    root: string | undefined,
    agent: string,
    startedAt?: number,
  ) => {
    if (!root) return;
    const key = activityKey(channel, root.toLowerCase());
    const entry = work.get(key) ?? { agents: new Set<string>() };
    entry.agents.add(agent);
    if (startedAt !== undefined)
      entry.startedAt = Math.min(startedAt, entry.startedAt ?? startedAt);
    work.set(key, entry);
  };
  const local = new Set<string>();
  for (const row of snapshot.local ?? []) {
    // Any local row for an agent in a channel decides its state there.
    local.add(`${row.channelId} ${row.agent}`);
    if (row.state === "waiting" || row.state === "working")
      add(row.channelId, localWorkRoot(row), row.agent, row.startedAt);
  }
  if (snapshot.status === "listening") {
    for (const turn of snapshot.turns)
      if (
        turn.state === "working" &&
        turn.channelId &&
        !local.has(`${turn.channelId} ${turn.agent}`)
      )
        add(turn.channelId, turn.threadRootId, turn.agent);
    for (const entry of snapshot.typing)
      if (!local.has(`${entry.channelId} ${entry.agent}`))
        add(entry.channelId, entry.threadRootId, entry.agent, entry.startedAt);
  }
  return new Map(
    [...work].map(([key, { agents, startedAt }]): [string, ThreadWork] => [
      key,
      {
        agents: [...agents].sort(),
        ...(startedAt !== undefined && { startedAt }),
      },
    ]),
  );
}

export type ThreadSignals = Readonly<{
  unread: ReadonlyMap<string, number>;
  working: ReadonlyMap<string, ThreadWork>;
}>;

const same = (a: ThreadSignals, b: ThreadSignals) =>
  JSON.stringify([[...a.unread], [...a.working]]) ===
  JSON.stringify([[...b.unread], [...b.working]]);

/** Both signals for these channels. The snapshot changes only when a signal
 * does, so frequent agent-activity publishes re-render nothing. */
export function useThreadSignals(
  session: Pick<RelaySession, "unread" | "agentActivity">,
  channelIds: readonly string[],
) {
  const key = [...new Set(channelIds)].sort().join(",");
  const store = useMemo(() => {
    const ids = key ? key.split(",") : [];
    let last: ThreadSignals | undefined;
    const read = (): ThreadSignals => {
      const next = {
        unread: unreadByThread(ids.map((id) => session.unread.activity(id))),
        working: workingByThread(session.agentActivity.snapshot()),
      };
      if (!last || !same(last, next)) last = next;
      return last;
    };
    return {
      read,
      subscribe(listener: () => void) {
        const stops = [
          ...ids.map((id) => session.unread.subscribeActivity(id, listener)),
          session.agentActivity.subscribe(listener),
        ];
        return () => {
          for (const stop of stops) stop();
        };
      },
    };
  }, [session, key]);
  return useSyncExternalStore(store.subscribe, store.read, store.read);
}

/** Elapsed working time as the channel's working indicator shows it. */
export function workingDuration(startedAt: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
}
