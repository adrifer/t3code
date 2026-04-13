import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { CopilotAdapter } from "../Services/CopilotAdapter.ts";
import { makeCopilotAdapterLive, type CopilotAdapterLiveOptions } from "./CopilotAdapter.ts";

class FakeCopilotProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4321;

  emitJson(event: unknown): void {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }

  close(exitCode = 0): void {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", exitCode);
  }

  kill(): boolean {
    this.close(0);
    return true;
  }
}

function makeHarness() {
  let lastSpawn:
    | {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      }
    | undefined;
  let lastProcess: FakeCopilotProcess | undefined;

  const options: CopilotAdapterLiveOptions = {
    spawnProcess: (command, args) => {
      lastSpawn = { command, args };
      lastProcess = new FakeCopilotProcess();
      return lastProcess;
    },
  };

  return {
    layer: makeCopilotAdapterLive(options).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/copilot-adapter-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    ),
    getLastSpawn: () => lastSpawn,
    getLastProcess: () => lastProcess,
  };
}

const THREAD_ID = ThreadId.make("thread-copilot-1");

describe("CopilotAdapterLive", () => {
  it.effect("maps Copilot tool execution events into runtime tool lifecycle events", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
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

      const spawned = harness.getLastSpawn();
      assert.equal(spawned?.command, "copilot");
      assert.deepEqual(spawned?.args.includes("-p"), true);

      const process = harness.getLastProcess();
      if (!process) {
        return;
      }

      process.emitJson({
        type: "tool.execution_start",
        timestamp: "2026-04-01T17:00:00.000Z",
        data: {
          toolCallId: "call_view_1",
          toolName: "view",
          arguments: {
            path: "/tmp/copilot-adapter-test",
          },
        },
      });
      process.emitJson({
        type: "tool.execution_complete",
        timestamp: "2026-04-01T17:00:01.000Z",
        data: {
          toolCallId: "call_view_1",
          success: true,
          result: {
            content: "note.txt",
          },
        },
      });
      process.emitJson({
        type: "assistant.message",
        timestamp: "2026-04-01T17:00:02.000Z",
        data: {
          messageId: "assistant-1",
          content: "I found note.txt.",
        },
      });
      process.emitJson({
        type: "result",
        timestamp: "2026-04-01T17:00:03.000Z",
        sessionId: "copilot-session-1",
        exitCode: 0,
      });
      process.close(0);

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

  it.effect("ignores empty assistant tool-request envelopes", () => {
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
        input: "Use a tool first",
        modelSelection: {
          provider: "copilot",
          model: "gpt-5.4",
        },
      });

      const process = harness.getLastProcess();
      if (!process) {
        return;
      }

      process.emitJson({
        type: "assistant.message",
        timestamp: "2026-04-01T17:00:00.000Z",
        data: {
          messageId: "assistant-empty",
          content: "",
          toolRequests: [
            {
              toolCallId: "call_view_1",
              name: "view",
              arguments: {
                path: "/tmp/copilot-adapter-test",
              },
            },
          ],
        },
      });
      process.emitJson({
        type: "assistant.message",
        timestamp: "2026-04-01T17:00:01.000Z",
        data: {
          messageId: "assistant-final",
          content: "Done.",
        },
      });
      process.emitJson({
        type: "result",
        timestamp: "2026-04-01T17:00:02.000Z",
        sessionId: "copilot-session-2",
        exitCode: 0,
      });
      process.close(0);

      const runtimeEvents = Array.from(
        yield* Fiber.join(runtimeEventsFiber),
      ) as ProviderRuntimeEvent[];
      const assistantCompletedEvents = runtimeEvents.filter(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      assert.equal(assistantCompletedEvents.length, 1);
      const [assistantCompleted] = assistantCompletedEvents;
      assert.equal(assistantCompleted?.type, "item.completed");
      if (assistantCompleted?.type !== "item.completed") {
        return;
      }
      assert.equal(assistantCompleted.payload.detail, "Done.");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("splits assistant message item ids across tool boundaries", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 11).pipe(
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
        input: "Check git status again",
        modelSelection: {
          provider: "copilot",
          model: "gpt-5.4",
        },
      });

      const process = harness.getLastProcess();
      if (!process) {
        return;
      }

      process.emitJson({
        type: "assistant.message_delta",
        timestamp: "2026-04-01T17:00:00.000Z",
        data: {
          messageId: "assistant-pre-tool",
          deltaContent: "I’m checking the worktree again now.",
        },
      });
      process.emitJson({
        type: "tool.execution_start",
        timestamp: "2026-04-01T17:00:01.000Z",
        data: {
          toolCallId: "call_bash_1",
          toolName: "bash",
          arguments: {
            command: "git --no-pager status --short --untracked-files=all",
          },
        },
      });
      process.emitJson({
        type: "tool.execution_complete",
        timestamp: "2026-04-01T17:00:02.000Z",
        data: {
          toolCallId: "call_bash_1",
          success: true,
          result: {
            content: "M src/file.ts",
          },
        },
      });
      process.emitJson({
        type: "assistant.message_delta",
        timestamp: "2026-04-01T17:00:03.000Z",
        data: {
          messageId: "assistant-pre-tool",
          deltaContent: "Still the same.",
        },
      });
      process.emitJson({
        type: "assistant.message",
        timestamp: "2026-04-01T17:00:04.000Z",
        data: {
          messageId: "assistant-pre-tool",
          content: "Still the same.",
        },
      });
      process.emitJson({
        type: "result",
        timestamp: "2026-04-01T17:00:05.000Z",
        sessionId: "copilot-session-3",
        exitCode: 0,
      });
      process.close(0);

      const runtimeEvents = Array.from(
        yield* Fiber.join(runtimeEventsFiber),
      ) as ProviderRuntimeEvent[];
      const assistantDeltas = runtimeEvents.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      assert.equal(assistantDeltas.length, 2);
      if (assistantDeltas.length !== 2) {
        return;
      }
      const [preToolDelta, postToolDelta] = assistantDeltas;
      assert.notEqual(String(preToolDelta?.itemId), String(postToolDelta?.itemId));

      const toolUpdatedIndex = runtimeEvents.findIndex(
        (event) => event.type === "item.updated" && event.payload.itemType === "command_execution",
      );
      const postToolDeltaIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "content.delta" &&
          event.payload.streamKind === "assistant_text" &&
          String(event.itemId) === String(postToolDelta?.itemId),
      );
      assert.equal(toolUpdatedIndex >= 0, true);
      assert.equal(postToolDeltaIndex >= 0, true);
      assert.equal(toolUpdatedIndex < postToolDeltaIndex, true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("passes autopilot mode through to the Copilot CLI", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "copilot",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "Finish the task autonomously",
        interactionMode: "autopilot",
        modelSelection: {
          provider: "copilot",
          model: "gpt-5.4",
        },
      });

      const spawned = harness.getLastSpawn();
      assert.equal(spawned?.args.includes("--autopilot"), true);

      const process = harness.getLastProcess();
      if (!process) {
        return;
      }

      process.emitJson({
        type: "assistant.message",
        timestamp: "2026-04-01T17:00:00.000Z",
        data: {
          messageId: "assistant-autopilot",
          content: "Done.",
        },
      });
      process.emitJson({
        type: "result",
        timestamp: "2026-04-01T17:00:01.000Z",
        sessionId: "copilot-session-autopilot",
        exitCode: 0,
      });
      process.close(0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("emits a proposed-plan event for Copilot plan mode responses", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
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
          model: "gpt-5.4",
        },
      });

      const process = harness.getLastProcess();
      if (!process) {
        return;
      }

      process.emitJson({
        type: "assistant.message",
        timestamp: "2026-04-01T17:00:00.000Z",
        data: {
          messageId: "assistant-plan",
          content: "# Plan\n\n1. Inspect the files.\n2. Make the change.",
        },
      });
      process.emitJson({
        type: "result",
        timestamp: "2026-04-01T17:00:01.000Z",
        sessionId: "copilot-session-plan",
        exitCode: 0,
      });
      process.close(0);

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
});
