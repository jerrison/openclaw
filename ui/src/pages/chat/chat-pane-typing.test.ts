/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-typing.test/"} */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "./chat-pane.test-support.ts";
import { composerDraftKey } from "./components/chat-composer-state.ts";
import { ChatTypingShelf } from "./components/chat-typing-shelf.ts";
import { scheduleCommittedChatScroll } from "./scroll.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createTypingPane() {
  const request = vi.fn().mockResolvedValue({ ok: true, broadcast: true });
  const fixture = createTestChatPane({
    client: createGatewayBrowserClientFixture({ request }),
    sessions: createSessionCapabilityFixture(),
  });
  const { pane, state } = fixture;
  pane.presencePayload = { presence: [{ user: { id: "owner" } }, { user: { id: "alice" } }] };
  state.sessionKey = "agent:work:main";
  state.assistantAgentId = "work";
  state.agentsList = { defaultId: "main", mainKey: "main", scope: "global", agents: [] };
  state.sessionsResultAgentId = "work";
  const row: GatewaySessionRow = {
    key: "global",
    kind: "global",
    sessionId: "session-a",
    updatedAt: 1,
    visibility: "shared",
    sharingRole: "owner",
  };
  state.sessionsResult = {
    ts: 1,
    count: 1,
    path: "",
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [row],
  };
  return { ...fixture, request, row };
}

