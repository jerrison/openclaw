import { LitElement, html, nothing, type PropertyValues } from "lit";
import { guard } from "lit/directives/guard.js";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../../components/icons.ts";
import { i18n, t } from "../../../i18n/index.ts";
import type { ChatTypingActorView, ChatTypingPreviewDemand } from "../chat-typing-presence.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import { paneDomId } from "./chat-composer-dom.ts";

const AUTO_HEIGHT = 156;
type ShelfMode = "automatic" | "folded" | "peek" | "hidden";

/** Local presentation only. The shared typing owner supplies active people. */
export class ChatTypingShelf extends LitElement {
  static override properties = {
    actors: { attribute: false },
    count: { type: Number },
    scope: { type: String },
    paneId: { type: String },
    onDemand: { attribute: false },
    previewDemand: { attribute: false },
    mode: { state: true },
  };

  actors: readonly ChatTypingActorView[] = [];
  count = 0;
  scope = "";
  paneId = "";
  onDemand?: (demand: ChatTypingPreviewDemand) => void;
  previewDemand: ChatTypingPreviewDemand = "automatic";
  private mode: ShelfMode = "automatic";
  private peekScrollTop = 0;
  private restorePeekScroll = false;
  private restoreInputFocus = false;
  private observed?: HTMLElement;
  private observer?: ResizeObserver;
  private observerScope?: string;
  private demand?: ChatTypingPreviewDemand;

  protected override createRenderRoot() {
    return this;
  }

  protected override willUpdate(changed: PropertyValues) {
    // Keep the live region mounted while the host has no visible shelf box.
    this.toggleAttribute("data-typing-active", this.count > 0);
    if (
      this.count === 0 &&
      !changed.has("scope") &&
      this.contains(this.ownerDocument.activeElement)
    ) {
      this.restoreInputFocus = true;
    }
    if (changed.has("scope")) {
      this.restoreInputFocus = false;
    }
    if (changed.has("scope") || this.count === 0) {
      this.peekScrollTop = 0;
      this.restorePeekScroll = false;
      this.mode = "automatic";
    }
    if (this.mode === "automatic" && this.count > 3) {
      this.mode = "folded";
    }
  }

