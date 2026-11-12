// One live set of shared thread titles per relay session, read by the Threads
// page, the channel timeline and thread tabs. The relay's current read is the
// only authority: a live title revision only marks its channel stale, and a
// debounced read of the stale channels replaces their titles. NIP-AR orders
// revisions by `prev`, not by time, so live events are never applied as-is.
//
// Relay reads per session: ceil(joined/100) current reads when the first
// reader subscribes and whenever the joined set changes, then one read per
// burst of title changes. Following adds no subscriptions: the live routes
// already carry the joined channels.
import { useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import {
  activityKey,
  readTitles,
  staleChannels,
  type ThreadTitle,
} from "./thread-titles";

/** A burst of title changes waits this long, then reads its channels once. */
const TITLE_DEBOUNCE_MS = 300;

export type ThreadTitles = Readonly<{
  /** By activityKey(channel, root); undefined until the first read settles. */
  titles: ReadonlyMap<string, ThreadTitle> | undefined;
  /** Some channel had more titles than one read returns. */
  partial: boolean;
  error?: string | undefined;
}>;

export type ThreadTitleStore = Readonly<{
  snapshot(): ThreadTitles;
  subscribe(listener: () => void): () => void;
  get(channelId: string, rootId: string): ThreadTitle | undefined;
  /** Reads every joined channel again. */
  refresh(): void;
  /** A write this client made, shown before the relay's echo is re-read. */
  apply(
    channelId: string,
    rootId: string,
    title: ThreadTitle | undefined,
  ): void;
}>;

type Session = Pick<RelaySession, "snapshotRead" | "artifacts" | "channels">;

const stores = new WeakMap<Session, ThreadTitleStore>();

export function threadTitleStore(session: Session): ThreadTitleStore {
  let store = stores.get(session);
  if (!store) {
    store = createStore(session);
    stores.set(session, store);
  }
  return store;
}

export function useThreadTitles(session: Session) {
  const store = threadTitleStore(session);
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

export function useThreadTitle(
  session: Session,
  channelId: string,
  rootId: string,
) {
  return useThreadTitles(session).titles?.get(
    activityKey(channelId, rootId.toLowerCase()),
  );
}

function createStore(session: Session): ThreadTitleStore {
  const listeners = new Set<() => void>();
  let state: ThreadTitles = { titles: undefined, partial: false };
  const set = (next: Partial<ThreadTitles>) => {
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener();
  };
  /** The joined channels being followed, sorted and joined; undefined while stopped. */
  let channelKey: string | undefined;
  let stopRun: (() => void) | undefined;
  let stopList: (() => void) | undefined;

  // Follows `ids` and reads them all, replacing every title.
  const start = (ids: readonly string[]) => {
    stopRun?.();
    const read = session.snapshotRead;
    const joined = new Set(ids);
    if (state.titles)
      set({
        titles: new Map(
          [...state.titles].filter(([, t]) => joined.has(t.channel)),
        ),
      });
    if (!read || !ids.length) {
      stopRun = undefined;
      return set({ titles: new Map(), partial: false, error: undefined });
    }
    const controller = new AbortController();
    const { signal } = controller;
    const stale = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    let partial = new Set<string>();
    const run = (channels: readonly string[], first: boolean) => {
      reading = true;
      readTitles(read, channels, signal)
        .then((found) => {
          if (signal.aborted) return;
          const titles = new Map(
            first
              ? []
              : [...(state.titles ?? [])].filter(
                  ([, t]) => !channels.includes(t.channel),
                ),
          );
          for (const t of found.titles)
            titles.set(activityKey(t.channel, t.root), t);
          partial = new Set(
            first ? [] : [...partial].filter((c) => !channels.includes(c)),
          );
          if (found.partial) for (const c of channels) partial.add(c);
          set({ titles, partial: partial.size > 0, error: undefined });
        })
        .catch((cause) => {
          if (signal.aborted) return;
          set({
            ...(!state.titles && { titles: new Map() }),
            error: cause instanceof Error ? cause.message : String(cause),
          });
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
      run(channels, false);
    };
    const stopFollow = session.artifacts.follow(ids, (events) => {
      void staleChannels(events, joined).then((changed) => {
        if (signal.aborted || !changed.size) return;
        for (const channel of changed) stale.add(channel);
        if (reading) return;
        clearTimeout(timer);
        timer = setTimeout(flush, TITLE_DEBOUNCE_MS);
      });
    });
    run(ids, true);
    stopRun = () => {
      controller.abort();
      clearTimeout(timer);
      stopFollow();
    };
  };

  // Restarts when the joined set changes; a background list refresh with the
  // same channels reads nothing.
  const sync = () => {
    const list = session.channels.list();
    if (list.status === "error")
      return set({
        ...(!state.titles && { titles: new Map() }),
        error: list.error || "Couldn't load your channels.",
      });
    if (list.status !== "ready" && !list.channels.length) return;
    const ids = [...new Set(list.channels.map((c) => c.id))].sort();
    const key = ids.join(",");
    if (key === channelKey) return;
    channelKey = key;
    start(ids);
  };

  const open = () => {
    // Without a snapshot reader there is nothing to read or follow.
    if (!session.snapshotRead) return set({ titles: new Map() });
    session.channels.ensureList();
    stopList = session.channels.subscribeList(sync);
    sync();
  };
  const close = () => {
    stopList?.();
    stopRun?.();
    stopList = stopRun = channelKey = undefined;
  };

  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) open();
      return () => {
        if (!listeners.delete(listener) || listeners.size) return;
        close();
      };
    },
    get: (channelId, rootId) =>
      state.titles?.get(activityKey(channelId, rootId.toLowerCase())),
    refresh() {
      if (!listeners.size) return;
      close();
      open();
    },
    apply(channelId, rootId, title) {
      const titles = new Map(state.titles);
      const key = activityKey(channelId, rootId.toLowerCase());
      if (title) titles.set(key, title);
      else titles.delete(key);
      set({ titles });
    },
  };
}
