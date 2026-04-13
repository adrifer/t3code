import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";

import {
  type ChatAttachment,
  type CopilotModelSelection,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  RuntimeItemId,
  type ToolLifecycleItemType,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSendTurnInput,
  type ProviderTurnStartResult,
} from "@t3tools/contracts";
import {
  normalizeCopilotModelOptionsWithCapabilities,
  resolveApiModelId,
} from "@t3tools/shared/model";
import { Effect, Layer, Queue, Stream } from "effect";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { CopilotAdapter, type CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  resolveCommandExecution,
  resolveWslExecutionTarget,
  translatePathForExecution,
} from "../../wsl.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { getCopilotModelCapabilities } from "./CopilotProvider.ts";

const PROVIDER = "copilot" as const;
const IMAGE_PATH_REGEX = /\.(avif|bmp|gif|heic|ico|jpe?g|png|svg|webp)$/i;

interface CopilotChildProcess {
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  readonly pid?: number;
  on(event: "close", listener: (exitCode: number | null) => void): this;
  on(event: "error", listener: (cause: unknown) => void): this;
  kill(signal?: number | NodeJS.Signals): boolean;
}

interface CopilotCliEvent {
  readonly type?: string;
  readonly data?: Record<string, unknown>;
  readonly id?: string;
  readonly timestamp?: string;
  readonly sessionId?: string;
  readonly exitCode?: number;
  readonly usage?: unknown;
}

interface CopilotTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
  readonly input: string;
  readonly resumeCursorBefore?: unknown;
  readonly resumeCursorAfter?: unknown;
}

interface ActiveTurnState {
  readonly turnId: TurnId;
  readonly itemId: RuntimeItemId;
  readonly child: CopilotChildProcess;
  interrupted: boolean;
  readonly rawEvents: Array<CopilotCliEvent>;
  readonly toolCalls: Map<string, CopilotToolCallState>;
  readonly completedToolItems: Array<unknown>;
  readonly assistantMessages: Map<string, CopilotAssistantMessageState>;
  assistantSegmentIndex: number;
  pendingAssistantSegmentSplit: boolean;
}

interface CopilotSessionContext {
  session: ProviderSession;
  readonly initialResumeCursor?: unknown;
  turns: Array<CopilotTurnSnapshot>;
  activeTurn: ActiveTurnState | undefined;
}

export interface CopilotAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly spawnProcess?: (
    command: string,
    args: ReadonlyArray<string>,
    options: {
      readonly cwd?: string | undefined;
      readonly shell: boolean;
      readonly stdio: ["ignore", "pipe", "pipe"];
    },
  ) => CopilotChildProcess;
}

function nowIso(): string {
  return new Date().toISOString();
}

function nextEventId() {
  return EventId.make(crypto.randomUUID());
}

function nextTurnId() {
  return TurnId.make(crypto.randomUUID());
}

function nextItemId() {
  return RuntimeItemId.make(crypto.randomUUID());
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function killChildProcess(child: CopilotChildProcess): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // Fall through to direct kill.
    }
  }

  child.kill();
}

function readCopilotResumeCursor(resumeCursor: unknown): string | undefined {
  if (typeof resumeCursor === "string" && resumeCursor.trim().length > 0) {
    return resumeCursor;
  }
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }

  const cursor = resumeCursor as { sessionId?: unknown; resume?: unknown };
  if (typeof cursor.sessionId === "string" && cursor.sessionId.trim().length > 0) {
    return cursor.sessionId;
  }
  if (typeof cursor.resume === "string" && cursor.resume.trim().length > 0) {
    return cursor.resume;
  }
  return undefined;
}

function makeResumeCursor(sessionId: string | undefined, turnCount: number): unknown {
  return sessionId ? { sessionId, turnCount } : undefined;
}