  protected override updated(changed: PropertyValues) {
    const panel = this.querySelector<HTMLElement>(".agent-chat__typing-window");
    if (panel && changed.has("scope")) {
      panel.scrollTop = 0;
    }
    if (panel && this.mode === "peek" && this.previewDemand === "all" && this.restorePeekScroll) {
      panel.scrollTop = this.peekScrollTop;
      this.restorePeekScroll = false;
    }
    if (this.restoreInputFocus) {
      this.restoreInputFocus = false;
      this.closest(".agent-chat__typing-compose")
        ?.querySelector<HTMLTextAreaElement>("textarea")
        ?.focus({ preventScroll: true });
    }
    const demand = this.mode === "peek" ? "all" : this.open ? "automatic" : "hidden";
    if (demand !== this.demand) {
      this.demand = demand;
      this.onDemand?.(demand);
    }
    if (this.observed && changed.has("scope") && this.observerScope !== this.scope) {
      this.observeCurrentContent();
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.observer?.disconnect();
    this.observer = undefined;
    this.observed = undefined;
    this.demand = undefined;
    this.restoreInputFocus = false;
    this.restorePeekScroll = false;
    this.peekScrollTop = 0;
    this.mode = "automatic";
    this.onDemand?.("automatic");
  }

  private get open() {
    return this.mode === "automatic" || this.mode === "peek";
  }

  private observeContent = (element?: Element) => {
    const next = element instanceof HTMLElement ? element : undefined;
    if (next === this.observed) {
      return;
    }
    this.observer?.disconnect();
    this.observed = next;
    this.observeCurrentContent();
  };

  private observeCurrentContent() {
    this.observer?.disconnect();
    const target = this.observed;
    if (!target) {
      return;
    }
    const scope = this.scope;
    const observer = new ResizeObserver((entries) => {
      if (this.observer !== observer || this.scope !== scope || !this.isConnected) {
        return;
      }
      for (const entry of entries) {
        if (entry.target === target && this.mode === "automatic") {
          const height = entry.borderBoxSize[0]?.blockSize;
          if (height !== undefined && height >= AUTO_HEIGHT) {
            this.mode = "folded";
          }
        }
      }
    });
    this.observer = observer;
    this.observerScope = scope;
    observer.observe(target, { box: "border-box" });
  }

  private toggle = () => {
    if (this.open) {
      this.peekScrollTop = this.querySelector(".agent-chat__typing-window")?.scrollTop ?? 0;
      this.mode = "hidden";
    } else {
      this.restorePeekScroll = true;
      this.mode = "peek";
    }
  };

  private preserveInputFocus = (event: PointerEvent) => {
    const input = this.closest(".agent-chat__typing-compose")?.querySelector("textarea");
    if (event.button === 0 && input === this.ownerDocument.activeElement) {
      event.preventDefault();
    }
  };

  protected override render() {
    const sample = this.actors.slice(0, 5);
    const label = this.count ? typingSentence(sample, this.count) : undefined;
    const previews = this.mode === "peek" ? this.actors : this.actors.slice(0, 3);
    const open = this.open;
    const previewId = paneDomId(this.paneId, "typing-previews");
    return html`<span
        class="agent-chat__typing-status sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        >${label?.text ?? ""}</span
      >
      ${
        label
          ? html`<div class="agent-chat__typing-shelf" data-mode=${this.mode}>
              <div
                class="agent-chat__typing-window"
                id=${previewId}
                role="region"
                aria-label=${t("chat.sessionSuggestions.typingPreviews")}
                aria-hidden=${String(!open)}
                .inert=${!open}
                tabindex=${this.mode === "peek" ? 0 : -1}
              >
                <div class="agent-chat__typing-content" ${ref(this.observeContent)}>
                  ${repeat(
                    previews,
                    (actor) => actor.id,
                    (actor) =>
                      guard(
                        [actor, i18n.getLocale()],
                        () => html` <div
                          class="agent-chat__typing-preview"
                          data-actor-id=${actor.id}
                        >
                          <bdi class="agent-chat__typing-author" title=${actor.label}
                            >${actor.label}</bdi
                          >
                          <span class="agent-chat__typing-copy" dir="auto"
                            >${actor.preview ?? t("chat.sessionSuggestions.typingDraftState")}</span
                          >
                        </div>`,
                      ),
                  )}
                </div>
              </div>
              <button
                type="button"
                class="agent-chat__typing-toggle"
                aria-expanded=${String(open)}
                aria-controls=${previewId}
                aria-label=${(open ? t("chat.sessionSuggestions.hideTypingPreviews") : t("chat.sessionSuggestions.peekTypingPreviews")) + ": " + label.text}
                @pointerdown=${this.preserveInputFocus}
                @click=${this.toggle}
              >
                <span class="agent-chat__typing-identities" aria-hidden="true">
                  ${repeat(
                    sample,
                    (actor) => actor.id,
                    (actor) =>
                      html`<span class="agent-chat__typing-person"
                        >${renderChatAuthorAvatar({ id: actor.id, name: actor.label, identity: { type: "profile", id: actor.id } })}</span
                      >`,
                  )}
                </span>
                <span class="agent-chat__typing-summary"
                  ><span class="agent-chat__typing-text" data-typing>${label.content}</span></span
                >
                <span class="agent-chat__typing-action"
                  >${open ? t("chat.sessionSuggestions.hideTypingPreviews") : t("chat.sessionSuggestions.peekTypingPreviews")}</span
                >
                <span class="agent-chat__typing-chevron" aria-hidden="true"
                  >${open ? icons.chevronDown : icons.chevronUp}</span
                >
              </button>
            </div>`
          : nothing
      }`;
  }
}

function typingSentence(actors: readonly ChatTypingActorView[], count: number) {
  if (count >= 8) {
    const text = t("chat.sessionSuggestions.typingSeveral");
    return { text, content: text };
  }
  const names = actors.slice(0, count <= 3 ? count : 2).map((actor) => actor.label);
  const parts = [...names];
  if (count > 3) {
    parts.push(t("chat.sessionSuggestions.typingOthers", { count: String(count - 2) }));
  }
  const formatter = new Intl.ListFormat(i18n.getLocale(), { type: "conjunction", style: "long" });
  let nameIndex = 0;
  const content = formatter
    .formatToParts(parts)
    .map((part) =>
      part.type === "element" && nameIndex++ < names.length
        ? html`<bdi class="agent-chat__typing-name" title=${part.value}>${part.value}</bdi>`
        : part.value,
    );
  const key = count === 1 ? "chat.sessionSuggestions.typing" : "chat.sessionSuggestions.typingMany";
  const marker = "\u0001";
  return {
    text: t(key, { name: formatter.format(parts), names: formatter.format(parts) }),
    content: t(key, { name: marker, names: marker })
      .split(marker)
      .map((part, index) => (index ? html`${content}${part}` : part)),
  };
}

if (!customElements.get("openclaw-chat-typing-shelf")) {
  customElements.define("openclaw-chat-typing-shelf", ChatTypingShelf);
}
