import { useMemo } from "react";
import { useThreadTitles } from "../../features/messages/thread-title-store";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { TypingDots } from "../../shared/design-system/ui/TypingDots";
import styles from "./Threads.module.css";
import { useThreadSignals } from "./thread-signals";

/** The sidebar entry's mark: how many titled threads have an agent working,
 * else a dot while one is unread. Live with the page closed. */
export function ThreadsBadge({ relay }: { relay: RelayData }) {
  const connection = useRelayConnection(relay);
  return connection.status === "ready" ? (
    <SessionBadge session={connection.session} />
  ) : null;
}

export function SessionBadge({ session }: { session: RelaySession }) {
  const { titles } = useThreadTitles(session);
  const channels = useMemo(
    () => [...new Set([...(titles?.values() ?? [])].map((t) => t.channel))],
    [titles],
  );
  const { unread, working } = useThreadSignals(session, channels);
  if (!titles) return null;
  const busy = [...working.keys()].filter((key) => titles.has(key)).length;
  if (busy)
    return (
      <span
        className={`text-caption ${styles.badgeWorking}`}
        role="img"
        aria-label={`Agents working in ${busy} named ${busy === 1 ? "thread" : "threads"}`}
      >
        <TypingDots size="small" />
        {busy}
      </span>
    );
  const unreadThreads = [...unread.keys()].filter((key) =>
    titles.has(key),
  ).length;
  return unreadThreads ? (
    <span
      className={styles.badgeDot}
      role="img"
      aria-label={`${unreadThreads} unread named ${unreadThreads === 1 ? "thread" : "threads"}`}
    />
  ) : null;
}
