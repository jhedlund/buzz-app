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
import styles from "./Threads.module.css";
import {
  activityKey,
  normalizeTitle,
  type Row,
  readActivity,
  readTitles,
  staleChannels,
  type ThreadTitle,
  noteReplies,
  writeTitle,
} from "./thread-titles";

const ALL = "";
/** A burst of title changes waits this long, then reads its channels once. */
const TITLE_DEBOUNCE_MS = 300;

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
  const channelKey = [...names.keys()].sort().join(",");
  const [titles, setTitles] = useState<readonly ThreadTitle[]>();
  const [activity, setActivity] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const [partial, setPartial] = useState(false);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState(ALL);
  const [editing, setEditing] = useState<string>();
  const [saving, setSaving] = useState<string>();
  const [generation, setGeneration] = useState(0);
  const read = session.snapshotRead;
  const writer = session.configArtifactWriter;

  // Settled once, so a background list refresh does not re-read titles.
  const listReady = list.status === "ready" || list.channels.length > 0;
  const listError = list.status === "error" ? (list.error ?? "") : undefined;
  // The relay's current read is the only authority on titles: a live title
  // revision only marks its channel stale, and a debounced read of the stale
  // channels replaces their rows. Replies keep the newest time per titled
  // root, in any order; other roots only in a capped buffer while a read is
  // in flight, merged once the rows are known. The live routes already carry the joined channels, titles
  // included, so following them adds no subscriptions.
  useEffect(() => {
    void generation;
    if (listError !== undefined)
      return setError(listError || "Couldn't load your channels.");
    if (!read || !listReady) return;
    if (!channelKey) return setTitles([]);
    const ids = channelKey.split(",");
    const joined = new Set(ids);
    const controller = new AbortController();
    const { signal } = controller;
    const stale = new Set<string>();
    const activityRead = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    /** Reply times of titled rows only, and replies held during a read. */
    const latest = new Map<string, number>();
    const buffer = new Map<string, number>();
    let shown: readonly ThreadTitle[] = [];
    let titled = new Set<string>();
    const load = async (channels: readonly string[], first: boolean) => {
      const found = await readTitles(read, channels, signal);
      const fresh = found.titles.filter(
        (t) => !activityRead.has(activityKey(t.channel, t.root)),
      );
      const times = await readActivity(session, fresh, signal);
      for (const t of fresh) activityRead.add(activityKey(t.channel, t.root));
      shown = [
        ...(first ? [] : shown.filter((t) => !channels.includes(t.channel))),
        ...found.titles,
      ];
      titled = new Set(shown.map((t) => activityKey(t.channel, t.root)));
      for (const [key, at] of [...times, ...buffer])
        if (titled.has(key))
          latest.set(key, Math.max(at, latest.get(key) ?? 0));
      buffer.clear();
      // A row that leaves and comes back reads its replies again.
      for (const key of latest.keys()) if (!titled.has(key)) latest.delete(key);
      for (const key of activityRead)
        if (!titled.has(key)) activityRead.delete(key);
      setActivity(new Map(latest));
      setPartial((was) => found.partial || (!first && was));
      setError(undefined);
      setTitles((current) => [
        ...(first
          ? []
          : (current ?? []).filter((t) => !channels.includes(t.channel))),
        ...found.titles,
      ]);
    };
    const run = (channels: readonly string[], first = false) => {
      reading = true;
      load(channels, first)
        .catch((cause) => {
          if (!signal.aborted)
            setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          reading = false;
          // Channels that changed during this read get one follow-up read.
          if (!signal.aborted && stale.size) flush();
        });
    };
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      if (reading) return;
      const channels = [...stale];
      stale.clear();
      run(channels);
    };
    const stopTitles = session.artifacts.follow(ids, (events) => {
      void staleChannels(events, joined).then((changed) => {
        if (signal.aborted || !changed.size) return;
        for (const channel of changed) stale.add(channel);
        if (reading) return;
        clearTimeout(timer);
        timer = setTimeout(flush, TITLE_DEBOUNCE_MS);
      });
    });
    const stopReplies = session.subscribeLive(({ events }) => {
      // Copies only when a shown row's time actually advances.
      if (
        noteReplies(
          events,
          joined,
          titled,
          latest,
          reading ? buffer : undefined,
        )
      )
        setActivity(new Map(latest));
    });
    run(ids, true);
    return () => {
      controller.abort();
      clearTimeout(timer);
      stopTitles();
      stopReplies();
    };
  }, [read, session, channelKey, listReady, listError, generation]);

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
      setError(undefined);
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
        const now = Math.floor(Date.now() / 1000);
        setTitles((current) =>
          current?.flatMap((t) =>
            t.root !== row.root
              ? [t]
              : desired && revision
                ? [{ ...t, title: desired, revision, updatedAt: now }]
                : [],
          ),
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSaving(undefined);
      }
    },
    [read, writer],
  );

  const sorted = (rows ?? [])
    .filter((r) => filter === ALL || r.channel === filter)
    .sort((a, b) => b.activeAt - a.activeAt);
  const filterChannels = [...new Set((rows ?? []).map((r) => r.channel))]
    .map((id) => ({ value: id, label: names.get(id) ?? "Conversation" }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div data-buzz-ui="" className={styles.page}>
      <Header onRefresh={() => setGeneration((g) => g + 1)} />
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
              {partial && (
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
