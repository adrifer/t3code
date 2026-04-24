import * as NodeServices from "@effect/platform-node/NodeServices";
import type { SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { type CopilotSettings, ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { CopilotAdapter } from "../Services/CopilotAdapter.ts";
import { makeCopilotAdapterLive, type CopilotAdapterLiveOptions } from "./CopilotAdapter.ts";

type SessionConfigLike = SessionConfig;
type PermissionRequestEvent = Extract<
  SessionEvent,
  { type: "permission.requested" }
>["data"]["permissionRequest"];

class FakeCopilotSession {
  readonly sessionId: string;
  readonly sentMessages: Array<unknown> = [];
  readonly modeChanges: Array<string> = [];
  readonly setModelCalls: Array<{ readonly model: string; readonly options?: unknown }> = [];
  readonly truncateCalls: Array<string> = [];
  readonly handlers = new Set<(event: any) => void>();
  history: ReadonlyArray<any> = [];

  constructor(sessionId = "copilot-session-1") {
    this.sessionId = sessionId;
  }

  readonly rpc = {
    mode: {
      set: async ({ mode }: { readonly mode: string }) => {
        this.modeChanges.push(mode);
      },
    },
    history: {
      truncate: async ({ eventId }: { readonly eventId: string }) => {
        this.truncateCalls.push(eventId);
      },
    },
  };

  on(handler: (event: any) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(event: any): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  async send(options: unknown): Promise<string> {
    this.sentMessages.push(options);
    return `message-${this.sentMessages.length}`;
  }

  async getMessages(): Promise<ReadonlyArray<any>> {
    return this.history;
  }

  async abort(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async setModel(model: string, options?: unknown): Promise<void> {
    this.setModelCalls.push({ model, options });
  }
}

class FakeCopilotClient {
  readonly session: FakeCopilotSession;
  readonly createConfigs: Array<SessionConfigLike> = [];
  readonly resumeConfigs: Array<{
    readonly sessionId: string;
    readonly config: SessionConfigLike;
  }> = [];

  constructor(session: FakeCopilotSession) {
    this.session = session;
  }

  async createSession(config: SessionConfigLike): Promise<FakeCopilotSession> {
    this.createConfigs.push(config);
    return this.session;
  }

  async resumeSession(sessionId: string, config: SessionConfigLike): Promise<FakeCopilotSession> {
    this.resumeConfigs.push({ sessionId, config });
    return this.session;
  }

  async stop(): Promise<ReadonlyArray<unknown>> {
    return [];
  }
}

function makeHarness(options?: {
  readonly history?: ReadonlyArray<any>;
  readonly settings?: Parameters<typeof ServerSettingsService.layerTest>[0];
}) {
  let lastLaunch:
    | {
        readonly settings: CopilotSettings;
        readonly launch: unknown;
      }
    | undefined;
  const session = new FakeCopilotSession();
  if (options?.history) {
    session.history = options.history;
  }
  const client = new FakeCopilotClient(session);

  const adapterOptions: CopilotAdapterLiveOptions = {
    createClient: (input) => {
      lastLaunch = input;
      return client;
    },
  };

  return {
    layer: makeCopilotAdapterLive(adapterOptions).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/copilot-adapter-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest(options?.settings)),
      Layer.provideMerge(NodeServices.layer),
    ),
    session,
    client,
    getLastLaunch: () => lastLaunch,
  };
}

const THREAD_ID = ThreadId.make("thread-copilot-1");

describe("CopilotAdapterLive", () => {
  it.effect("maps SDK tool execution events into runtime tool lifecycle events", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "copilot",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "List files",
        modelSelection: {
          provider: "copilot",
          model: "gpt-5.4",
        },
      });

      harness.session.emit({
        type: "tool.execution_start",
        id: "evt-tool-start",
        parentId: null,
        timestamp: "2026-04-01T17:00:00.000Z",
        data: {
          toolCallId: "call_view_1",
          toolName: "view",
          arguments: {
            path: "/tmp/copilot-adapter-test",
          },
        },
      });
      harness.session.emit({
        type: "tool.execution_complete",
        id: "evt-tool-complete",
        parentId: "evt-tool-start",
        timestamp: "2026-04-01T17:00:01.000Z",
        data: {
          toolCallId: "call_view_1",
          success: true,
          result: {
            content: "note.txt",
          },
        },
      });
      harness.session.emit({
        type: "assistant.message",
        id: "evt-assistant-message",
        parentId: "evt-tool-complete",
        timestamp: "2026-04-01T17:00:02.000Z",
        data: {
          messageId: "assistant-1",
          content: "I found note.txt.",
        },
      });
      harness.session.emit({
        type: "session.idle",
        id: "evt-idle",
        parentId: "evt-assistant-message",
        timestamp: "2026-04-01T17:00:03.000Z",
        ephemeral: true,
        data: {},
      });

      const runtimeEvents = Array.from(
        yield* Fiber.join(runtimeEventsFiber),
      ) as ProviderRuntimeEvent[];
      const toolUpdated = runtimeEvents.find((event) => event.type === "item.updated");
      assert.equal(toolUpdated?.type, "item.updated");
      if (toolUpdated?.type !== "item.updated") {
        return;
      }
      assert.equal(toolUpdated.payload.itemType, "dynamic_tool_call");
      assert.equal(toolUpdated.payload.title, "view");
      assert.equal(toolUpdated.payload.detail, "/tmp/copilot-adapter-test");

      const toolCompleted = runtimeEvents.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "dynamic_tool_call",
      );
      assert.equal(toolCompleted?.type, "item.completed");
      if (toolCompleted?.type !== "item.completed") {
        return;
      }
      assert.equal(toolCompleted.payload.title, "view");
      assert.equal(toolCompleted.payload.detail, "/tmp/copilot-adapter-test");

      const assistantCompleted = runtimeEvents.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      assert.equal(assistantCompleted?.type, "item.completed");
      if (assistantCompleted?.type !== "item.completed") {
        return;
      }
      assert.equal(assistantCompleted.payload.detail, "I found note.txt.");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("switches mode and model in-session and emits plan completions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "copilot",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "Plan the implementation",
        interactionMode: "plan",
        modelSelection: {
          provider: "copilot",
          model: "claude-sonnet-4-6",
        },
      });

      assert.deepEqual(harness.session.modeChanges, ["plan"]);
      assert.deepEqual(harness.session.setModelCalls, [
        {
          model: "claude-sonnet-4.6",
          options: {
            reasoningEffort: "high",
          },
        },
      ]);

      harness.session.emit({
        type: "assistant.message",
        id: "evt-plan-message",
        parentId: null,
        timestamp: "2026-04-01T17:00:00.000Z",
        data: {
          messageId: "assistant-plan",
          content: "# Plan\n\n1. Inspect the files.\n2. Make the change.",
        },
      });
      harness.session.emit({
        type: "session.idle",
        id: "evt-plan-idle",
        parentId: "evt-plan-message",
        timestamp: "2026-04-01T17:00:01.000Z",
        ephemeral: true,
        data: {},
      });

      const runtimeEvents = Array.from(
        yield* Fiber.join(runtimeEventsFiber),
      ) as ProviderRuntimeEvent[];
      const proposedEvent = runtimeEvents.find((event) => event.type === "turn.proposed.completed");
      assert.equal(proposedEvent?.type, "turn.proposed.completed");
      if (proposedEvent?.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(
        proposedEvent.payload.planMarkdown,
        "# Plan\n\n1. Inspect the files.\n2. Make the change.",
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("enables SDK streaming for Copilot sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "copilot",
        runtimeMode: "full-access",
      });

      const createConfig = harness.client.createConfigs[0];
      assert.equal(createConfig?.streaming, true);
      assert.equal(createConfig?.includeSubAgentStreamingEvents, true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("auto-approves permission requests in full-access mode without action events", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "copilot",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "Check git status",
        modelSelection: {
          provider: "copilot",
          model: "gpt-5.4",
        },
      });

      const createConfig = harness.client.createConfigs[0];
      if (!createConfig) {
        return;
      }

      const permissionRequest: PermissionRequestEvent = {
        kind: "shell",
        canOfferSessionApproval: true,
        commands: [{ identifier: "git", readOnly: true }],
        fullCommandText: "git --no-pager status --short",
        hasWriteFileRedirection: false,
        intention: "Check worktree status",
        possiblePaths: [],
        possibleUrls: [],
      };
      const permissionPromise = createConfig.onPermissionRequest(permissionRequest, {
        sessionId: harness.session.sessionId,
      });

      harness.session.emit({
        type: "permission.requested",
        id: "evt-permission-requested",
        parentId: null,
        timestamp: "2026-04-01T17:00:00.000Z",
        ephemeral: true,
        data: {
          requestId: "permission-1",
          permissionRequest: {
            kind: "shell",
            canOfferSessionApproval: true,
            commands: [{ identifier: "git", readOnly: true }],
            fullCommandText: "git --no-pager status --short",
            hasWriteFileRedirection: false,
            intention: "Check worktree status",
            possiblePaths: [],
            possibleUrls: [],
          },
        },
      });

      harness.session.emit({
        type: "permission.completed",
        id: "evt-permission-completed",
        parentId: "evt-permission-requested",
        timestamp: "2026-04-01T17:00:01.000Z",
        ephemeral: true,
        data: {
          requestId: "permission-1",
          result: { kind: "approved-for-session" },
        },
      });
      harness.session.emit({
        type: "session.idle",
        id: "evt-permission-idle",
        parentId: "evt-permission-completed",
        timestamp: "2026-04-01T17:00:02.000Z",
        ephemeral: true,
        data: {},
      });

      const permissionResult = yield* Effect.promise(() => Promise.resolve(permissionPromise));
      assert.deepEqual(permissionResult, {
        kind: "approve-for-session",
        approval: { kind: "commands", commandIdentifiers: ["git"] },
      });

      const runtimeEvents = Array.from(
        yield* Fiber.join(runtimeEventsFiber),
      ) as ProviderRuntimeEvent[];
      assert.equal(
        runtimeEvents.some((event) => event.type === "request.opened"),
        false,
      );
      assert.equal(
        runtimeEvents.some((event) => event.type === "request.resolved"),
        false,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("uses SDK history truncate for rollback", () => {
    const harness = makeHarness({
      history: [
        {
          type: "session.start",
          id: "evt-session-start",
          parentId: null,
          timestamp: "2026-04-01T17:00:00.000Z",
          data: {
            sessionId: "copilot-session-1",
            copilotVersion: "1.0.0",
            producer: "copilot-agent",
            startTime: "2026-04-01T17:00:00.000Z",
            version: 3,
          },
        },
        {
          type: "user.message",
          id: "evt-user-1",
          parentId: "evt-session-start",
          timestamp: "2026-04-01T17:00:01.000Z",
          data: { content: "First turn" },
        },
        {
          type: "assistant.turn_start",
          id: "evt-turn-start-1",
          parentId: "evt-user-1",
          timestamp: "2026-04-01T17:00:02.000Z",
          data: { turnId: "provider-turn-1" },
        },
        {
          type: "assistant.message",
          id: "evt-assistant-1",
          parentId: "evt-turn-start-1",
          timestamp: "2026-04-01T17:00:03.000Z",
          data: { messageId: "assistant-1", content: "Done." },
        },
        {
          type: "assistant.turn_end",
          id: "evt-turn-end-1",
          parentId: "evt-assistant-1",
          timestamp: "2026-04-01T17:00:04.000Z",
          data: { turnId: "provider-turn-1" },
        },
        {
          type: "user.message",
          id: "evt-user-2",
          parentId: "evt-turn-end-1",
          timestamp: "2026-04-01T17:00:05.000Z",
          data: { content: "Second turn" },
        },
        {
          type: "assistant.turn_start",
          id: "evt-turn-start-2",
          parentId: "evt-user-2",
          timestamp: "2026-04-01T17:00:06.000Z",
          data: { turnId: "provider-turn-2" },
        },
        {
          type: "assistant.message",
          id: "evt-assistant-2",
          parentId: "evt-turn-start-2",
          timestamp: "2026-04-01T17:00:07.000Z",
          data: { messageId: "assistant-2", content: "Also done." },
        },
        {
          type: "assistant.turn_end",
          id: "evt-turn-end-2",
          parentId: "evt-assistant-2",
          timestamp: "2026-04-01T17:00:08.000Z",
          data: { turnId: "provider-turn-2" },
        },
      ],
    });
    return Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "copilot",
        runtimeMode: "full-access",
        resumeCursor: { sessionId: "copilot-session-1" },
      });

      const snapshot = yield* adapter.rollbackThread(THREAD_ID, 1);
      assert.equal(snapshot.turns.length, 1);
      assert.deepEqual(harness.session.truncateCalls, ["evt-turn-end-1"]);
    }).pipe(Effect.provide(harness.layer));
  });
});
