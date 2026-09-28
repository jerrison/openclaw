import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";
import { withBrowserPage } from "../test-helpers/browser-page.ts";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeShimmer = canRunPlaywrightChromium(chromiumExecutablePath) ? describe : describe.skip;

let browser: Browser;

beforeAll(async () => {
  if (!canRunPlaywrightChromium(chromiumExecutablePath)) {
    return;
  }
  browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
});

afterAll(async () => {
  await browser?.close().catch(() => {});
});

describeShimmer("Control UI shimmer", () => {
  it("moves loading highlights on compositor-safe pseudo-elements", async () => {
    await withBrowserPage(browser.newPage(), async (page) => {
      await page.setContent(`<!doctype html><html><head><style>
        ${readStyleSheet("ui/src/styles/base.css")}
        ${readStyleSheet("ui/src/styles/chat/layout.css")}
        ${readStyleSheet("ui/src/styles/chat/composer.css")}
        ${readStyleSheet("ui/src/styles/memory-import.css")}
        ${readStyleSheet("ui/src/styles/usage.css")}
      </style></head><body>
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton usage-skeleton-block"></div>
        <div class="skeleton memory-import__skeleton"></div>
        <div class="skeleton chat-controls__model-trigger-skeleton"></div>
      </body></html>`);

      for (const [selector, duration] of [
        [".skeleton-line", "1.5s"],
        [".usage-skeleton-block", "1.35s"],
        [".memory-import__skeleton", "1.4s"],
        [".chat-controls__model-trigger-skeleton", "1.45s"],
      ] as const) {
        const styles = await page.locator(selector).evaluate((element) => {
          const host = getComputedStyle(element);
          const highlight = getComputedStyle(element, "::after");
          const animation = element.getAnimations({ subtree: true })[0];
          const keyframes =
            animation?.effect instanceof KeyframeEffect ? animation.effect.getKeyframes() : [];
          const animatedProperties = new Set(
            keyframes.flatMap((frame) =>
              Object.keys(frame).filter(
                (key) => !["composite", "computedOffset", "easing", "offset"].includes(key),
              ),
            ),
          );
          return {
            hostAnimation: host.animationName,
            hostBackground: host.backgroundImage,
            hostOverflow: host.overflow,
            highlightAnimation: highlight.animationName,
            highlightBackground: highlight.backgroundImage,
            highlightDuration: highlight.animationDuration,
            highlightIterations: highlight.animationIterationCount,
            highlightWillChange: highlight.willChange,
            animatedProperties: [...animatedProperties],
          };
        });

        expect(styles).toMatchObject({
          hostAnimation: "none",
          hostBackground: "none",
          hostOverflow: "hidden",
          highlightAnimation: "shimmer",
          highlightDuration: duration,
          highlightIterations: "infinite",
          highlightWillChange: "transform",
          animatedProperties: ["transform"],
        });
        expect(styles.highlightBackground).toContain("linear-gradient");
      }
    });
  });

  it("never starts loading animations with reduced motion", async () => {
    await withBrowserPage(browser.newPage({ reducedMotion: "reduce" }), async (page) => {
      await page.setContent(`<!doctype html><html><head><style>
        ${readStyleSheet("ui/src/styles/base.css")}
        ${readStyleSheet("ui/src/styles/chat/layout.css")}
        ${readStyleSheet("ui/src/styles/chat/composer.css")}
        ${readStyleSheet("ui/src/styles/memory-import.css")}
        ${readStyleSheet("ui/src/styles/usage.css")}
      </style></head><body>
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton usage-skeleton-block"></div>
        <div class="skeleton memory-import__skeleton"></div>
        <div class="skeleton chat-controls__model-trigger-skeleton"></div>
      </body></html>`);

      for (const selector of [
        ".skeleton-line",
        ".usage-skeleton-block",
        ".memory-import__skeleton",
        ".chat-controls__model-trigger-skeleton",
      ]) {
        const animation = await page.locator(selector).evaluate((element) => {
          const highlight = getComputedStyle(element, "::after");
          return {
            name: highlight.animationName,
            duration: highlight.animationDuration,
            iterations: highlight.animationIterationCount,
            running: element
              .getAnimations({ subtree: true })
              .some((item) => item.playState === "running"),
            settledTransform: highlight.transform,
            width: element.clientWidth,
          };
        });

        expect(animation.name).toBe("none");
        expect(animation.iterations).toBe("1");
        expect(Number.parseFloat(animation.duration)).toBeLessThanOrEqual(0.00001);
        expect(animation.running).toBe(false);
        // Without an animation, the highlight must stay parked offscreen.
        const settledX = Number.parseFloat(animation.settledTransform.split(",")[4] ?? "NaN");
        expect(Math.abs(settledX + animation.width)).toBeLessThanOrEqual(1);
      }
    });
  });
  it("aligns intrinsic typing stacks and shimmers only active text, including names", async () => {
    await withBrowserPage(browser.newPage({ reducedMotion: "no-preference" }), async (page) => {
      for (const count of [1, 2, 5]) {
        await page.setContent(
          "<style>" +
            readStyleSheet("ui/src/styles/base.css") +
            readStyleSheet("ui/src/styles/chat/grouped.css") +
            '</style><div style="padding:16px;width:360px"><span id="preview">A</span>' +
            '<span class="agent-chat__typing-state agent-chat__typing-text" data-typing>is typing…</span>' +
            '<span id="draft" class="agent-chat__typing-state agent-chat__typing-text">Draft</span>' +
            '<div class="agent-chat__typing-toggle"><span class="agent-chat__typing-identities">' +
            '<span class="agent-chat__typing-person">C</span>'.repeat(count) +
            '</span><span class="agent-chat__typing-summary"><span class="agent-chat__typing-text" data-typing><bdi class="agent-chat__typing-name">Camila</bdi> is typing…</span></span></div>' +
            '<span class="agent-chat__typing-text" data-typing>Several people are typing…</span></div>',
        );
        const result = await page.evaluate(() => {
          const first = document.querySelector(".agent-chat__typing-person");
          const stack = document.querySelector(".agent-chat__typing-identities");
          const summary = document.querySelector(".agent-chat__typing-summary");
          const preview = document.querySelector("#preview");
          if (!first || !stack || !summary || !preview) {
            throw new Error("Missing typing fixture");
          }
          return {
            offset: first.getBoundingClientRect().x - preview.getBoundingClientRect().x,
            gap: summary.getBoundingClientRect().x - stack.getBoundingClientRect().right,
            width: stack.getBoundingClientRect().width,
            animated: [...document.querySelectorAll(".agent-chat__typing-text[data-typing]")].map(
              (e) => getComputedStyle(e).animationName,
            ),
            draftAnimation: getComputedStyle(document.querySelector("#draft") ?? preview)
              .animationName,
            nameFill: getComputedStyle(
              document.querySelector(".agent-chat__typing-name") ?? preview,
            ).webkitTextFillColor,
            avatarAnimations: first.getAnimations({ subtree: true }).length,
          };
        });
        expect(result.offset).toBe(0);
        expect(result.gap).toBe(8);
        expect(result.width).toBe(20 + (count - 1) * 14);
        expect(result.animated).toEqual(["text-shimmer", "text-shimmer", "text-shimmer"]);
        expect(result.draftAnimation).toBe("none");
        expect(result.nameFill).toBe("rgba(0, 0, 0, 0)");
        expect(result.avatarAnimations).toBe(0);
      }
      await page.emulateMedia({ reducedMotion: "reduce" });
      const staticText = await page.locator(".agent-chat__typing-text").evaluateAll((elements) =>
        elements.map((e) => ({
          animation: getComputedStyle(e).animationName,
          background: getComputedStyle(e).backgroundImage,
          fill: getComputedStyle(e).webkitTextFillColor,
        })),
      );
      for (const text of staticText) {
        expect(text.animation).toBe("none");
        expect(text.background).toBe("none");
        expect(text.fill).not.toBe("rgba(0, 0, 0, 0)");
      }
      await page.emulateMedia({ reducedMotion: "no-preference", forcedColors: "active" });
      const forced = await page.locator(".agent-chat__typing-text").evaluateAll((elements) =>
        elements.map((e) => ({
          animation: getComputedStyle(e).animationName,
          fill: getComputedStyle(e).webkitTextFillColor,
        })),
      );
      for (const text of forced) {
        expect(text.animation).toBe("none");
        expect(text.fill).not.toBe("rgba(0, 0, 0, 0)");
      }
    });
  });
  it("keeps a crowded short editor reachable while the manual shelf yields space", async () => {
    await withBrowserPage(
      browser.newPage({ viewport: { width: 900, height: 500 } }),
      async (page) => {
        await page.setContent(
          "<style>" +
            [
              "base",
              "chat/startup-layout",
              "chat/message-layout",
              "chat/grouped",
              "chat/composer-surface",
            ]
              .map((name) => readStyleSheet("ui/src/styles/" + name + ".css"))
              .join("\n") +
            '</style><div class="chat" style="position:absolute;inset:56px 0 0;height:calc(100% - 56px)"><div class="chat-main__conversation"><div class="chat-thread"><div style="height:1000px">History</div></div><div class="chat-footer"><div class="agent-chat__composer-shell"><div class="chat-footer__context"><div style="height:200px">Outbox</div></div><div class="agent-chat__typing-compose"><openclaw-chat-typing-shelf data-typing-active><span class="agent-chat__typing-status sr-only" role="status" aria-live="polite" aria-atomic="true"></span><div class="agent-chat__typing-shelf" data-mode="peek"><div class="agent-chat__typing-window"><div class="agent-chat__typing-content" style="height:1000px">Full previews</div></div><button class="agent-chat__typing-toggle">Hide</button></div></openclaw-chat-typing-shelf><div class="agent-chat__input"><div class="agent-chat__composer-lede"><div style="height:180px;flex-shrink:0">Reply, mentions and attachments</div></div><div class="agent-chat__composer-input-row"><div class="agent-chat__composer-combobox"><textarea style="height:48px">Local draft</textarea></div></div><div class="agent-chat__composer-footer"><button>Send</button></div></div></div></div></div></div></div>',
        );
        const measure = () =>
          page.evaluate(() => {
            const input = document.querySelector("textarea");
            const panel = document.querySelector(".agent-chat__typing-window");
            const shelf = document.querySelector("openclaw-chat-typing-shelf");
            const editor = document.querySelector(".agent-chat__input");
            const conversation = document.querySelector(".chat-main__conversation");
            if (!input || !conversation) {
              throw new Error("Missing layout fixture");
            }
            return {
              input: input.getBoundingClientRect().toJSON(),
              panel: panel?.getBoundingClientRect().height,
              shelfHeight: shelf?.getBoundingClientRect().height,
              editorRadius: editor ? getComputedStyle(editor).borderTopLeftRadius : null,
              scroll: conversation.scrollTop,
              viewport: innerHeight,
            };
          });
        const peek = await measure();
        expect(peek.input.bottom).toBeLessThanOrEqual(peek.viewport);
        expect(peek.input.top).toBeGreaterThanOrEqual(56);
        expect(peek.panel).toBeGreaterThan(0);
        expect(peek.panel).toBeLessThanOrEqual(200);
        expect(peek.shelfHeight).toBeGreaterThan(0);
        expect(peek.editorRadius).toBe("0px");
        expect(peek.scroll).toBe(0);
        await page.locator("openclaw-chat-typing-shelf").evaluate((e) => {
          const status = e.querySelector(".agent-chat__typing-status");
          if (!status) {
            throw new Error("Missing persistent typing announcement");
          }
          e.removeAttribute("data-typing-active");
          e.replaceChildren(status);
        });
        const empty = await measure();
        expect(empty.shelfHeight).toBe(0);
        expect(empty.editorRadius).not.toBe("0px");
        expect(empty.input.bottom).toBe(peek.input.bottom);
        expect(empty.scroll).toBe(0);
      },
    );
  });
});
