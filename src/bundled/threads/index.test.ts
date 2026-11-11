import { expect, it, vi } from "vitest";
import { apply } from "./index";
import manifest from "./manifest.json";

it("registers the Threads page and a shortcut that opens it", () => {
  const shortcuts = { register: vi.fn() };
  const pages = { register: vi.fn() };
  const open = vi.fn();
  apply({
    pages,
    relay: {},
    navigation: { open },
    shortcuts,
  } as unknown as Parameters<typeof apply>[0]);
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
