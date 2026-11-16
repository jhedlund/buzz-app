import type { PluginModule } from "../../plugins/api";
import { ThreadsBadge } from "./ThreadsBadge";
import { ThreadsPage } from "./ThreadsPage";
import { TitleAccessory } from "./TitleAccessory";

export const inject = [
  "pages",
  "relay",
  "navigation",
  "shortcuts",
  "conversation",
];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const navigator = ctx.navigation;
  // Activity owns Cmd+Shift+T (its threads filter).
  ctx.shortcuts.register({
    id: "open-threads-page",
    title: "Open Threads",
    binding: { key: "h", mod: true, shift: true },
    order: 10,
    allowInEditable: true,
    run: () => {
      void navigator.open({
        version: 1,
        kind: "page",
        pluginId: "buzz.threads",
        pageId: "threads",
      });
    },
  });
  ctx.pages.register({
    id: "threads",
    title: "Threads",
    layout: "workspace",
    primary: true,
    badge: () => <ThreadsBadge relay={relay} />,
    component: () => <ThreadsPage relay={relay} navigator={navigator} />,
  });
  ctx.conversation.registerAccessory({
    id: "thread-title",
    title: "Thread title",
    placement: "message",
    component: TitleAccessory,
  });
};
