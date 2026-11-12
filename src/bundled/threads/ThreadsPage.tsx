import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Navigation } from "../../features/navigation/controller";
import type { NavigationScope } from "../../features/navigation/targets";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  ArrowsClockwiseIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckCircleFilledIcon,
  CheckCircleIcon,
  ChecksIcon,
  MessageReplyIcon,
  PencilSimpleIcon,
  PinFilledIcon,
  PinIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { CountBadge } from "../../shared/design-system/ui/CountBadge";
import { TypingDots } from "../../shared/design-system/ui/TypingDots";
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
  threadActivityStore,
  useThreadActivity,
} from "../../features/messages/thread-activity-store";
import {
  threadTitleStore,
  useThreadTitles,
} from "../../features/messages/thread-title-store";
import {
  activityKey,
  normalizeTitle,
  type Row,
  writeTitle,
} from "../../features/messages/thread-titles";
import styles from "./Threads.module.css";
import {
  encodeMarks,
  isDone,
  MARK_COORDINATE,
  type MarkKind,
  type Marks,
  parseMarks,
  setMark,
} from "./thread-marks";
import { useThreadSignals, workingDuration } from "./thread-signals";

const ALL = "";
type MarkChange = Readonly<{
  kind: MarkKind;
  root: string;
  on: boolean;
  at: number;
}>;

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
  // Rows draw from titles alone, by title time; reply times reorder them as
  // they arrive and stay for the session, so a reopened page reads nothing.
  const activity = useThreadActivity(session);
  const [saveError, setSaveError] = useState<string>();
  const [filter, setFilter] = useState(ALL);
  const [editing, setEditing] = useState<string>();
  const [saving, setSaving] = useState<string>();
  const read = session.snapshotRead;
  const writer = session.configArtifactWriter;
  const error = saveError ?? shared.error;
  const toolbar = useRef<HTMLDivElement>(null);

  // Pins and done marks are private records only the desktop host can read
  // and write; without it the page shows neither. Read on open and Refresh.
  const readMarks = session.readThreadMarks;
  const writeMarks = session.writeThreadMarks;
  // What the relay last said, and the changes not yet saved: the page shows
  // the saved marks with every pending change applied, so a read or a
  // write's result never hides a change still in the queue.
  const [saved, setSaved] = useState<
    Readonly<{ pins: Marks; done: Marks }> | undefined
  >();
  const [pending, setPending] = useState<readonly MarkChange[]>([]);
  const marks = useMemo(
    () =>
      saved &&
      pending.reduce(
        (shown, change) => ({
          ...shown,
          [change.kind]: setMark(
            shown[change.kind],
            change.root,
            change.on,
            change.at,
          ),
        }),
        saved,
      ),
    [saved, pending],
  );
  const [showDone, setShowDone] = useState(false);
  const [marksGeneration, setMarksGeneration] = useState(0);
  useEffect(() => {
    void marksGeneration;
    if (!readMarks) return;
    const controller = new AbortController();
    const { signal } = controller;
    Promise.all(
      (["pins", "done"] as const).map(async (kind) =>
        parseMarks(kind, await readMarks(MARK_COORDINATE[kind], signal)),
      ),
    ).then(
      ([pins, done]) => {
        if (pins && done) setSaved({ pins, done });
      },
      (cause) => {
        if (!signal.aborted)
          setSaveError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => controller.abort();
  }, [readMarks, marksGeneration]);
  // A mark shows at once. Writes run one at a time, each reading the latest
  // record and changing one root (an unreadable record aborts before
  // anything is written). Each result becomes the saved marks; a failed
  // write drops its change and re-reads them.
  const writes = useRef(Promise.resolve());
  const mark = useCallback(
    (kind: MarkKind, root: string, on: boolean) => {
      if (!writeMarks) return;
      setSaveError(undefined);
      const change: MarkChange = { kind, root, on, at: Date.now() };
      setPending((current) => [...current, change]);
      const settle = () =>
        setPending((current) => current.filter((c) => c !== change));
      writes.current = writes.current.then(async () => {
        try {
          const result = parseMarks(
            kind,
            await writeMarks(
              MARK_COORDINATE[kind],
              (current) =>
                encodeMarks(
                  kind,
                  setMark(parseMarks(kind, current), root, on, Date.now()),
                ),
              AbortSignal.timeout(20_000),
            ),
          );
          setSaved((current) => current && { ...current, [kind]: result });
          settle();
          if (!!result.get(root)?.on !== on)
            throw new Error(
              "That changed on another device. Refresh and try again.",
            );
        } catch (cause) {
          settle();
          setSaveError(cause instanceof Error ? cause.message : String(cause));
          setMarksGeneration((g) => g + 1);
        }
      });
    },
    [writeMarks],
  );

  const refresh = () => {
    setSaveError(undefined);
    threadActivityStore(session).refresh();
    setMarksGeneration((g) => g + 1);
  };

  const rows = useMemo(
    () =>
      titles?.map(
        (t): Row => ({
          ...t,
          activeAt: Math.max(
            t.updatedAt,
            activity.get(activityKey(t.channel, t.root))?.at ?? 0,
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

  // The replies in a row's newest second count only when that second is a
  // reply's, not its title's.
  const signals = useThreadSignals(
    session,
    useMemo(() => [...new Set(titles?.map((t) => t.channel))], [titles]),
  );
  const unreadOf = (row: Row) =>
    signals.unread.get(activityKey(row.channel, row.root)) ?? 0;
  // One tick for the page, only while a working row shows a time.
  const timed = [...signals.working.values()].some(
    (work) => work.startedAt !== undefined,
  );
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!timed) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [timed]);
  const markRead = async (row: Row) => {
    setSaveError(undefined);
    try {
      let prepared: () => Promise<unknown>;
      try {
        prepared = session.unread.prepareThreadRead(row.channel, row.root);
      } catch {
        // Unread state has only the roots this session has seen. A verified
        // read of the root lets it prepare the read; a second failure is real.
        await session.read(
          [{ ids: [row.root], "#h": [row.channel], limit: 1 }],
          {
            signal: AbortSignal.timeout(20_000),
          },
        );
        prepared = session.unread.prepareThreadRead(row.channel, row.root);
      }
      await prepared();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  // Unread replies also reopen a done thread, as in Buzz 0.x: a view rule
  // only, the saved mark is untouched.
  const done = (row: Row) => {
    const frontier = activity.get(activityKey(row.channel, row.root));
    return (
      !unreadOf(row) &&
      isDone(
        marks?.done.get(row.root),
        row.activeAt,
        frontier?.at === row.activeAt ? frontier.ids : [],
      )
    );
  };
  const renderRow = (row: Row) => {
    const isPinned = !!marks?.pins.get(row.root)?.on;
    const isDoneRow = done(row);
    const unread = unreadOf(row);
    const work = signals.working.get(activityKey(row.channel, row.root));
    return (
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
                  <span className={`text-body ${unread ? styles.unread : ""}`}>
                    {row.title}
                  </span>
                  <span className="text-caption text-subtle">
                    {names.get(row.channel) ?? "Conversation"} ·{" "}
                    {relativeTimestamp(row.activeAt)}
                  </span>
                </span>
              }
              trailing={
                (unread > 0 || work) && (
                  <span className={styles.signals}>
                    {work && (
                      <span
                        className={`text-caption ${styles.working}`}
                        role="img"
                        aria-label={`${work.agents.length === 1 ? "An agent is" : `${work.agents.length} agents are`} working${work.startedAt === undefined ? "" : ` for ${workingDuration(work.startedAt, now)}`}`}
                      >
                        <TypingDots size="small" />
                        {work.startedAt !== undefined &&
                          workingDuration(work.startedAt, now)}
                      </span>
                    )}
                    <CountBadge
                      count={unread}
                      label={`${unread} unread ${unread === 1 ? "reply" : "replies"}`}
                    />
                  </span>
                )
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
            {(writer || marks || unread > 0) && (
              // Pin is last, Done before it, as in Buzz 0.x. Actions show on
              // hover or keyboard focus; a set pin or done mark stays shown.
              <span className={styles.actions}>
                {writer && (
                  <span data-reveal="">
                    <IconButton
                      variant="bare"
                      icon={<PencilSimpleIcon size={16} />}
                      aria-label={`Rename ${row.title}`}
                      title="Rename"
                      disabled={!!saving}
                      onClick={() => setEditing(row.root)}
                    />
                  </span>
                )}
                {unread > 0 && (
                  <span data-reveal="">
                    <IconButton
                      variant="bare"
                      icon={<ChecksIcon size={16} />}
                      aria-label={`Mark ${row.title} read`}
                      title="Mark read"
                      onClick={() => void markRead(row)}
                    />
                  </span>
                )}
                {marks && (
                  <>
                    <span data-reveal={isDoneRow ? undefined : ""}>
                      <IconButton
                        variant="bare"
                        icon={
                          isDoneRow ? (
                            <CheckCircleFilledIcon size={16} />
                          ) : (
                            <CheckCircleIcon size={16} />
                          )
                        }
                        aria-label={`${isDoneRow ? "Reopen" : "Mark done"} ${row.title}`}
                        aria-pressed={isDoneRow}
                        title={isDoneRow ? "Reopen" : "Mark done"}
                        onClick={() => mark("done", row.root, !isDoneRow)}
                      />
                    </span>
                    <span data-reveal={isPinned ? undefined : ""}>
                      <IconButton
                        variant="bare"
                        icon={
                          isPinned ? (
                            <PinFilledIcon size={16} />
                          ) : (
                            <PinIcon size={16} />
                          )
                        }
                        aria-label={`${isPinned ? "Unpin" : "Pin"} ${row.title}`}
                        aria-pressed={isPinned}
                        title={isPinned ? "Unpin" : "Pin"}
                        onClick={() => mark("pins", row.root, !isPinned)}
                      />
                    </span>
                  </>
                )}
              </span>
            )}
          </NavigationCard>
        )}
      </li>
    );
  };
  const pinned = sorted.filter((r) => marks?.pins.get(r.root)?.on);
  const unpinned = sorted.filter((r) => !marks?.pins.get(r.root)?.on);
  // Pinned wins over done for placement: a pinned done thread stays pinned.
  const finished = unpinned.filter((r) => done(r));
  const active = unpinned.filter((r) => !finished.includes(r));

  return (
    <div data-buzz-ui="" className={styles.page}>
      <Header onRefresh={refresh} />
      {read ? (
        <>
          <div ref={toolbar} className={styles.toolbar}>
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
            {filter !== ALL && (
              <IconButton
                size="sm"
                variant="ghost"
                icon={<XIcon size="1rem" aria-hidden="true" />}
                aria-label="Show all channels"
                title="Show all channels"
                hint="familiar"
                onClick={() => {
                  setFilter(ALL);
                  toolbar.current
                    ?.querySelector<HTMLElement>('[role="combobox"]')
                    ?.focus();
                }}
              />
            )}
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
                <>
                  {pinned.length > 0 && (
                    <ul className={styles.list} aria-label="Pinned threads">
                      {pinned.map(renderRow)}
                    </ul>
                  )}
                  <ul className={styles.list} aria-label="Named threads">
                    {active.map(renderRow)}
                  </ul>
                  {finished.length > 0 && (
                    <section aria-label="Done threads">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-expanded={showDone}
                        onClick={() => setShowDone((shown) => !shown)}
                      >
                        {showDone ? (
                          <CaretDownIcon size="1rem" aria-hidden="true" />
                        ) : (
                          <CaretRightIcon size="1rem" aria-hidden="true" />
                        )}
                        Done ({finished.length})
                      </Button>
                      {showDone && (
                        <ul className={styles.list} aria-label="Done threads">
                          {finished.map(renderRow)}
                        </ul>
                      )}
                    </section>
                  )}
                </>
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