function getAttachmentPaths(
  attachmentsDir: string,
  attachments: ReadonlyArray<ChatAttachment>,
  executionTarget = null as ReturnType<typeof resolveWslExecutionTarget>,
): Array<string> {
  const paths: string[] = [];
  for (const attachment of attachments) {
    const resolvedPath = resolveAttachmentPath({
      attachmentsDir,
      attachment,
    });
    if (resolvedPath) {
      paths.push(translatePathForExecution(resolvedPath, executionTarget));
    }
  }
  return paths;
}

function buildPrompt(input: {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly attachmentPaths: ReadonlyArray<string>;
  readonly interactionMode?: ProviderSendTurnInput["interactionMode"];
}): string {
  const sections =
    input.interactionMode === "plan"
      ? [
          [
            "Plan mode instructions:",
            "- Produce an implementation plan only.",
            "- Do not modify files, apply patches, or run commands.",
            "- If you need more context, limit yourself to read-only tools.",
            "- Return the final plan as concise markdown.",
          ].join("\n"),
          "",
          "User request:",
          input.text.trim(),
        ]
      : [input.text.trim()];

  if (input.attachments.length > 0) {
    sections.push(
      "",
      "Attached files:",
      ...input.attachments.map(
        (attachment, index) =>
          `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)${
            input.attachmentPaths[index] ? ` at ${input.attachmentPaths[index]}` : ""
          }`,
      ),
      "Use those files as context if needed.",
    );
  }

  return sections.join("\n").trim();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeCommand(value: unknown): string | undefined {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== undefined);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function prettifyToolName(toolName: string): string {
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_.:/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyToolItemType(
  toolName: string,
  input: Record<string, unknown>,
): ToolLifecycleItemType {
  const normalizedName = toolName.trim().toLowerCase();
  if (
    normalizedName === "bash" ||
    normalizedName === "read_bash" ||
    normalizedName === "write_bash" ||
    normalizedName === "stop_bash"
  ) {
    return "command_execution";
  }
  if (normalizedName === "apply_patch") {
    return "file_change";
  }
  if (normalizedName === "web_search" || normalizedName === "web_fetch") {
    return "web_search";
  }
  if (
    normalizedName === "task" ||
    normalizedName === "read_agent" ||
    normalizedName === "write_agent" ||
    normalizedName === "list_agents"
  ) {
    return "collab_agent_tool_call";
  }
  if (normalizedName.startsWith("linear-") || normalizedName.startsWith("github-mcp-server-")) {
    return "mcp_tool_call";
  }
  if (
    (normalizedName === "view" || normalizedName === "show_file") &&
    IMAGE_PATH_REGEX.test(asTrimmedString(input.path) ?? "")
  ) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

function summarizeToolCall(toolName: string, input: Record<string, unknown>): string | undefined {
  const command = normalizeCommand(input.command);
  if (command) {
    return command;
  }
  const path = asTrimmedString(input.path);
  if (path) {
    return path;
  }
  const query = asTrimmedString(input.query);
  if (query) {
    return query;
  }
  const intent = asTrimmedString(input.intent);
  if (intent) {
    return intent;
  }
  const title = asTrimmedString(input.title);
  if (title) {
    return title;
  }
  const message = asTrimmedString(input.message);
  if (message) {
    return message;
  }
  return prettifyToolName(toolName);
}

function summarizeToolResult(result: unknown): string | undefined {
  const resultRecord = asRecord(result);
  return asTrimmedString(resultRecord?.content) ?? asTrimmedString(resultRecord?.detailedContent);
}

function buildToolLifecycleData(
  toolName: string,
  input: Record<string, unknown>,
  result?: unknown,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    toolName,
    input,
  };
  const command = normalizeCommand(input.command);
  if (command) {
    data.command = command;
  }
  const path = asTrimmedString(input.path);
  if (path) {
    data.path = path;
  }
  const query = asTrimmedString(input.query);
  if (query) {
    data.query = query;
  }
  const resultSummary = summarizeToolResult(result);
  if (resultSummary) {
    data.result = {
      content: resultSummary,
    };
  }
  return data;
}

interface CopilotToolCallState {
  readonly toolCallId: string;
  readonly itemId: RuntimeItemId;
  readonly toolName: string;
  readonly itemType: ToolLifecycleItemType;
  readonly title: string;
  readonly detail?: string;
  readonly input: Record<string, unknown>;
}

interface CopilotAssistantMessageState {
  readonly segmentKey: string;
  readonly messageId: string;
  readonly itemId: RuntimeItemId;
  text: string;
  completed: boolean;
}

function isToolExecutionStartEvent(event: CopilotCliEvent): event is CopilotCliEvent & {
  data: { toolCallId: string; toolName: string; arguments?: unknown };
} {
  return (
    event.type === "tool.execution_start" &&
    typeof event.data?.toolCallId === "string" &&
    typeof event.data?.toolName === "string"
  );
}

function isToolExecutionCompleteEvent(event: CopilotCliEvent): event is CopilotCliEvent & {
  data: { toolCallId: string; success?: boolean; result?: unknown };
} {
  return event.type === "tool.execution_complete" && typeof event.data?.toolCallId === "string";
}

function isAssistantMessageEvent(
  event: CopilotCliEvent,
): event is CopilotCliEvent & { data: { messageId: string; content: string } } {
  return (
    event.type === "assistant.message" &&
    typeof event.data?.messageId === "string" &&
    typeof event.data?.content === "string" &&
    event.data.content.trim().length > 0
  );
}

function isAssistantDeltaEvent(
  event: CopilotCliEvent,
): event is CopilotCliEvent & { data: { messageId: string; deltaContent: string } } {
  return (
    event.type === "assistant.message_delta" &&
    typeof event.data?.messageId === "string" &&
    typeof event.data?.deltaContent === "string"
  );
}

function getAssistantSegment(
  activeTurn: ActiveTurnState,
  messageId: string,
): CopilotAssistantMessageState {
  if (activeTurn.pendingAssistantSegmentSplit) {
    activeTurn.assistantSegmentIndex += 1;
    activeTurn.pendingAssistantSegmentSplit = false;
  }
  const segmentKey = `${messageId}:${activeTurn.assistantSegmentIndex}`;
  const existing = activeTurn.assistantMessages.get(segmentKey);
  if (existing) {
    return existing;
  }

  const next: CopilotAssistantMessageState = {
    segmentKey,
    messageId,
    itemId: RuntimeItemId.make(
      `copilot-assistant:${messageId}:${activeTurn.assistantSegmentIndex}`,
    ),
    text: "",
    completed: false,
  };
  activeTurn.assistantMessages.set(segmentKey, next);
  return next;
}

function isResultEvent(event: CopilotCliEvent): boolean {
  return event.type === "result";
}

const makeCopilotAdapter = Effect.fn("makeCopilotAdapter")(function* (
  options?: CopilotAdapterLiveOptions,
) {
  const serverConfig = yield* ServerConfig;
  const serverSettingsService = yield* ServerSettingsService;
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);

  const services = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(services);
  const spawnProcess =
    options?.spawnProcess ??
    ((command, args, spawnOptions) => spawn(command, args, spawnOptions) as CopilotChildProcess);
  const sessions = new Map<ThreadId, CopilotSessionContext>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const emitSessionState = (
    context: CopilotSessionContext,
    state: "starting" | "ready" | "running" | "stopped" | "error",
    options?: {
      readonly detail?: unknown;
      readonly reason?: string;
    },
  ) =>
    offerRuntimeEvent({
      type: "session.state.changed",
      eventId: nextEventId(),
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: nowIso(),
      payload: {
        state,
        ...(options?.reason ? { reason: options.reason } : {}),
        ...(options?.detail !== undefined ? { detail: options.detail } : {}),
      },
    });

  const ensureContext = (
    threadId: ThreadId,
  ): Effect.Effect<CopilotSessionContext, ProviderAdapterSessionNotFoundError> =>
    Effect.gen(function* () {
      const context = sessions.get(threadId);
      if (!context) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      return context;
    });

  const ensureOpenContext = (
    threadId: ThreadId,
  ): Effect.Effect<
    CopilotSessionContext,
    ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError
  > =>
    Effect.gen(function* () {
      const context = yield* ensureContext(threadId);
      if (context.session.status === "closed") {
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId,
        });
      }
      return context;
    });

  const validateModelSelection = (
    modelSelection: ProviderSendTurnInput["modelSelection"] | undefined,
    operation: string,
  ) => {
    if (modelSelection && modelSelection.provider !== PROVIDER) {
      return Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation,
          issue: `Expected provider '${PROVIDER}' but received '${modelSelection.provider}'.`,
        }),
      );
    }
    return Effect.void;
  };

  const snapshotThread: CopilotAdapterShape["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* ensureContext(threadId);
      return {
        threadId,
        turns: context.turns.map((turn) => ({
          id: turn.id,
          items: [...turn.items],
        })),
      };
    });

  const startSession: CopilotAdapterShape["startSession"] = (input) =>
    Effect.gen(function* () {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      if (input.runtimeMode !== "full-access") {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "GitHub Copilot prompt mode currently supports only full-access runtime mode.",
        });
      }

      yield* validateModelSelection(input.modelSelection, "startSession");

      const existing = sessions.get(input.threadId);
      if (existing?.activeTurn) {
        killChildProcess(existing.activeTurn.child);
      }

      const createdAt = nowIso();
      const session: ProviderSession = {
        provider: PROVIDER,
        status: "ready",
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
        threadId: input.threadId,
        ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        createdAt,
        updatedAt: createdAt,
      };

      const context: CopilotSessionContext = {
        session,
        initialResumeCursor: input.resumeCursor,
        turns: [],
        activeTurn: undefined,
      };
      sessions.set(input.threadId, context);

      yield* offerRuntimeEvent({
        type: "session.started",
        eventId: nextEventId(),
        provider: PROVIDER,
        threadId: input.threadId,
        createdAt,
        payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
      });
      const resumedProviderThreadId = readCopilotResumeCursor(input.resumeCursor);
      yield* offerRuntimeEvent({
        type: "thread.started",
        eventId: nextEventId(),
        provider: PROVIDER,
        threadId: input.threadId,
        createdAt: nowIso(),
        payload: resumedProviderThreadId ? { providerThreadId: resumedProviderThreadId } : {},
      });
      yield* emitSessionState(context, "ready");

      return session;
    });

  const sendTurn: CopilotAdapterShape["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const context = yield* ensureOpenContext(input.threadId);
      yield* validateModelSelection(input.modelSelection, "sendTurn");

      if (context.activeTurn) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Thread '${input.threadId}' already has an active turn.`,
        });
      }

      const settings = yield* serverSettingsService.getSettings.pipe(
        Effect.map((serverSettings) => serverSettings.providers.copilot),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: "Failed to load Copilot settings.",
              cause,
            }),
        ),
      );

      const modelSelection: CopilotModelSelection = (input.modelSelection as
        | CopilotModelSelection
        | undefined) ?? {
        provider: PROVIDER,
        model: context.session.model ?? DEFAULT_MODEL_BY_PROVIDER[PROVIDER],
      };
      const normalizedOptions = normalizeCopilotModelOptionsWithCapabilities(
        getCopilotModelCapabilities(modelSelection.model),
        modelSelection.options,
      );
      const interactionMode = input.interactionMode;
      const isPlanMode = interactionMode === "plan";

      const promptInput =
        input.input?.trim() ||
        (isPlanMode
          ? "Review the attached context and propose an implementation plan."
          : "Review the attached context and continue.");
      const attachments = input.attachments ?? [];
      const executionTarget = resolveWslExecutionTarget({
        cwd: context.session.cwd,
        enabled: settings.useWsl,
        distro: settings.wslDistro,
      });
      const attachmentPaths = getAttachmentPaths(
        serverConfig.attachmentsDir,
        attachments,
        executionTarget,
      );
      const prompt = buildPrompt({
        text: promptInput,
        attachments,
        attachmentPaths,
        interactionMode,
      });

      const turnId = nextTurnId();
      const itemId = nextItemId();
      const resumedSessionId = readCopilotResumeCursor(context.session.resumeCursor);
      const args = [
        "-s",
        "--output-format",
        "json",
        "--allow-all-tools",
        "--allow-all-paths",
        "--allow-all-urls",
        "--model",
        resolveApiModelId(modelSelection),
        ...(normalizedOptions?.reasoningEffort
          ? ["--effort", normalizedOptions.reasoningEffort]
          : []),
        ...(interactionMode === "autopilot" ? ["--autopilot"] : []),
        ...(resumedSessionId ? [`--resume=${resumedSessionId}`] : []),
        "-p",
        prompt,
      ];
      const execution = resolveCommandExecution({
        command: settings.binaryPath,
        args,
        cwd: context.session.cwd,
        wsl: {
          enabled: settings.useWsl,
          distro: settings.wslDistro,
          shellProfile: true,
        },
      });

      const child = yield* Effect.try({
        try: () =>
          spawnProcess(execution.command, execution.args, {
            ...(execution.cwd ? { cwd: execution.cwd } : {}),
            shell: execution.shell,
            stdio: ["ignore", "pipe", "pipe"],
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "sendTurn",
            detail: toMessage(cause, "Failed to spawn GitHub Copilot CLI."),
            cause,
          }),
      });

      const activeTurn: ActiveTurnState = {
        turnId,
        itemId,
        child,
        interrupted: false,
        rawEvents: [],
        toolCalls: new Map(),
        completedToolItems: [],
        assistantMessages: new Map(),
        assistantSegmentIndex: 0,
        pendingAssistantSegmentSplit: false,
      };
      context.activeTurn = activeTurn;
      context.session = {
        ...context.session,
        status: "running",
        model: modelSelection.model,
        activeTurnId: turnId,
        updatedAt: nowIso(),
      };

      yield* emitSessionState(context, "running");
      yield* offerRuntimeEvent({
        type: "turn.started",
        eventId: nextEventId(),
        provider: PROVIDER,
        threadId: input.threadId,
        turnId,
        createdAt: nowIso(),
        itemId,
        payload: {
          model: modelSelection.model,
          ...(normalizedOptions?.reasoningEffort
            ? { effort: normalizedOptions.reasoningEffort }
            : {}),
        },
      });

      const stdoutReader = readline.createInterface({ input: child.stdout });
      stdoutReader.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }

        try {
          const event = JSON.parse(trimmed) as CopilotCliEvent;
          activeTurn.rawEvents.push(event);
          if (nativeEventLogger) {
            runFork(nativeEventLogger.write(event, input.threadId));
          }

          if (isAssistantDeltaEvent(event)) {
            const assistantMessage = getAssistantSegment(activeTurn, event.data.messageId);
            assistantMessage.text += event.data.deltaContent;
            runFork(
              offerRuntimeEvent({
                type: "content.delta",
                eventId: nextEventId(),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                itemId: assistantMessage.itemId,
                createdAt: event.timestamp ?? nowIso(),
                payload: {
                  streamKind: "assistant_text",
                  delta: event.data.deltaContent,
                },
                raw: {
                  source: "copilot.cli.event",
                  method: event.type,
                  payload: event,
                },
              }),
            );
          }

          if (isAssistantMessageEvent(event)) {
            const assistantMessage = getAssistantSegment(activeTurn, event.data.messageId);
            assistantMessage.text = event.data.content;
            assistantMessage.completed = true;
            runFork(
              offerRuntimeEvent({
                type: "item.completed",
                eventId: nextEventId(),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                itemId: assistantMessage.itemId,
                createdAt: event.timestamp ?? nowIso(),
                payload: {
                  itemType: "assistant_message",
                  title: "Assistant message",
                  detail: event.data.content,
                },
                raw: {
                  source: "copilot.cli.event",
                  method: event.type,
                  payload: event,
                },
              }),
            );
          }

          if (isToolExecutionStartEvent(event)) {
            const inputArgs = asRecord(event.data.arguments) ?? {};
            const itemType = classifyToolItemType(event.data.toolName, inputArgs);
            const detail = summarizeToolCall(event.data.toolName, inputArgs);
            const toolState: CopilotToolCallState = {
              toolCallId: event.data.toolCallId,
              itemId: RuntimeItemId.make(`copilot-tool:${event.data.toolCallId}`),
              toolName: event.data.toolName,
              itemType,
              title: prettifyToolName(event.data.toolName),
              input: inputArgs,
              ...(detail ? { detail } : {}),
            };
            activeTurn.toolCalls.set(toolState.toolCallId, toolState);
            if (activeTurn.assistantMessages.size > 0) {
              activeTurn.pendingAssistantSegmentSplit = true;
            }

            runFork(
              offerRuntimeEvent({
                type: "item.updated",
                eventId: nextEventId(),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                itemId: toolState.itemId,
                createdAt: event.timestamp ?? nowIso(),
                payload: {
                  itemType: toolState.itemType,
                  status: "inProgress",
                  title: toolState.title,
                  ...(toolState.detail ? { detail: toolState.detail } : {}),
                  data: buildToolLifecycleData(toolState.toolName, toolState.input),
                },
                raw: {
                  source: "copilot.cli.event",
                  method: event.type,
                  payload: event,
                },
              }),
            );
          }

          if (isToolExecutionCompleteEvent(event)) {
            const toolState = activeTurn.toolCalls.get(event.data.toolCallId);
            const fallbackToolState: CopilotToolCallState = toolState ?? {
              toolCallId: event.data.toolCallId,
              itemId: RuntimeItemId.make(`copilot-tool:${event.data.toolCallId}`),
              toolName: "tool",
              itemType: "dynamic_tool_call",
              title: "Tool",
              input: {},
            };
            const completionDetail =
              fallbackToolState.detail ?? summarizeToolResult(event.data.result);

            activeTurn.completedToolItems.push({
              type: fallbackToolState.itemType,
              toolName: fallbackToolState.toolName,
              title: fallbackToolState.title,
              ...(completionDetail ? { detail: completionDetail } : {}),
              input: fallbackToolState.input,
              ...(event.data.result !== undefined ? { result: event.data.result } : {}),
              ...(typeof event.data.success === "boolean" ? { success: event.data.success } : {}),
            });

            runFork(
              offerRuntimeEvent({
                type: "item.completed",
                eventId: nextEventId(),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                itemId: fallbackToolState.itemId,
                createdAt: event.timestamp ?? nowIso(),
                payload: {
                  itemType: fallbackToolState.itemType,
                  ...(typeof event.data.success === "boolean"
                    ? { status: event.data.success ? "completed" : "failed" }
                    : {}),
                  title: fallbackToolState.title,
                  ...(completionDetail ? { detail: completionDetail } : {}),
                },
                raw: {
                  source: "copilot.cli.event",
                  method: event.type,
                  payload: event,
                },
              }),
            );
          }
        } catch {
          if (nativeEventLogger) {
            runFork(nativeEventLogger.write({ source: "stdout", line: trimmed }, input.threadId));
          }
        }
      });

      const stderrChunks: Array<string> = [];
      child.stderr.on("data", (chunk) => {
        stderrChunks.push(chunk.toString());
      });

      child.on("close", (exitCode) => {
        stdoutReader.close();

        const resultEvent = [...activeTurn.rawEvents].toReversed().find(isResultEvent);
        const resumedSessionCursor =
          resultEvent && typeof resultEvent.sessionId === "string"
            ? resultEvent.sessionId
            : undefined;
        const stderrText = stderrChunks.join("").trim();
        const completionState = activeTurn.interrupted
          ? "interrupted"
          : exitCode === 0
            ? "completed"
            : "failed";
        const assistantMessages = Array.from(activeTurn.assistantMessages.values()).filter(
          (message) => message.text.trim().length > 0,
        );
        const lastAssistantMessage = assistantMessages.at(-1);
        const assistantText =
          lastAssistantMessage?.text ??
          [...activeTurn.rawEvents].toReversed().find(isAssistantMessageEvent)?.data.content ??
          "";

        context.session = {
          ...context.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: nowIso(),
          ...(resumedSessionCursor
            ? { resumeCursor: makeResumeCursor(resumedSessionCursor, context.turns.length + 1) }
            : {}),
          ...(completionState === "failed" && stderrText ? { lastError: stderrText } : {}),
        };

        context.turns.push({
          id: turnId,
          input: promptInput,
          resumeCursorBefore: makeResumeCursor(resumedSessionId, context.turns.length),
          resumeCursorAfter:
            resumedSessionCursor !== undefined
              ? makeResumeCursor(resumedSessionCursor, context.turns.length + 1)
              : undefined,
          items: [
            { type: "user_message", text: promptInput, attachments },
            ...activeTurn.completedToolItems,
            ...assistantMessages.map((message) => ({
              type: "assistant_message",
              text: message.text,
            })),
          ],
        });

        if (lastAssistantMessage && !lastAssistantMessage.completed && assistantText) {
          lastAssistantMessage.completed = true;
          runFork(
            offerRuntimeEvent({
              type: "item.completed",
              eventId: nextEventId(),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              itemId: lastAssistantMessage.itemId,
              createdAt: nowIso(),
              payload: {
                itemType: "assistant_message",
                title: "Assistant message",
                detail: assistantText,
              },
            }),
          );
        }

        if (completionState === "completed" && isPlanMode && assistantText.trim().length > 0) {
          runFork(
            offerRuntimeEvent({
              type: "turn.proposed.completed",
              eventId: nextEventId(),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              createdAt: nowIso(),
              payload: {
                planMarkdown: assistantText.trim(),
              },
            }),
          );
        }

        if (completionState === "failed") {
          runFork(
            offerRuntimeEvent({
              type: "runtime.error",
              eventId: nextEventId(),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              createdAt: nowIso(),
              payload: {
                message: stderrText || "GitHub Copilot CLI turn failed.",
                class: "provider_error",
              },
            }),
          );
        }

        runFork(
          offerRuntimeEvent({
            type: "turn.completed",
            eventId: nextEventId(),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            createdAt: nowIso(),
            itemId,
            payload: {
              state: completionState,
              ...(resultEvent?.usage !== undefined ? { usage: resultEvent.usage } : {}),
              ...(completionState === "failed" && stderrText ? { errorMessage: stderrText } : {}),
            },
          }).pipe(
            Effect.flatMap(() =>
              emitSessionState(context, completionState === "failed" ? "error" : "ready"),
            ),
          ),
        );

        context.activeTurn = undefined;
      });

      child.on("error", (cause) => {
        stdoutReader.close();
        const message = toMessage(cause, "GitHub Copilot CLI process failed.");
        context.session = {
          ...context.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: nowIso(),
          lastError: message,
        };
        context.activeTurn = undefined;

        runFork(
          offerRuntimeEvent({
            type: "runtime.error",
            eventId: nextEventId(),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            createdAt: nowIso(),
            payload: {
              message,
              class: "provider_error",
            },
          }).pipe(
            Effect.flatMap(() =>
              offerRuntimeEvent({
                type: "turn.completed",
                eventId: nextEventId(),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                itemId,
                createdAt: nowIso(),
                payload: {
                  state: activeTurn.interrupted ? "interrupted" : "failed",
                  errorMessage: message,
                },
              }),
            ),
            Effect.flatMap(() => emitSessionState(context, "error")),
          ),
        );
      });

      return {
        threadId: input.threadId,
        turnId,
        ...(context.session.resumeCursor !== undefined
          ? { resumeCursor: context.session.resumeCursor }
          : {}),
      } satisfies ProviderTurnStartResult;
    });

  const interruptTurn: CopilotAdapterShape["interruptTurn"] = (threadId, turnId) =>
    Effect.gen(function* () {
      const context = yield* ensureOpenContext(threadId);
      if (!context.activeTurn) {
        return;
      }
      if (turnId && context.activeTurn.turnId !== turnId) {
        return;
      }
      context.activeTurn.interrupted = true;
      killChildProcess(context.activeTurn.child);
    });

  const unsupportedRequest = (method: string, detail: string) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail,
      }),
    );

  const respondToRequest: CopilotAdapterShape["respondToRequest"] = () =>
    unsupportedRequest(
      "respondToRequest",
      "GitHub Copilot prompt mode does not support approval responses yet.",
    );

  const respondToUserInput: CopilotAdapterShape["respondToUserInput"] = () =>
    unsupportedRequest(
      "respondToUserInput",
      "GitHub Copilot prompt mode does not support structured user-input responses yet.",
    );

  const stopSession: CopilotAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* ensureContext(threadId);
      if (context.activeTurn) {
        context.activeTurn.interrupted = true;
        killChildProcess(context.activeTurn.child);
        context.activeTurn = undefined;
      }
      context.session = {
        ...context.session,
        status: "closed",
        activeTurnId: undefined,
        updatedAt: nowIso(),
      };
      yield* emitSessionState(context, "stopped");
      yield* offerRuntimeEvent({
        type: "session.exited",
        eventId: nextEventId(),
        provider: PROVIDER,
        threadId,
        createdAt: nowIso(),
        payload: {
          reason: "Session stopped",
          recoverable: true,
          exitKind: "graceful",
        },
      });
    });

  const listSessions: CopilotAdapterShape["listSessions"] = () =>
    Effect.succeed(
      Array.from(sessions.values())
        .map((context) => context.session)
        .filter((session) => session.status !== "closed"),
    );

  const hasSession: CopilotAdapterShape["hasSession"] = (threadId) =>
    Effect.succeed(
      (() => {
        const context = sessions.get(threadId);
        return context !== undefined && context.session.status !== "closed";
      })(),
    );

  const rollbackThread: CopilotAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    Effect.gen(function* () {
      const context = yield* ensureContext(threadId);
      if (context.activeTurn) {
        context.activeTurn.interrupted = true;
        killChildProcess(context.activeTurn.child);
        context.activeTurn = undefined;
      }
      const nextLength = Math.max(0, context.turns.length - numTurns);
      context.turns = context.turns.slice(0, nextLength);
      const lastTurn = context.turns.at(-1);
      context.session = {
        ...context.session,
        status: "ready",
        activeTurnId: undefined,
        updatedAt: nowIso(),
        ...(lastTurn?.resumeCursorAfter !== undefined
          ? { resumeCursor: lastTurn.resumeCursorAfter }
          : context.initialResumeCursor !== undefined
            ? { resumeCursor: context.initialResumeCursor }
            : {}),
      };
      return {
        threadId,
        turns: context.turns.map((turn) => ({
          id: turn.id,
          items: [...turn.items],
        })),
      };
    });

  const stopAll: CopilotAdapterShape["stopAll"] = () =>
    Effect.sync(() => {
      for (const context of sessions.values()) {
        if (context.activeTurn) {
          context.activeTurn.interrupted = true;
          killChildProcess(context.activeTurn.child);
          context.activeTurn = undefined;
        }
        context.session = {
          ...context.session,
          status: "closed",
          activeTurnId: undefined,
          updatedAt: nowIso(),
        };
      }
    });

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "restart-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread: snapshotThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromQueue(runtimeEventQueue),
  } satisfies CopilotAdapterShape;
});

export const CopilotAdapterLive = Layer.effect(CopilotAdapter, makeCopilotAdapter());

export function makeCopilotAdapterLive(options?: CopilotAdapterLiveOptions) {
  return Layer.effect(CopilotAdapter, makeCopilotAdapter(options));
}
