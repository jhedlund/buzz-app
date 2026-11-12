// Newest reply time per titled thread, kept for the relay session so the
// Threads page reopens at once. Each title gets one `#e` read when it appears
// (again after it leaves and comes back); live replies keep it current from
// then on, including while the page is closed. Once started it stays on for
// the session, holding the title store with it.
import { useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import { threadTitleStore } from "./thread-title-store";
import { noteReplies, readActivity } from "./thread-titles";

type Session = Pick<
  RelaySession,
  "snapshotRead" | "artifacts" | "channels" | "read" | "subscribeLive"
>;

export type ThreadActivityStore = Readonly<{
  /** By activityKey(channel, root); titled threads with a known reply only. */
  snapshot(): ReadonlyMap<string, number>;
  subscribe(listener: () => void): () => void;
  /** Reads every title and its replies again. */
  refresh(): void;
}>;

const stores = new WeakMap<Session, ThreadActivityStore>();

export function threadActivityStore(session: Session): ThreadActivityStore {
  let store = stores.get(session);
  if (!store) {
    store = createStore(session);
    stores.set(session, store);
  }
  return store;
}

export function useThreadActivity(session: Session) {
  const store = threadActivityStore(session);
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

function createStore(session: Session): ThreadActivityStore {
  const titles = threadTitleStore(session);
  const listeners = new Set<() => void>();
  const latest = new Map<string, number>();
  /** Titles whose replies were read, or are being read. */
  const read = new Set<string>();
  let snapshot: ReadonlyMap<string, number> = new Map();
  let controller = new AbortController();
  let started = false;
  const publish = () => {
    snapshot = new Map(latest);
    for (const listener of [...listeners]) listener();
  };
  const onTitles = () => {
    const current = titles.snapshot().titles;
    if (!current) return;
    let dropped = false;
    for (const key of latest.keys())
      if (!current.has(key)) dropped = latest.delete(key);
    for (const key of read) if (!current.has(key)) read.delete(key);
    if (dropped) publish();
    const fresh = [...current].filter(([key]) => !read.has(key));
    if (!fresh.length) return;
    for (const [key] of fresh) read.add(key);
    const { signal } = controller;
    readActivity(
      session,
      fresh.map(([, title]) => title),
      signal,
    ).then(
      (times) => {
        const now = titles.snapshot().titles;
        for (const [key, at] of times)
          if (now?.has(key))
            latest.set(key, Math.max(at, latest.get(key) ?? 0));
        publish();
      },
      () => {
        // Only an abort rejects; a refresh has already reset what was read.
      },
    );
  };
  const start = () => {
    started = true;
    titles.subscribe(onTitles);
    session.subscribeLive(({ events }) => {
      const current = titles.snapshot().titles;
      if (!current?.size) return;
      const keys = new Set(current.keys());
      const channels = new Set([...current.values()].map((t) => t.channel));
      // Copies only when a titled row's time actually advances.
      if (noteReplies(events, channels, keys, latest)) publish();
    });
    onTitles();
  };
  return {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      if (!started) start();
      return () => {
        listeners.delete(listener);
      };
    },
    refresh() {
      controller.abort();
      controller = new AbortController();
      read.clear();
      titles.refresh();
      onTitles();
    },
  };
}
