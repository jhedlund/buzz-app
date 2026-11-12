import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Navigation } from "../../features/navigation/controller";
import type { NavigationScope } from "../../features/navigation/targets";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  ArrowsClockwiseIcon,
  MessageReplyIcon,
  PencilSimpleIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import {
  NavigationCard,
  NavigationItem,
} from "../../shared/design-system/ui/NavigationItem";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { Select } from "../../shared/design-system/ui/Select";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import {
  threadTitleStore,
  useThreadTitles,
} from "../../features/messages/thread-title-store";
import {
  activityKey,
  normalizeTitle,
  noteReplies,
  type Row,
  readActivity,
  writeTitle,
} from "../../features/messages/thread-titles";
import styles from "./Threads.module.css";

const ALL = "";

export function ThreadsPage({
  relay,
  navigator,
}: {
  relay: RelayData;
  navigator: Navigation;
}) {
  const connection = useRelayConnection(relay);
  const { viewer, scope } = connection;
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Threads">
        {connection.status === "ready" &&
        viewer &&
        scope?.endsWith(`:${viewer}`) ? (
          <ThreadsView
            key={`${scope}:${connection.generation}`}
            session={connection.session}
            scope={{
              viewer,
              communityOrigin: scope.slice(0, -(viewer.length + 1)),
            }}
            navigator={navigator}
          />
        ) : (
          <div data-buzz-ui="" className={styles.page}>
            <Header />
            <p className={`text-body text-subtle ${styles.notice}`}>
              {connection.status === "connecting"
                ? "Connecting…"
                : "Choose a community to see its threads."}
            </p>
          </div>
        )}
      </FullPageSurface>
    </div>
  );
}

function Header({ onRefresh }: { onRefresh?: () => void }) {
  return (
    <PanelHeader
      title={
        <PanelHeaderLabel
          title="Threads"
          icon={<MessageReplyIcon size="1rem" />}
        />
      }
      actions={
        onRefresh && (
          <IconButton
            size="sm"
            variant="ghost"
            icon={<ArrowsClockwiseIcon size="1rem" aria-hidden="true" />}
            aria-label="Refresh threads"
            title="Refresh"
            hint="familiar"
            onClick={onRefresh}
          />
        )
      }
    />
  );
}

/** Inline rename: Enter or leaving saves (blank clears), Escape cancels. */
function TitleField({
  title,
  onDone,
}: {
  title: string;
  onDone(draft: string | undefined): void;
}) {
  const done = useRef(false);
  const finish = (draft: string | undefined) => {
    if (done.current) return;
    done.current = true;
    onDone(draft);
  };
  return (
    <Input
      aria-label={`Title for ${title}`}
      defaultValue={title}
      autoFocus
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(event.currentTarget.value);
        if (event.key === "Escape") finish(undefined);
      }}
      onBlur={(event) => finish(event.currentTarget.value)}
    />
  );
}

