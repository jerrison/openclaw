import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import { captureI18nStateForTesting } from "../../../i18n/lib/translate.test-support.ts";
import type { ChatTypingActorView, ChatTypingPreviewDemand } from "../chat-typing-presence.ts";
import { ChatTypingShelf } from "./chat-typing-shelf.ts";

class TestResizeObserver implements ResizeObserver {
  static instances: TestResizeObserver[] = [];
  observe = vi.fn<(target: Element, options?: ResizeObserverOptions) => void>();
  unobserve = vi.fn<(target: Element) => void>();
  disconnect = vi.fn<() => void>();

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }

  // jsdom has no layout. Deliver the browser-owned border box, including a
  // distinct content box, rather than making the component force a layout read.
  deliver(target: Element, blockSize: number, inlineSize = 400) {
    const contentSize = { blockSize: Math.max(0, blockSize - 2), inlineSize };
    this.callback(
      [
        {
          target,
          borderBoxSize: [{ blockSize, inlineSize }],
          contentBoxSize: [contentSize],
          devicePixelContentBoxSize: [contentSize],
          contentRect: new DOMRect(0, 0, inlineSize, contentSize.blockSize),
        },
      ],
      this,
    );
  }
}

function actors(count: number): ChatTypingActorView[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `60000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    label: `Writer ${index + 1}`,
    preview: `Draft ${index + 1}`,
  }));
}

function required(root: ParentNode, selector: string): HTMLElement {
  const element = root.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing shelf element: ${selector}`);
  }
  return element;
}

function currentObserver() {
  const observer = TestResizeObserver.instances.at(-1);
  if (!observer) {
    throw new Error("The shelf did not observe its content");
  }
  return observer;
}

function toggle(shelf: ChatTypingShelf) {
  return required(shelf, ".agent-chat__typing-toggle");
}

function expectMode(shelf: ChatTypingShelf, mode: "automatic" | "folded" | "peek" | "hidden") {
  const open = mode === "automatic" || mode === "peek";
  expect(required(shelf, ".agent-chat__typing-shelf").dataset.mode).toBe(mode);
  expect(toggle(shelf).getAttribute("aria-expanded")).toBe(String(open));
  expect(required(shelf, ".agent-chat__typing-action").textContent?.trim()).toBe(
    open ? "Hide" : "Peek",
  );
  const window = required(shelf, ".agent-chat__typing-window");
  expect(window.getAttribute("aria-hidden")).toBe(String(!open));
  expect(window.inert).toBe(!open);
}