describe("chat pane typing presence", () => {
  it("updates the mounted shelf without rerendering the pane for ordinary preview edits", async () => {
    const { pane, state, row } = createTypingPane();
    const shelf = new ChatTypingShelf();
    shelf.paneId = pane.presentationId;
    shelf.scope = `${composerDraftKey({ currentAgentId: "work", sessionKey: state.sessionKey })}:0`;
    pane.append(shelf);
    shelf.connectedCallback();
    await shelf.updateComplete;
    const paneUpdates = vi.spyOn(pane, "requestUpdate");
    paneUpdates.mockClear();
    const emit = (preview: string) =>
      pane.handleSessionTypingEvent({
        sessionKey: state.sessionKey,
        sessionId: row.sessionId!,
        agentId: "work",
        actor: { type: "human", id: "alice", label: "Alice" },
        typing: true,
        preview,
        ts: 1,
      });
    emit("First received draft");
    await shelf.updateComplete;
    expect(shelf.querySelector(".agent-chat__typing-copy")?.textContent).toBe(
      "First received draft",
    );
    paneUpdates.mockClear();
    emit("Second received draft");
    await shelf.updateComplete;
    expect(shelf.querySelector(".agent-chat__typing-copy")?.textContent).toBe(
      "Second received draft",
    );
    expect(paneUpdates).not.toHaveBeenCalled();
    shelf.scope = "stale-session:0";
    emit("New context must wait for the pane");
    expect(paneUpdates).toHaveBeenCalled();
    expect(shelf.querySelector(".agent-chat__typing-copy")?.textContent).toBe(
      "Second received draft",
    );
    shelf.disconnectedCallback();
  });

  it.each(["auto", "manual"] as const)(
    "remote shelf activity preserves pending %s scroll intent",
    (source) => {
      vi.useFakeTimers();
      const { pane, state } = createTestChatPane({
        client: { request: vi.fn() } as unknown as GatewayBrowserClient,
        sessions: {} as SessionCapability,
      });
      state.sessionKey = "agent:main:main";
      state.sessionsResult = {
        count: 1,
        path: "",
        sessions: [
          { key: state.sessionKey, kind: "direct", sessionId: "typing-scroll", updatedAt: 1 },
        ],
      } as never;
      pane.presencePayload = {
        presence: [{ user: { id: "owner" } }, { user: { id: "writer" } }],
      };
      const scrollport = document.createElement("div");
      let extent = 2000;
      Object.defineProperties(scrollport, {
        scrollHeight: { get: () => extent },
        clientHeight: { value: 500 },
      });
      scrollport.scrollTop = 1500;
      state.chatScrollElement = () => scrollport;
      state.chatScrollToEnd = () => {
        scrollport.scrollTop = scrollport.scrollHeight - scrollport.clientHeight;
        return true;
      };
      state.chatHasAutoScrolled = true;
      state.chatUserNearBottom = true;
      scheduleCommittedChatScroll(state, false, true, { source });
      const typing = {
        sessionKey: state.sessionKey,
        sessionId: "typing-scroll",
        agentId: "main",
        actor: { type: "human", id: "writer", label: "Writer" },
        typing: true,
        preview: "A draft that has not been submitted",
        ts: 1,
      } as const;
      pane.handleSessionTypingEvent(typing);
      expect(pane.typingActorViews()).toHaveLength(1);
      extent += 83;
      vi.advanceTimersToNextFrame();
      expect(scrollport.scrollTop).toBe(1583);
      scheduleCommittedChatScroll(state, false, false, { source: "manual" });
      vi.advanceTimersToNextFrame();
      expect(scrollport.scrollTop).toBe(1583);
      pane.handleSessionTypingEvent({ ...typing, preview: "Updated draft" });
      scheduleCommittedChatScroll(state, false, false);
      extent += 83;
      vi.advanceTimersToNextFrame();
      expect(scrollport.scrollTop).toBe(1666);
    },
  );

  it("sender provenance clears only the exact profile sender and expires remaining actors", () => {
    vi.useFakeTimers();
    const { pane, state } = createTestChatPane({
      client: { request: vi.fn() } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    state.sessionKey = "agent:work:main";
    state.assistantAgentId = "work";
    state.agentsList = { defaultId: "main", mainKey: "main", scope: "global", agents: [] };
    state.sessionsResultAgentId = "work";
    const aliceId = "0d9f4c35-d221-49da-9a3f-b8c73921066b";
    pane.presencePayload = {
      presence: [{ user: { id: "owner" } }, { user: { id: aliceId } }, { user: { id: "bob" } }],
    };
    state.sessionsResult = {
      count: 1,
      path: "",
      sessions: [
        {
          key: "global",
          kind: "global",
          sessionId: "session-a",
          updatedAt: 1,
        } as GatewaySessionRow,
      ],
    } as never;
    for (const actor of [
      { id: aliceId, label: "Alice", preview: "Alice's ephemeral draft" },
      { id: "bob", label: "Bob" },
    ]) {
      pane.handleSessionTypingEvent({
        sessionKey: state.sessionKey,
        sessionId: "session-a",
        agentId: "work",
        actor: { type: "human", ...actor },
        typing: true,
        ...(actor.preview ? { preview: actor.preview } : {}),
        ts: 1,
      });
    }
    expect(pane.typingActorViews()).toEqual([
      { id: aliceId, label: "Alice", preview: "Alice's ephemeral draft" },
      { id: "bob", label: "Bob" },
    ]);

    const event = (message: unknown, sessionKey = state.sessionKey) => ({
      sessionKey,
      agentId: "work",
      message,
    });
    pane.clearTypingActorForSessionMessage(
      event({ role: "user", senderLabel: `Alice (${aliceId})` }),
    );
    pane.clearTypingActorForSessionMessage(
      event({ role: "assistant", __openclaw: { senderId: aliceId } }),
    );
    pane.clearTypingActorForSessionMessage(
      event({ role: "user", __openclaw: { senderId: aliceId } }, "agent:work:other"),
    );
    expect([...pane.typingActors.keys()]).toEqual([aliceId, "bob"]);

    pane.clearTypingActorForSessionMessage(
      event({ role: "user", __openclaw: { senderId: aliceId } }),
    );
    pane.clearTypingActorForSessionMessage(
      event({
        role: "user",
        __openclaw: {
          senderId: aliceId,
          senderIdentity: {
            type: "observation",
            id: aliceId,
            pluginId: "channel",
            accountId: null,
            senderKind: "unknown",
          },
        },
      }),
    );
    expect([...pane.typingActors.keys()]).toEqual([aliceId, "bob"]);
    pane.clearTypingActorForSessionMessage(
      event({
        role: "user",
        __openclaw: { senderId: aliceId, senderIdentity: { type: "profile", id: aliceId } },
      }),
    );
    expect([...pane.typingActors.keys()]).toEqual(["bob"]);

    vi.advanceTimersByTime(2_500);
    expect(pane.typingActors.size).toBe(0);
  });

  it("projects only active actors, keeps three previews automatic and exposes all immediately on Peek", () => {
    vi.useFakeTimers();
    const { pane, state, row } = createTypingPane();
    const emit = (id: string, preview: string) =>
      pane.handleSessionTypingEvent({
        sessionKey: state.sessionKey,
        sessionId: row.sessionId!,
        agentId: "work",
        actor: { type: "human", id, label: id },
        typing: true,
        preview,
        ts: 1,
      });
    for (let i = 0; i < 25; i++) {
      emit(String(i), "Full received preview " + i);
    }
    expect(pane.typingCount).toBe(25);
    expect(pane.typingActorViews()).toHaveLength(5);
    expect(pane.typingActorViews().filter((actor) => actor.preview)).toHaveLength(3);
    const prior = pane.typingActorViews();
    const updates = vi.spyOn(pane, "requestUpdate");
    updates.mockClear();
    for (let i = 0; i < 100; i++) {
      emit("24", "Hidden update " + i);
    }
    expect(pane.typingActorViews()).toBe(prior);
    expect(updates).not.toHaveBeenCalled();
    pane.setTypingPreviewDemand("all");
    expect(pane.typingActorViews()).toHaveLength(25);
    expect(pane.typingActorViews()[24]?.preview).toBe("Hidden update 99");
    const peek = pane.typingActorViews();
    emit("1", "Changed available text");
    expect(pane.typingActorViews()[0]).toBe(peek[0]);
    expect(pane.typingActorViews()[1]).not.toBe(peek[1]);
    expect(pane.typingActorViews()[24]).toBe(peek[24]);
    pane.setTypingPreviewDemand("hidden");
    expect(pane.typingActorViews()).toHaveLength(5);
    expect(pane.typingActorViews().every((actor) => actor.preview === undefined)).toBe(true);
    updates.mockClear();
    emit("0", "Not projected while hidden");
    expect(updates).not.toHaveBeenCalled();
    pane.setTypingPreviewDemand("all");
    expect(pane.typingActorViews()[0]?.preview).toBe("Not projected while hidden");
  });

  it("hides inactive people at the existing owner transition while retaining owner cleanup", () => {
    vi.useFakeTimers();
    const { pane, state, row } = createTypingPane();
    const event = {
      sessionKey: state.sessionKey,
      sessionId: row.sessionId!,
      agentId: "work",
      actor: { type: "human", id: "alice", label: "Alice" },
      typing: true,
      preview: "Full available text",
      ts: 1,
    } as const;
    pane.handleSessionTypingEvent(event);
    vi.advanceTimersByTime(9_999);
    expect(pane.typingCount).toBe(1);
    vi.advanceTimersByTime(1);
    expect(pane.typingCount).toBe(0);
    expect(pane.typingActorViews()).toEqual([]);
    expect(pane.typingActors.get("alice")?.paused).toBe(true);
    vi.advanceTimersByTime(20_000);
    expect(pane.typingActors.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renews a hidden retained actor as active and resets demand on context cleanup", () => {
    vi.useFakeTimers();
    const { pane, state, row } = createTypingPane();
    const emit = (id: string) =>
      pane.handleSessionTypingEvent({
        sessionKey: state.sessionKey,
        sessionId: row.sessionId!,
        agentId: "work",
        actor: { type: "human", id, label: id },
        typing: true,
        preview: id + " full received preview",
        ts: 1,
      });
    for (let i = 0; i < 25; i++) {
      emit(String(i));
    }
    vi.advanceTimersByTime(10_000);
    emit("24");
    expect(pane.typingCount).toBe(1);
    expect(pane.typingActorViews().map((actor) => actor.id)).toEqual(["24"]);
    pane.setTypingPreviewDemand("all");
    const context = pane.typingContextVersion;
    pane.clearTypingActors();
    expect(pane.typingContextVersion).toBe(context + 1);
    expect(pane.typingCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    for (let i = 0; i < 25; i++) {
      emit(String(i));
    }
    expect(pane.typingActorViews()).toHaveLength(5);
    expect(pane.typingActorViews().filter((actor) => actor.preview)).toHaveLength(3);
  });

  it.each(["disconnect", "leave", "unqualified"] as const)(
    "retires a paused draft on %s without removing another viewer's draft",
    (departure) => {
      vi.useFakeTimers();
      const { pane, state } = createTestChatPane({
        client: { request: vi.fn() } as unknown as GatewayBrowserClient,
        sessions: {} as SessionCapability,
      });
      state.sessionKey = "agent:work:main";
      state.assistantAgentId = "work";
      state.agentsList = { defaultId: "main", mainKey: "main", scope: "global", agents: [] };
      state.sessionsResultAgentId = "work";
      state.sessionsResult = {
        count: 1,
        path: "",
        sessions: [{ key: "global", kind: "global", sessionId: "pause", updatedAt: 1 }],
      } as never;
      const viewer = (id: string) => ({
        user: { id, identity: { type: "profile", id } },
        watchedSessions: ["agent:work:global"],
      });
      pane.presencePayload = { presence: [viewer("alice"), viewer("bob")] };
      for (const id of ["alice", "bob"]) {
        pane.handleSessionTypingEvent({
          sessionKey: state.sessionKey,
          sessionId: "pause",
          agentId: "work",
          actor: { type: "human", id, label: id },
          typing: true,
          preview: id + " draft",
          ts: 1,
        });
      }
      vi.advanceTimersByTime(10_000);
      pane.pruneTypingActors();
      expect(pane.typingActors.size).toBe(2);
      pane.presencePayload = {
        presence: [
          viewer("bob"),
          {
            ...viewer("alice"),
            ...(departure === "disconnect" ? { reason: "disconnect" } : {}),
            ...(departure === "leave" ? { watchedSessions: ["agent:main:global"] } : {}),
            ...(departure === "unqualified" ? { user: { id: "alice" } } : {}),
          },
        ],
      };
      pane.pruneTypingActors();
      expect([...pane.typingActors.keys()]).toEqual(["bob"]);
      pane.clearTypingActorForSessionMessage({
        sessionKey: state.sessionKey,
        agentId: "work",
        message: { role: "user", __openclaw: { senderIdentity: { type: "profile", id: "bob" } } },
      });
      expect(pane.typingActors.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("sends only the last 300 draft code points and omits previews when typing stops", () => {
    const { pane, request } = createTypingPane();

    pane.sendTypingState(true, `  prefix${"😀".repeat(300)}  `);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "session.typing",
      expect.objectContaining({
        sessionKey: "agent:work:main",
        sessionId: "session-a",
        agentId: "work",
        typing: true,
        preview: "😀".repeat(300),
      }),
    );

    pane.sendTypingState(false, "must not leak");
    expect(request.mock.calls[1]?.[1]).toMatchObject({ typing: false });
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("preview");

    pane.sendTypingState(true, "   ");
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("preview");
  });

  it("paces a continuous draft at 250 ms and delivers the latest trailing preview", () => {
    vi.useFakeTimers();
    const { pane, request } = createTypingPane();
    for (let index = 0; index < 10; index += 1) {
      pane.sendTypingState(true, `draft ${index}`);
      vi.advanceTimersByTime(100);
    }
    expect(request.mock.calls.map(([, params]) => params.preview)).toEqual([
      "draft 0",
      "draft 2",
      "draft 4",
      "draft 7",
      "draft 9",
    ]);
    vi.advanceTimersByTime(250);
    expect(request).toHaveBeenCalledTimes(5);
  });

  it("stops immediately and cancels the queued draft before a new typing burst", () => {
    vi.useFakeTimers();
    const { pane, request } = createTypingPane();
    pane.sendTypingState(true, "first");
    vi.advanceTimersByTime(100);
    pane.sendTypingState(true, "pending");
    pane.sendTypingState(false);
    expect(request.mock.calls.map(([, params]) => params.typing)).toEqual([true, false]);
    vi.advanceTimersByTime(250);
    expect(request).toHaveBeenCalledTimes(2);
    pane.sendTypingState(true, "new draft");
    expect(request.mock.calls[2]?.[1]).toMatchObject({ typing: true, preview: "new draft" });
  });

  it.each([
    "disconnect",
    "reconnect",
    "client",
    "session",
    "generation",
    "role",
    "visibility",
    "solo",
  ])("discards a queued preview after %s changes its target", (change) => {
    vi.useFakeTimers();
    const { pane, state, request, row } = createTypingPane();
    pane.sendTypingState(true, "first");
    pane.sendTypingState(true, "pending");
    switch (change) {
      case "disconnect":
        state.connected = false;
        break;
      case "reconnect":
        pane.connectionGeneration += 1;
        break;
      case "client":
        state.client = createGatewayBrowserClientFixture();
        break;
      case "session":
        state.sessionKey = "agent:work:other";
        break;
      case "generation":
        row.sessionId = "session-b";
        break;
      case "role":
        row.sharingRole = "viewer";
        break;
      case "visibility":
        row.visibility = "draft";
        break;
      case "solo":
        pane.presencePayload = { presence: [{ user: { id: "owner" } }] };
        break;
    }
    vi.advanceTimersByTime(250);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