export function ThreadsView({
  session,
  scope,
  navigator,
}: {
  session: RelaySession;
  scope: NavigationScope;
  navigator: Navigation;
}) {
  const list = useChannelList(session.channels);
  const names = useMemo(
    () => new Map(list.channels.map((c) => [c.id, c.name || "Conversation"])),
    [list.channels],
  );
  const store = threadTitleStore(session);
  const shared = useThreadTitles(session);
  const titles = useMemo(
    () => shared.titles && [...shared.titles.values()],
    [shared.titles],
  );
  const [activity, setActivity] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const [saveError, setSaveError] = useState<string>();
  const [filter, setFilter] = useState(ALL);
  const [editing, setEditing] = useState<string>();
  const [saving, setSaving] = useState<string>();
  const [generation, setGeneration] = useState(0);
  const read = session.snapshotRead;
  const writer = session.configArtifactWriter;
  const error = saveError ?? shared.error;

  // Reply times of titled rows: one `#e` read per row as it appears (again
  // after it leaves and comes back), then live replies, in any order. A reply
  // that lands before its row is known is in that row's read.
  const latest = useRef(new Map<string, number>());
  const activityRead = useRef(new Set<string>());
  const titled = useMemo(
    () => new Set(titles?.map((t) => activityKey(t.channel, t.root))),
    [titles],
  );
  useEffect(() => {
    void generation;
    if (!titles) return;
    for (const key of latest.current.keys())
      if (!titled.has(key)) latest.current.delete(key);
    for (const key of activityRead.current)
      if (!titled.has(key)) activityRead.current.delete(key);
    const fresh = titles.filter(
      (t) => !activityRead.current.has(activityKey(t.channel, t.root)),
    );
    setActivity(new Map(latest.current));
    if (!fresh.length) return;
    const controller = new AbortController();
    readActivity(session, fresh, controller.signal)
      .then((times) => {
        for (const t of fresh)
          activityRead.current.add(activityKey(t.channel, t.root));
        for (const [key, at] of times)
          if (titled.has(key))
            latest.current.set(key, Math.max(at, latest.current.get(key) ?? 0));
        setActivity(new Map(latest.current));
      })
      // Only an abort rejects: readActivity keeps failed batches at title time.
      .catch(() => {});
    return () => controller.abort();
  }, [session, titles, titled, generation]);
  useEffect(() => {
    const channels = new Set(titles?.map((t) => t.channel));
    return session.subscribeLive(({ events }) => {
      // Copies only when a shown row's time actually advances.
      if (noteReplies(events, channels, titled, latest.current))
        setActivity(new Map(latest.current));
    });
  }, [session, titles, titled]);

  const refresh = () => {
    activityRead.current.clear();
    setSaveError(undefined);
    store.refresh();
    setGeneration((g) => g + 1);
  };

  const rows = useMemo(
    () =>
      titles?.map(
        (t): Row => ({
          ...t,
          activeAt: Math.max(
            t.updatedAt,
            activity.get(activityKey(t.channel, t.root)) ?? 0,
          ),
        }),
      ),
    [titles, activity],
  );

  const save = useCallback(
    async (row: Row, draft: string | undefined) => {
      setEditing(undefined);
      if (!read || !writer) return;
      setSaving(row.root);
      setSaveError(undefined);
      try {
        const desired = draft === undefined ? undefined : normalizeTitle(draft);
        if (desired === row.title) return;
        const revision = await writeTitle(
          read,
          writer,
          row,
          desired,
          AbortSignal.timeout(20_000),
        );
        // A title change is activity: updatedAt moves the row up.
        store.apply(
          row.channel,
          row.root,
          desired && revision
            ? {
                title: desired,
                channel: row.channel,
                root: row.root,
                revision,
                updatedAt: Math.floor(Date.now() / 1000),
              }
            : undefined,
        );
      } catch (cause) {
        setSaveError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSaving(undefined);
      }
    },
    [read, writer, store],
  );

  const sorted = (rows ?? [])
    .filter((r) => filter === ALL || r.channel === filter)
    .sort((a, b) => b.activeAt - a.activeAt);
  const filterChannels = [...new Set((rows ?? []).map((r) => r.channel))]
    .map((id) => ({ value: id, label: names.get(id) ?? "Conversation" }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div data-buzz-ui="" className={styles.page}>
      <Header onRefresh={refresh} />
      {read ? (
        <>
          <div className={styles.toolbar}>
            <Select
              label="Channel"
              variant="compact"
              size="sm"
              value={filter}
              onValueChange={setFilter}
              groups={[
                {
                  label: "Channels",
                  options: [
                    { value: ALL, label: "All channels" },
                    ...filterChannels,
                  ],
                },
              ]}
            />
          </div>
          {error && (
            <p role="alert" className={`text-body-sm ${styles.notice}`}>
              {error}
            </p>
          )}
          <div className={styles.scroller}>
            <LoadingRegion
              pending={!rows && !error}
              label="Loading threads…"
              statusVisibility="screen-reader"
            >
              {!rows ? null : sorted.length === 0 ? (
                <EmptyState
                  icon={<MessageReplyIcon size={24} />}
                  title={
                    rows.length ? "No named threads here" : "No named threads"
                  }
                  description={
                    rows.length
                      ? "Choose All channels to see every named thread."
                      : "Threads appear here once someone gives them a title, for example with buzz threads title set."
                  }
                />
              ) : (
                <ul className={styles.list} aria-label="Named threads">
                  {sorted.map((row) => (
                    <li key={row.root} className={styles.row}>
                      {editing === row.root ? (
                        <TitleField
                          title={row.title}
                          onDone={(draft) =>
                            draft === undefined
                              ? setEditing(undefined)
                              : void save(row, draft)
                          }
                        />
                      ) : (
                        <NavigationCard>
                          <NavigationItem
                            multiline
                            aria-busy={saving === row.root || undefined}
                            label={
                              <span className={styles.label}>
                                <span className="text-body">{row.title}</span>
                                <span className="text-caption text-subtle">
                                  {names.get(row.channel) ?? "Conversation"} ·{" "}
                                  {relativeTimestamp(row.activeAt)}
                                </span>
                              </span>
                            }
                            onClick={() =>
                              void navigator.open({
                                version: 1,
                                kind: "conversation",
                                scope,
                                channelId: row.channel,
                                messageId: row.root,
                                threadRootId: row.root,
                              })
                            }
                          />
                          {writer && (
                            <span className={styles.actions}>
                              <IconButton
                                variant="bare"
                                icon={<PencilSimpleIcon size={16} />}
                                aria-label={`Rename ${row.title}`}
                                title="Rename"
                                disabled={!!saving}
                                onClick={() => setEditing(row.root)}
                              />
                              <IconButton
                                variant="bare"
                                icon={<XIcon size={16} />}
                                aria-label={`Clear title ${row.title}`}
                                title="Clear title"
                                disabled={!!saving}
                                onClick={() => void save(row, undefined)}
                              />
                            </span>
                          )}
                        </NavigationCard>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {shared.partial && (
                <p className={`text-caption text-subtle ${styles.notice}`}>
                  Showing the most recently titled threads.
                </p>
              )}
            </LoadingRegion>
          </div>
        </>
      ) : (
        <p className={`text-body text-subtle ${styles.notice}`}>
          This community connection can't read thread titles.
        </p>
      )}
    </div>
  );
}