describe("ChatTypingShelf", () => {
  let container: HTMLDivElement;
  let restoreI18n: () => Promise<void>;

  beforeEach(async () => {
    restoreI18n = captureI18nStateForTesting();
    await i18n.setLocale("en");
    TestResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    container = document.body.appendChild(document.createElement("div"));
  });

  afterEach(async () => {
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await restoreI18n();
  });

  async function mount(people: ChatTypingActorView[]) {
    const shelf = new ChatTypingShelf();
    const onDemand = vi.fn<(demand: ChatTypingPreviewDemand) => void>();
    shelf.actors = people;
    shelf.count = people.length;
    shelf.scope = "session-a";
    shelf.paneId = "pane-a";
    shelf.onDemand = onDemand;
    container.append(shelf);
    await shelf.updateComplete;
    return { shelf, onDemand };
  }

  it("keeps one polite active-people status without speaking preview edits", async () => {
    const { shelf } = await mount([]);
    const region = required(shelf, ".agent-chat__typing-status");
    expect(region.classList.contains("sr-only")).toBe(true);
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("aria-atomic")).toBe("true");
    expect(region.textContent).toBe("");
    expect(shelf.hasAttribute("data-typing-active")).toBe(false);

    const [person] = actors(1);
    if (!person) {
      throw new Error("Missing active person");
    }
    shelf.actors = [person];
    shelf.count = 1;
    await shelf.updateComplete;
    expect(required(shelf, ".agent-chat__typing-status")).toBe(region);
    expect(region.textContent).toBe("Writer 1 is typing…");
    expect(shelf.hasAttribute("data-typing-active")).toBe(true);
    expect(region.textContent).not.toContain(person.preview);

    const changes: MutationRecord[] = [];
    const observer = new MutationObserver((records) => changes.push(...records));
    observer.observe(region, { childList: true, characterData: true, subtree: true });
    shelf.actors = [{ ...person, preview: "Private draft changed" }];
    await shelf.updateComplete;
    await Promise.resolve();
    expect(changes).toEqual([]);
    expect(region.textContent).toBe("Writer 1 is typing…");
    expect(required(shelf, ".agent-chat__typing-copy").textContent).toBe("Private draft changed");
    observer.disconnect();

    shelf.actors = [];
    shelf.count = 0;
    await shelf.updateComplete;
    expect(required(shelf, ".agent-chat__typing-status")).toBe(region);
    expect(region.textContent).toBe("");
    expect(shelf.hasAttribute("data-typing-active")).toBe(false);
    shelf.scope = "session-b";
    shelf.actors = [{ ...person, id: "new-person", label: "Another writer" }];
    shelf.count = 1;
    await shelf.updateComplete;
    expect(required(shelf, ".agent-chat__typing-status")).toBe(region);
    expect(region.textContent).toBe("Another writer is typing…");
  });

  it.each([1, 2, 3])("automatically opens %i active writers", async (count) => {
    const people = actors(count);
    const { shelf, onDemand } = await mount(people);

    expectMode(shelf, "automatic");
    expect(shelf.shadowRoot).toBeNull();
    expect(
      [...shelf.querySelectorAll(".agent-chat__typing-copy")].map((copy) => copy.textContent),
    ).toEqual(people.map((actor) => actor.preview));
    expect(toggle(shelf).getAttribute("aria-controls")).toBe(
      required(shelf, ".agent-chat__typing-window").id,
    );
    expect(onDemand.mock.calls).toEqual([["automatic"]]);
    expect(currentObserver().observe).toHaveBeenCalledWith(
      required(shelf, ".agent-chat__typing-content"),
      { box: "border-box" },
    );
  });

  it("folds at the 156px border-box boundary after wrapping changes without reading layout", async () => {
    const layoutRead = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    const { shelf, onDemand } = await mount(actors(3));
    const content = required(shelf, ".agent-chat__typing-content");
    const observer = currentObserver();

    observer.deliver(content, 155.999, 500);
    await shelf.updateComplete;
    expectMode(shelf, "automatic");

    // A narrower viewport can wrap unchanged drafts up to the CSS-clamped height.
    observer.deliver(content, 156, 240);
    await shelf.updateComplete;
    expectMode(shelf, "folded");
    expect(onDemand.mock.calls).toEqual([["automatic"], ["hidden"]]);

    observer.deliver(content, 80, 700);
    await shelf.updateComplete;
    expectMode(shelf, "folded");
    expect(layoutRead).not.toHaveBeenCalled();
  });

  it("folds four writers and stays folded when the count drops to three", async () => {
    const { shelf, onDemand } = await mount(actors(3));
    shelf.actors = actors(4);
    shelf.count = 4;
    await shelf.updateComplete;
    expectMode(shelf, "folded");

    shelf.actors = shelf.actors.slice(0, 3);
    shelf.count = 3;
    await shelf.updateComplete;
    currentObserver().deliver(required(shelf, ".agent-chat__typing-content"), 60);
    await shelf.updateComplete;
    expectMode(shelf, "folded");
    expect(onDemand.mock.calls).toEqual([["automatic"], ["hidden"]]);
  });

  it("demands every full draft on Peek, never auto-folds it, and preserves a later Hide", async () => {
    const people = actors(6);
    const { shelf, onDemand } = await mount(people);
    expectMode(shelf, "folded");
    expect(onDemand.mock.calls).toEqual([["hidden"]]);

    toggle(shelf).click();
    await shelf.updateComplete;
    expectMode(shelf, "peek");
    expect(onDemand.mock.calls).toEqual([["hidden"], ["all"]]);

    const fullDrafts = people.map((actor) => ({
      id: actor.id,
      label: actor.label,
      preview: `${actor.label}: ${"A complete untruncated draft. ".repeat(8)}\nFinal line.`,
    }));
    shelf.actors = fullDrafts;
    await shelf.updateComplete;
    expect(
      [...shelf.querySelectorAll(".agent-chat__typing-copy")].map((copy) => copy.textContent),
    ).toEqual(fullDrafts.map((actor) => actor.preview));
    expect(required(shelf, ".agent-chat__typing-window").tabIndex).toBe(0);

    const content = required(shelf, ".agent-chat__typing-content");
    currentObserver().deliver(content, 1_500);
    await shelf.updateComplete;
    expectMode(shelf, "peek");
    expect(onDemand.mock.calls).toEqual([["hidden"], ["all"]]);

    toggle(shelf).click();
    await shelf.updateComplete;
    expectMode(shelf, "hidden");
    shelf.actors = fullDrafts.map((actor) => ({
      id: actor.id,
      label: actor.label,
      preview: `${actor.preview} More.`,
    }));
    await shelf.updateComplete;
    currentObserver().deliver(content, 60);
    await shelf.updateComplete;
    expectMode(shelf, "hidden");
    expect(onDemand.mock.calls).toEqual([["hidden"], ["all"], ["hidden"]]);
  });

  it("keeps manual Hide through draft and membership changes from automatic mode", async () => {
    const { shelf, onDemand } = await mount(actors(2));
    toggle(shelf).click();
    await shelf.updateComplete;
    expectMode(shelf, "hidden");

    shelf.actors = actors(3).map((actor) => ({
      id: actor.id,
      label: actor.label,
      preview: "Changed draft",
    }));
    shelf.count = 3;
    await shelf.updateComplete;
    currentObserver().deliver(required(shelf, ".agent-chat__typing-content"), 156);
    await shelf.updateComplete;
    expectMode(shelf, "hidden");
    expect(onDemand.mock.calls).toEqual([["automatic"], ["hidden"]]);
  });

  it.each(["folded", "hidden", "peek"] as const)(
    "resets %s to automatic after all active writers leave",
    async (mode) => {
      const { shelf, onDemand } = await mount(actors(mode === "hidden" ? 2 : 4));
      if (mode !== "folded") {
        toggle(shelf).click();
        await shelf.updateComplete;
      }
      expectMode(shelf, mode);
      const observer = currentObserver();
      const content = required(shelf, ".agent-chat__typing-content");

      shelf.count = 0;
      shelf.actors = [];
      await shelf.updateComplete;
      expect(shelf.querySelector(".agent-chat__typing-shelf")).toBeNull();
      expect(observer.disconnect).toHaveBeenCalled();
      expect(onDemand).toHaveBeenLastCalledWith("automatic");

      shelf.actors = actors(1);
      shelf.count = 1;
      await shelf.updateComplete;
      observer.deliver(content, 156);
      await shelf.updateComplete;
      expectMode(shelf, "automatic");
      expect(currentObserver()).not.toBe(observer);
    },
  );

  it.each(["folded", "hidden", "peek"] as const)(
    "resets %s when the session context changes",
    async (mode) => {
      const { shelf, onDemand } = await mount(actors(mode === "hidden" ? 2 : 4));
      if (mode !== "folded") {
        toggle(shelf).click();
        await shelf.updateComplete;
      }
      expectMode(shelf, mode);

      shelf.scope = "session-b";
      shelf.actors = actors(2);
      shelf.count = 2;
      await shelf.updateComplete;
      expectMode(shelf, "automatic");
      expect(onDemand).toHaveBeenLastCalledWith("automatic");
    },
  );

  it("keeps preview and avatar DOM for unchanged actors across updates and reordering", async () => {
    const people = actors(3);
    const { shelf, onDemand } = await mount(people);
    const previews = [...shelf.querySelectorAll(".agent-chat__typing-preview")];
    const copies = previews.map((preview) => required(preview, ".agent-chat__typing-copy"));
    const avatars = [...shelf.querySelectorAll(".chat-author-avatar")];
    const images = avatars.map((avatar) => required(avatar, "img"));
    expect(previews).toHaveLength(3);
    expect(avatars).toHaveLength(3);

    shelf.actors = [...people];
    await shelf.updateComplete;
    for (const [index, preview] of previews.entries()) {
      expect(shelf.querySelectorAll(".agent-chat__typing-preview")[index]).toBe(preview);
      expect(required(preview, ".agent-chat__typing-copy")).toBe(copies[index]);
      expect(shelf.querySelectorAll(".chat-author-avatar")[index]).toBe(avatars[index]);
      const avatar = avatars[index];
      if (!avatar) {
        throw new Error("Missing stable identity avatar");
      }
      expect(required(avatar, "img")).toBe(images[index]);
    }

    shelf.actors = people.toReversed();
    await shelf.updateComplete;
    for (const [index, preview] of previews.entries()) {
      expect(shelf.querySelectorAll(".agent-chat__typing-preview")[2 - index]).toBe(preview);
      expect(shelf.querySelectorAll(".chat-author-avatar")[2 - index]).toBe(avatars[index]);
    }
    expect(onDemand.mock.calls).toEqual([["automatic"]]);
  });

  it("replaces the observer on context changes and ignores obsolete deliveries even after returning", async () => {
    const { shelf } = await mount(actors(2));
    const original = currentObserver();
    const content = required(shelf, ".agent-chat__typing-content");

    shelf.scope = "session-b";
    original.deliver(content, 156);
    await shelf.updateComplete;
    expectMode(shelf, "automatic");
    expect(original.disconnect).toHaveBeenCalled();
    const second = currentObserver();
    expect(second).not.toBe(original);
    expect(second.observe).toHaveBeenCalledWith(content, { box: "border-box" });

    shelf.scope = "session-a";
    await shelf.updateComplete;
    const current = currentObserver();
    expect(current).not.toBe(second);
    expect(second.disconnect).toHaveBeenCalled();
    original.deliver(content, 156);
    second.deliver(content, 156);
    await shelf.updateComplete;
    expectMode(shelf, "automatic");

    current.deliver(content, 156);
    await shelf.updateComplete;
    expectMode(shelf, "folded");
  });

  it("disconnects its observer and releases demand when removed", async () => {
    const { shelf, onDemand } = await mount(actors(2));
    const observer = currentObserver();
    const content = required(shelf, ".agent-chat__typing-content");
    toggle(shelf).click();
    await shelf.updateComplete;
    expect(onDemand).toHaveBeenLastCalledWith("hidden");

    shelf.remove();
    expect(observer.disconnect).toHaveBeenCalled();
    expect(onDemand).toHaveBeenLastCalledWith("automatic");
    observer.deliver(content, 156);
    container.append(shelf);
    await shelf.updateComplete;
    expectMode(shelf, "automatic");
    expect(currentObserver()).not.toBe(observer);
  });
  it("restores Peek scroll only after the full projection arrives and resets it on context change", async () => {
    const people = actors(8);
    const { shelf } = await mount(people);
    shelf.previewDemand = "hidden";
    toggle(shelf).click();
    shelf.previewDemand = "all";
    await shelf.updateComplete;
    const panel = required(shelf, ".agent-chat__typing-window");
    panel.scrollTop = 120;
    toggle(shelf).click();
    shelf.previewDemand = "hidden";
    await shelf.updateComplete;
    // Model the browser clamping a collapsed, bounded hidden projection.
    panel.scrollTop = 0;
    toggle(shelf).click();
    await shelf.updateComplete;
    expect(panel.scrollTop).toBe(0);
    shelf.previewDemand = "all";
    await shelf.updateComplete;
    expect(panel.scrollTop).toBe(120);
    shelf.scope = "replacement-context";
    await shelf.updateComplete;
    expect(panel.scrollTop).toBe(0);
    expectMode(shelf, "folded");
  });

  it("returns keyboard focus to the unchanged editor when the last active person leaves", async () => {
    container.className = "agent-chat__typing-compose";
    const input = document.createElement("textarea");
    input.value = "Keep this local draft";
    container.append(input);
    const { shelf } = await mount(actors(1));
    input.focus();
    input.setSelectionRange(2, 7);
    toggle(shelf).focus();
    shelf.actors = [];
    shelf.count = 0;
    await shelf.updateComplete;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Keep this local draft");
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]);
  });
});
