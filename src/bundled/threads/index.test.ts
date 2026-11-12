import { expect, it, vi } from "vitest";
import { apply } from "./index";
import manifest from "./manifest.json";

it("registers the Threads page, a shortcut that opens it and the timeline title", () => {
  const shortcuts = { register: vi.fn() };
  const pages = { register: vi.fn() };
  const conversation = { registerAccessory: vi.fn() };
  const open = vi.fn();
  apply({
    pages,
    relay: {},
    navigation: { open },
    shortcuts,
    conversation,
  } as unknown as Parameters<typeof apply>[0]);
  expect(conversation.registerAccessory.mock.calls[0]?.[0]).toMatchObject({
    id: "thread-title",
    placement: "message",
  });
  const [shortcut] = shortcuts.register.mock.calls[0] ?? [];
  // Activity owns Cmd+Shift+T.
  expect(shortcut).toMatchObject({
    title: "Open Threads",
    binding: { key: "h", mod: true, shift: true },
    allowInEditable: true,
  });
  shortcut.run();
  expect(open).toHaveBeenCalledExactlyOnceWith({
    version: 1,
    kind: "page",
    pluginId: manifest.id,
    pageId: "threads",
  });
  expect(pages.register.mock.calls[0]?.[0]).toMatchObject({
    id: "threads",
    title: "Threads",
    primary: true,
  });
  expect(manifest).not.toHaveProperty("host");
});
