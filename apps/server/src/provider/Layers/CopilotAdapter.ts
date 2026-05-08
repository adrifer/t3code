import { readFile } from "node:fs/promises";

import {
  CopilotClient,
  type MessageOptions,
  type PermissionRequest as SdkPermissionRequest,
  type PermissionRequestResult,
  type ResumeSessionConfig,
  type SessionConfig,
  type SessionEvent,
} from "@github/copilot-sdk";
import {
  type ChatAttachment,
  type CopilotSettings,
  type CopilotModelSelection,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  RuntimeItemId,
  RuntimeRequestId,
  type ToolLifecycleItemType,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSendTurnInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
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
  buildCopilotSdkClientLaunch,
  getCopilotModelCapabilities,
  translateCopilotWorkingDirectory,
} from "../copilotSdk.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "copilot" as const;
const IMAGE_PATH_REGEX = /\.(avif|bmp|gif|heic|ico|jpe?g|png|svg|webp)$/i;

type CopilotSessionMode = "interactive" | "plan" | "autopilot";
type CopilotReasoningEffort = NonNullable<SessionConfig["reasoningEffort"]>;
type CopilotPermissionEventRequest = Extract<
  SessionEvent,
  { type: "permission.requested" }
>["data"]["permissionRequest"];
type CopilotUserInputRequest = NonNullable<
  Parameters<NonNullable<SessionConfig["onUserInputRequest"]>>[0]
>;
type CopilotUserInputResponse = Awaited<
  ReturnType<NonNullable<SessionConfig["onUserInputRequest"]>>
>;

interface CopilotSdkSessionShape {
  readonly sessionId: string;
  readonly rpc: {
    readonly history: {
      readonly truncate: (params: { readonly eventId: string }) => Promise<unknown>;
    };
    readonly mode: {
      readonly set: (params: { readonly mode: CopilotSessionMode }) => Promise<unknown>;
    };
  };
  on(handler: (event: SessionEvent) => void): () => void;
  send(options: MessageOptions): Promise<string>;
  getMessages(): Promise<ReadonlyArray<SessionEvent>>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  setModel(
    model: string,
    options?: {
      readonly reasoningEffort?: CopilotReasoningEffort | undefined;
      readonly modelCapabilities?: Record<string, unknown> | undefined;
    },
  ): Promise<void>;
}

interface CopilotSdkClientShape {
  createSession(config: SessionConfig): Promise<CopilotSdkSessionShape>;
  resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<CopilotSdkSessionShape>;
  stop(): Promise<ReadonlyArray<unknown>>;
  forceStop?(): Promise<void>;
}

export interface CopilotAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly createClient?: (input: {
    readonly settings: CopilotSettings;
    readonly launch: ReturnType<typeof buildCopilotSdkClientLaunch>;
  }) => CopilotSdkClientShape;
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

interface CopilotReasoningState {
  readonly reasoningId: string;
  readonly itemId: RuntimeItemId;
  text: string;
  completed: boolean;
}

interface CopilotTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
  readonly input: string;
  readonly providerTurnId: string | undefined;
  readonly truncateToEventId: string | undefined;
}

interface PromiseResolver<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
  readonly settled: () => boolean;
}

interface PendingPermissionRequest {
  readonly requestId: string;
  readonly signature: string;
  readonly request: CopilotPermissionEventRequest;
  readonly requestType: Extract<
    ProviderRuntimeEvent,
    { type: "request.opened" }
  >["payload"]["requestType"];
  readonly detail: string | undefined;
  readonly args: unknown | undefined;
  readonly toolCallId: string | undefined;
  readonly decision: PromiseResolver<ProviderApprovalDecision>;
}

interface PendingUserInputRequest {
  readonly requestId: string;
  readonly signature: string;
  readonly request: CopilotUserInputRequest;
  readonly toolCallId: string | undefined;
  readonly answers: PromiseResolver<ProviderUserInputAnswers>;
}

interface ActiveTurnState {
  readonly turnId: TurnId;
  readonly itemId: RuntimeItemId;
  readonly input: string;
  readonly interactionMode: ProviderSendTurnInput["interactionMode"];
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly toolCalls: Map<string, CopilotToolCallState>;
  readonly completedToolItems: Array<unknown>;
  readonly assistantMessages: Map<string, CopilotAssistantMessageState>;
  readonly reasoningBlocks: Map<string, CopilotReasoningState>;
  assistantSegmentIndex: number;
  pendingAssistantSegmentSplit: boolean;
  providerTurnId: string | undefined;
  lastPersistedEventId: string | undefined;
  lastUsage: unknown | undefined;
  failureMessage: string | undefined;
  aborted: boolean;
}

interface CopilotSessionContext {
  session: ProviderSession;
  readonly settings: CopilotSettings;
  readonly client: CopilotSdkClientShape;
  readonly sdkSession: CopilotSdkSessionShape;
  readonly unsubscribeEvents: () => void;
  readonly initialResumeCursor: unknown | undefined;
  readonly ignoredPermissionRequestIds: Set<string>;
  readonly permissionQueueBySignature: Map<string, PendingPermissionRequest[]>;
  readonly waitingPermissionResolvers: Map<
    string,
    Array<(pending: PendingPermissionRequest) => void>
  >;
  readonly userInputQueueBySignature: Map<string, PendingUserInputRequest[]>;
  readonly waitingUserInputResolvers: Map<
    string,
    Array<(pending: PendingUserInputRequest) => void>
  >;
  readonly pendingPermissionRequests: Map<string, PendingPermissionRequest>;
  readonly pendingUserInputRequests: Map<string, PendingUserInputRequest>;
  turns: Array<CopilotTurnSnapshot>;
  currentMode: CopilotSessionMode;
  sessionBoundaryEventId: string | undefined;
  activeTurn: ActiveTurnState | undefined;
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

function buildPrompt(input: {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
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
      "Attached images:",
      ...input.attachments.map(
        (attachment) =>
          `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
      ),
      "Use those images as context if needed.",
    );
  }

  return sections.join("\n").trim();
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

function createPromiseResolver<T>(): PromiseResolver<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason?: unknown) => void;
  let settled = false;

  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = (value) => {
      settled = true;
      resolve(value);
    };
    rejectPromise = (reason) => {
      settled = true;
      reject(reason);
    };
  });

  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
    settled: () => settled,
  };
}

function pushMapQueue<T>(target: Map<string, T[]>, key: string, value: T): void {
  const existing = target.get(key);
  if (existing) {
    existing.push(value);
    return;
  }
  target.set(key, [value]);
}

function shiftMapQueue<T>(target: Map<string, T[]>, key: string): T | undefined {
  const existing = target.get(key);
  if (!existing || existing.length === 0) {
    return undefined;
  }
  const next = existing.shift();
  if (existing.length === 0) {
    target.delete(key);
  }
  return next;
}

function removeQueuedValue<T>(
  target: Map<string, T[]>,
  key: string,
  predicate: (value: T) => boolean,
): void {
  const existing = target.get(key);
  if (!existing) {
    return;
  }
  const next = existing.filter((value) => !predicate(value));
  if (next.length === 0) {
    target.delete(key);
    return;
  }
  target.set(key, next);
}

function settlePendingPermissions(
  context: CopilotSessionContext,
  decision: ProviderApprovalDecision,
): void {
  for (const pending of context.pendingPermissionRequests.values()) {
    if (!pending.decision.settled()) {
      pending.decision.resolve(decision);
    }
  }
  context.pendingPermissionRequests.clear();
  context.permissionQueueBySignature.clear();
  context.waitingPermissionResolvers.clear();
}

function settlePendingUserInputs(context: CopilotSessionContext): void {
  for (const pending of context.pendingUserInputRequests.values()) {
    if (!pending.answers.settled()) {
      pending.answers.resolve({ response: "" });
    }
  }
  context.pendingUserInputRequests.clear();
  context.userInputQueueBySignature.clear();
  context.waitingUserInputResolvers.clear();
}

function permissionSignature(request: unknown): string {
  return stableStringify(request);
}

function userInputSignature(request: CopilotUserInputRequest): string {
  return stableStringify({
    question: request.question,
    choices: request.choices ?? [],
    allowFreeform: request.allowFreeform ?? true,
  });
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

function makeResumeCursor(sessionId: string, turnCount: number): unknown {
  return { sessionId, turnCount };
}

function mapPermissionRequestType(
  request: CopilotPermissionEventRequest,
): Extract<ProviderRuntimeEvent, { type: "request.opened" }>["payload"]["requestType"] {
  switch (request.kind) {
    case "shell":
      return "command_execution_approval";
    case "read":
      return "file_read_approval";
    case "write":
      return "file_change_approval";
    case "mcp":
    case "custom-tool":
    case "url":
    case "hook":
      return "dynamic_tool_call";
    default:
      return "unknown";
  }
}

function describePermissionRequest(request: CopilotPermissionEventRequest): string | undefined {
  switch (request.kind) {
    case "shell":
      return request.fullCommandText || request.intention;
    case "read":
      return request.path;
    case "write":
      return request.fileName;
    case "mcp":
      return `${request.serverName}/${request.toolName}`;
    case "url":
      return request.url;
    case "custom-tool":
      return request.toolName;
    case "hook":
      return request.toolName;
    case "memory":
      return request.fact;
    default:
      return undefined;
  }
}

function toPermissionDecision(
  request: CopilotPermissionEventRequest,
  decision: ProviderApprovalDecision,
): PermissionRequestResult {
  if (decision === "accept") {
    return { kind: "approve-once" };
  }

  if (decision === "decline") {
    return { kind: "reject" };
  }

  if (decision === "cancel") {
    return { kind: "user-not-available" };
  }

  switch (request.kind) {
    case "shell": {
      const identifiers = request.commands.map((command) => command.identifier);
      return identifiers.length > 0
        ? {
            kind: "approve-for-session",
            approval: { kind: "commands", commandIdentifiers: identifiers },
          }
        : { kind: "approve-once" };
    }
    case "read":
      return { kind: "approve-for-session", approval: { kind: "read" } };
    case "write":
      return { kind: "approve-for-session", approval: { kind: "write" } };
    case "mcp":
      return {
        kind: "approve-for-session",
        approval: { kind: "mcp", serverName: request.serverName, toolName: request.toolName },
      };
    case "memory":
      return { kind: "approve-for-session", approval: { kind: "memory" } };
    case "custom-tool":
      return {
        kind: "approve-for-session",
        approval: { kind: "custom-tool", toolName: request.toolName },
      };
    default:
      return { kind: "approve-once" };
  }
}

function permissionResolutionToDecision(
  resultKind: string | undefined,
): ProviderApprovalDecision | undefined {
  switch (resultKind) {
    case "approved":
      return "accept";
    case "approved-for-session":
    case "approved-for-location":
      return "acceptForSession";
    case "denied-interactively-by-user":
    case "denied-by-rules":
    case "denied-by-content-exclusion-policy":
    case "denied-by-permission-request-hook":
      return "decline";
    case "denied-no-approval-rule-and-could-not-request-from-user":
      return "cancel";
    default:
      return undefined;
  }
}

function shouldAutoApprovePermissionRequest(
  runtimeMode: ProviderSession["runtimeMode"],
  request: Pick<SdkPermissionRequest, "kind">,
): boolean {
  if (runtimeMode === "full-access") {
    return true;
  }

  if (runtimeMode !== "auto-accept-edits") {
    return false;
  }

  switch (request.kind) {
    case "read":
    case "write":
      return true;
    default:
      return false;
  }
}

function extractUserInputAnswer(answers: ProviderUserInputAnswers): string {
  if ("response" in answers) {
    const value = answers.response;
    if (typeof value === "string") {
      return value;
    }
  }

  for (const value of Object.values(answers)) {
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }

  return "";
}

function chooseWasFreeform(request: CopilotUserInputRequest, answer: string): boolean {
  if (!request.choices || request.choices.length === 0) {
    return true;
  }
  return !request.choices.includes(answer);
}

function mapInteractionModeToSessionMode(
  interactionMode: ProviderSendTurnInput["interactionMode"],
): CopilotSessionMode {
  if (interactionMode === "plan") {
    return "plan";
  }
  if (interactionMode === "autopilot") {
    return "autopilot";
  }
  return "interactive";
}

async function stopCopilotClient(client: CopilotSdkClientShape): Promise<void> {
  try {
    const cleanupErrors = await client.stop();
    if (cleanupErrors.length > 0 && typeof client.forceStop === "function") {
      await client.forceStop();
    }
  } catch {
    if (typeof client.forceStop === "function") {
      await client.forceStop().catch(() => undefined);
    }
  }
}

function historyTurnId(index: number, providerTurnId?: string | undefined): TurnId {
  return TurnId.make(
    providerTurnId ? `copilot-history:${providerTurnId}` : `copilot-history:${index + 1}`,
  );
}

function rebuildTurnsFromHistory(events: ReadonlyArray<SessionEvent>): {
  readonly turns: ReadonlyArray<CopilotTurnSnapshot>;
  readonly sessionBoundaryEventId: string | undefined;
} {
  const turns: CopilotTurnSnapshot[] = [];
  let sessionBoundaryEventId: string | undefined;
  let current:
    | {
        id: TurnId;
        input: string;
        items: Array<unknown>;
        providerTurnId: string | undefined;
        assistantMessages: Array<string>;
        completedToolItems: Array<unknown>;
        truncateToEventId: string | undefined;
      }
    | undefined;

  const ensureCurrent = () => {
    if (current) {
      return current;
    }
    current = {
      id: historyTurnId(turns.length),
      input: "",
      items: [],
      assistantMessages: [],
      completedToolItems: [],
      providerTurnId: undefined,
      truncateToEventId: undefined,
    };
    return current;
  };

  const finalizeCurrent = () => {
    if (!current) {
      return;
    }
    turns.push({
      id: current.id,
      input: current.input,
      providerTurnId: current.providerTurnId,
      truncateToEventId: current.truncateToEventId,
      items: [
        ...(current.input
          ? [
              {
                type: "user_message",
                text: current.input,
                attachments: [] as ReadonlyArray<ChatAttachment>,
              },
            ]
          : []),
        ...current.completedToolItems,
        ...current.assistantMessages.map((text) => ({ type: "assistant_message", text })),
      ],
    });
    current = undefined;
  };

  for (const event of events) {
    if (event.agentId) {
      continue;
    }

    if (!event.ephemeral) {
      if (event.type === "session.start" || event.type === "session.resume") {
        sessionBoundaryEventId = event.id;
      }
      if (current) {
        current.truncateToEventId = event.id;
      }
    }

    switch (event.type) {
      case "user.message": {
        finalizeCurrent();
        current = {
          id: historyTurnId(turns.length),
          input: event.data.content,
          items: [],
          assistantMessages: [],
          completedToolItems: [],
          providerTurnId: undefined,
          truncateToEventId: undefined,
        };
        break;
      }
      case "assistant.turn_start": {
        const next = ensureCurrent();
        next.providerTurnId = event.data.turnId;
        next.id = historyTurnId(turns.length, event.data.turnId);
        break;
      }
      case "tool.execution_complete": {
        const next = ensureCurrent();
        next.completedToolItems.push({
          type: "dynamic_tool_call",
          toolName: "tool",
          title: "Tool",
          ...(event.data.result?.detailedContent || event.data.result?.content
            ? { detail: event.data.result.detailedContent ?? event.data.result.content }
            : {}),
          ...(event.data.result ? { result: event.data.result } : {}),
          success: event.data.success,
        });
        break;
      }
      case "assistant.message": {
        if (event.data.content.trim().length === 0) {
          break;
        }
        ensureCurrent().assistantMessages.push(event.data.content);
        break;
      }
      case "assistant.turn_end": {
        finalizeCurrent();
        break;
      }
      default:
        break;
    }
  }

  finalizeCurrent();
  return { turns, sessionBoundaryEventId };
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
  const sessions = new Map<ThreadId, CopilotSessionContext>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const emitSessionState = (
    context: CopilotSessionContext,
    state: "starting" | "ready" | "running" | "waiting" | "stopped" | "error",
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

  const buildEventBase = (input: {
    readonly threadId: ThreadId;
    readonly turnId?: TurnId | undefined;
    readonly itemId?: RuntimeItemId | undefined;
    readonly requestId?: string | undefined;
    readonly createdAt?: string | undefined;
    readonly raw?: SessionEvent | undefined;
  }): Pick<
    ProviderRuntimeEvent,
    "eventId" | "provider" | "threadId" | "createdAt" | "turnId" | "itemId" | "requestId" | "raw"
  > => ({
    eventId: nextEventId(),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: input.createdAt ?? nowIso(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: input.itemId } : {}),
    ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
    ...(input.raw
      ? {
          raw: {
            source: "copilot.cli.event",
            method: input.raw.type,
            payload: input.raw,
          },
        }
      : {}),
  });

  const getAssistantSegment = (
    activeTurn: ActiveTurnState,
    messageId: string,
  ): CopilotAssistantMessageState => {
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
  };

  const getReasoningBlock = (
    activeTurn: ActiveTurnState,
    reasoningId: string,
  ): CopilotReasoningState => {
    const existing = activeTurn.reasoningBlocks.get(reasoningId);
    if (existing) {
      return existing;
    }

    const next: CopilotReasoningState = {
      reasoningId,
      itemId: RuntimeItemId.make(`copilot-reasoning:${reasoningId}`),
      text: "",
      completed: false,
    };
    activeTurn.reasoningBlocks.set(reasoningId, next);
    return next;
  };

  const finalizeTurn = (
    context: CopilotSessionContext,
    state: "completed" | "failed" | "interrupted" | "cancelled",
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const activeTurn = context.activeTurn;
      if (!activeTurn) {
        return;
      }

      const assistantMessages = Array.from(activeTurn.assistantMessages.values()).filter(
        (message) => message.text.trim().length > 0,
      );
      const reasoningBlocks = Array.from(activeTurn.reasoningBlocks.values()).filter(
        (reasoning) => reasoning.text.trim().length > 0,
      );
      const lastAssistantMessage = assistantMessages.at(-1);
      const assistantText = lastAssistantMessage?.text ?? "";

      if (lastAssistantMessage && !lastAssistantMessage.completed) {
        lastAssistantMessage.completed = true;
        yield* offerRuntimeEvent({
          ...buildEventBase({
            threadId: context.session.threadId,
            turnId: activeTurn.turnId,
            itemId: lastAssistantMessage.itemId,
          }),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            title: "Assistant message",
            detail: lastAssistantMessage.text,
          },
        });
      }

      context.turns.push({
        id: activeTurn.turnId,
        input: activeTurn.input,
        providerTurnId: activeTurn.providerTurnId,
        truncateToEventId: activeTurn.lastPersistedEventId,
        items: [
          {
            type: "user_message",
            text: activeTurn.input,
            attachments: activeTurn.attachments,
          },
          ...activeTurn.completedToolItems,
          ...reasoningBlocks.map((reasoning) => ({
            type: "reasoning",
            text: reasoning.text,
          })),
          ...assistantMessages.map((message) => ({
            type: "assistant_message",
            text: message.text,
          })),
        ],
      });

      context.session = {
        ...context.session,
        status: state === "failed" ? "error" : "ready",
        activeTurnId: undefined,
        updatedAt: nowIso(),
        resumeCursor: makeResumeCursor(context.sdkSession.sessionId, context.turns.length),
        ...(activeTurn.failureMessage && state === "failed"
          ? { lastError: activeTurn.failureMessage }
          : {}),
      };

      if (
        state === "completed" &&
        activeTurn.interactionMode === "plan" &&
        assistantText.trim().length > 0
      ) {
        yield* offerRuntimeEvent({
          ...buildEventBase({
            threadId: context.session.threadId,
            turnId: activeTurn.turnId,
          }),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: assistantText.trim(),
          },
        });
      }

      if (activeTurn.failureMessage && state === "failed") {
        yield* offerRuntimeEvent({
          ...buildEventBase({
            threadId: context.session.threadId,
            turnId: activeTurn.turnId,
          }),
          type: "runtime.error",
          payload: {
            message: activeTurn.failureMessage,
            class: "provider_error",
          },
        });
      }

      yield* offerRuntimeEvent({
        ...buildEventBase({
          threadId: context.session.threadId,
          turnId: activeTurn.turnId,
          itemId: activeTurn.itemId,
        }),
        type: "turn.completed",
        payload: {
          state,
          ...(activeTurn.lastUsage !== undefined ? { usage: activeTurn.lastUsage } : {}),
          ...(activeTurn.failureMessage ? { errorMessage: activeTurn.failureMessage } : {}),
        },
      });

      context.activeTurn = undefined;
      yield* emitSessionState(context, state === "failed" ? "error" : "ready");
    });

  const handleSessionEvent = (
    context: CopilotSessionContext,
    event: SessionEvent,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (nativeEventLogger) {
        runFork(nativeEventLogger.write(event, context.session.threadId));
      }

      if (event.agentId) {
        return;
      }

      if (!event.ephemeral && context.activeTurn) {
        context.activeTurn.lastPersistedEventId = event.id;
      } else if (
        !event.ephemeral &&
        (event.type === "session.start" || event.type === "session.resume")
      ) {
        context.sessionBoundaryEventId = event.id;
      }

      const activeTurn = context.activeTurn;

      switch (event.type) {
        case "assistant.turn_start": {
          if (!activeTurn) {
            return;
          }
          activeTurn.providerTurnId = event.data.turnId;
          return;
        }
        case "assistant.message_delta": {
          if (!activeTurn) {
            return;
          }
          const assistantMessage = getAssistantSegment(activeTurn, event.data.messageId);
          assistantMessage.text += event.data.deltaContent;
          yield* offerRuntimeEvent({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId: activeTurn.turnId,
              itemId: assistantMessage.itemId,
              createdAt: event.timestamp,
              raw: event,
            }),
            type: "content.delta",
            payload: {
              streamKind: "assistant_text",
              delta: event.data.deltaContent,
            },
          });
          return;
        }
        case "assistant.reasoning_delta": {
          if (!activeTurn) {
            return;
          }
          const reasoning = getReasoningBlock(activeTurn, event.data.reasoningId);
          reasoning.text += event.data.deltaContent;
          yield* offerRuntimeEvent({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId: activeTurn.turnId,
              itemId: reasoning.itemId,
              createdAt: event.timestamp,
              raw: event,
            }),
            type: "content.delta",
            payload: {
              streamKind: "reasoning_text",
              delta: event.data.deltaContent,
            },
          });
          return;
        }
        case "assistant.reasoning": {
          if (!activeTurn || event.data.content.trim().length === 0) {
            return;
          }
          const reasoning = getReasoningBlock(activeTurn, event.data.reasoningId);
          reasoning.text = event.data.content;
          reasoning.completed = true;
          yield* offerRuntimeEvent({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId: activeTurn.turnId,
              itemId: reasoning.itemId,
              createdAt: event.timestamp,
              raw: event,
            }),
            type: "item.completed",
            payload: {
              itemType: "reasoning",
              title: "Reasoning",
              detail: event.data.content,
            },
          });
          return;
        }
        case "assistant.message": {
          if (!activeTurn || event.data.content.trim().length === 0) {
            return;
          }
          const assistantMessage = getAssistantSegment(activeTurn, event.data.messageId);
          assistantMessage.text = event.data.content;
          assistantMessage.completed = true;
          yield* offerRuntimeEvent({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId: activeTurn.turnId,
              itemId: assistantMessage.itemId,
              createdAt: event.timestamp,
              raw: event,
            }),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              title: "Assistant message",
              detail: event.data.content,
            },
          });
          return;
        }
        case "assistant.usage": {
          if (activeTurn) {
            activeTurn.lastUsage = event.data;
          }
          yield* offerRuntimeEvent({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId: activeTurn?.turnId,
              createdAt: event.timestamp,
              raw: event,
            }),
            type: "thread.token-usage.updated",
            payload: {
              usage: {
                usedTokens:
                  (event.data.inputTokens ?? 0) +
                  (event.data.outputTokens ?? 0) +
                  (event.data.reasoningTokens ?? 0) +
                  (event.data.cacheReadTokens ?? 0),
                totalProcessedTokens:
                  (event.data.inputTokens ?? 0) +
                  (event.data.outputTokens ?? 0) +
                  (event.data.reasoningTokens ?? 0),
                inputTokens: event.data.inputTokens,
                cachedInputTokens: event.data.cacheReadTokens,
                outputTokens: event.data.outputTokens,
                reasoningOutputTokens: event.data.reasoningTokens,
                lastInputTokens: event.data.inputTokens,
                lastCachedInputTokens: event.data.cacheReadTokens,
                lastOutputTokens: event.data.outputTokens,
                lastReasoningOutputTokens: event.data.reasoningTokens,
                durationMs: event.data.duration,
              },
            },
          });
          return;
        }
        case "tool.execution_start": {
          if (!activeTurn) {
            return;
          }
          const inputArgs = event.data.arguments ?? {};
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

          yield* offerRuntimeEvent({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId: activeTurn.turnId,
              itemId: toolState.itemId,
              createdAt: event.timestamp,
              raw: event,
            }),
            type: "item.updated",
            payload: {
              itemType: toolState.itemType,
              status: "inProgress",
              title: toolState.title,
              ...(toolState.detail ? { detail: toolState.detail } : {}),
              data: buildToolLifecycleData(toolState.toolName, toolState.input),
            },
          });
          return;
        }
        case "tool.execution_progress": {
          if (!activeTurn) {
            return;
          }
          yield* offerRuntimeEvent({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId: activeTurn.turnId,
              createdAt: event.timestamp,
              raw: event,
            }),
            type: "tool.progress",
            payload: {
              toolUseId: event.data.toolCallId,
              summary: event.data.progressMessage,
            },
          });
          return;
        }
        case "tool.execution_partial_result": {
          if (!activeTurn) {
            return;
          }
          yield* offerRuntimeEvent({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId: activeTurn.turnId,
              createdAt: event.timestamp,
              raw: event,
            }),
            type: "tool.progress",
            payload: {
              toolUseId: event.data.toolCallId,
              summary: event.data.partialOutput,
            },
          });
          return;
        }
        case "tool.execution_complete": {
          if (!activeTurn) {
            return;
          }
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

          yield* offerRuntimeEvent({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId: activeTurn.turnId,
              itemId: fallbackToolState.itemId,
              createdAt: event.timestamp,
              raw: event,
            }),
            type: "item.completed",
            payload: {
              itemType: fallbackToolState.itemType,
              ...(typeof event.data.success === "boolean"
                ? { status: event.data.success ? "completed" : "failed" }
                : {}),
              title: fallbackToolState.title,
              ...(completionDetail ? { detail: completionDetail } : {}),
            },
          });
          return;
        }
        case "permission.requested": {
          const pending: PendingPermissionRequest = {
            requestId: event.data.requestId,
            signature: permissionSignature(event.data.permissionRequest),
            request: event.data.permissionRequest,
            requestType: mapPermissionRequestType(event.data.permissionRequest),
            detail: describePermissionRequest(event.data.permissionRequest),
            args: event.data.permissionRequest,
            toolCallId: event.data.permissionRequest.toolCallId,
            decision: createPromiseResolver<ProviderApprovalDecision>(),
          };
          context.pendingPermissionRequests.set(pending.requestId, pending);
          const waitingResolver = shiftMapQueue(
            context.waitingPermissionResolvers,
            pending.signature,
          );
          if (waitingResolver) {
            waitingResolver(pending);
          } else {
            pushMapQueue(context.permissionQueueBySignature, pending.signature, pending);
          }

          if (
            shouldAutoApprovePermissionRequest(
              context.session.runtimeMode,
              event.data.permissionRequest,
            )
          ) {
            context.ignoredPermissionRequestIds.add(pending.requestId);
            return;
          }

          yield* offerRuntimeEvent({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId: activeTurn?.turnId,
              requestId: pending.requestId,
              createdAt: event.timestamp,
              raw: event,
            }),
            type: "request.opened",
            payload: {
              requestType: pending.requestType,
              ...(pending.detail ? { detail: pending.detail } : {}),
              ...(pending.args !== undefined ? { args: pending.args } : {}),
            },
          });
          return;
        }
        case "permission.completed": {
          const pending = context.pendingPermissionRequests.get(event.data.requestId);
          if (pending) {
            context.pendingPermissionRequests.delete(event.data.requestId);
            removeQueuedValue(
              context.permissionQueueBySignature,
              pending.signature,
              (candidate) => candidate.requestId === pending.requestId,
            );
          }
          if (context.ignoredPermissionRequestIds.delete(event.data.requestId)) {
            return;
          }
          yield* offerRuntimeEvent({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId: activeTurn?.turnId,
              requestId: event.data.requestId,
              createdAt: event.timestamp,
              raw: event,
            }),
            type: "request.resolved",
            payload: {
              requestType: pending?.requestType ?? "unknown",
              ...(permissionResolutionToDecision(event.data.result.kind)
                ? { decision: permissionResolutionToDecision(event.data.result.kind) }
                : {}),
              resolution: event.data.result,
            },
          });
          return;
        }
        case "user_input.requested": {
          const request: CopilotUserInputRequest = {
            question: event.data.question,
            ...(event.data.choices ? { choices: event.data.choices } : {}),
            ...(event.data.allowFreeform !== undefined
              ? { allowFreeform: event.data.allowFreeform }
              : {}),
          };
          const pending: PendingUserInputRequest = {
            requestId: event.data.requestId,
            signature: userInputSignature(request),
            request,
            toolCallId: event.data.toolCallId,
            answers: createPromiseResolver<ProviderUserInputAnswers>(),
          };
          context.pendingUserInputRequests.set(pending.requestId, pending);
          const waitingResolver = shiftMapQueue(
            context.waitingUserInputResolvers,
            pending.signature,
          );
          if (waitingResolver) {
            waitingResolver(pending);
          } else {
            pushMapQueue(context.userInputQueueBySignature, pending.signature, pending);
          }

          yield* offerRuntimeEvent({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId: activeTurn?.turnId,
              requestId: pending.requestId,
              createdAt: event.timestamp,
              raw: event,
            }),
            type: "user-input.requested",
            payload: {
              questions: [
                {
                  id: "response",
                  header: "GitHub Copilot needs input",
                  question: event.data.question,
                  options: (event.data.choices ?? []).map((choice) => ({
                    label: choice,
                    description: choice,
                  })),
                },
              ],
            },
          });
          return;
        }
        case "user_input.completed": {
          const pending = context.pendingUserInputRequests.get(event.data.requestId);
          if (pending) {
            context.pendingUserInputRequests.delete(event.data.requestId);
            removeQueuedValue(
              context.userInputQueueBySignature,
              pending.signature,
              (candidate) => candidate.requestId === pending.requestId,
            );
          }
          yield* offerRuntimeEvent({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId: activeTurn?.turnId,
              requestId: event.data.requestId,
              createdAt: event.timestamp,
              raw: event,
            }),
            type: "user-input.resolved",
            payload: {
              answers: {
                response: event.data.answer ?? "",
              },
            },
          });
          return;
        }
        case "session.usage_info": {
          yield* offerRuntimeEvent({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId: activeTurn?.turnId,
              createdAt: event.timestamp,
              raw: event,
            }),
            type: "thread.token-usage.updated",
            payload: {
              usage: {
                usedTokens: event.data.currentTokens,
                totalProcessedTokens: event.data.conversationTokens ?? event.data.currentTokens,
                maxTokens: event.data.tokenLimit,
              },
            },
          });
          return;
        }
        case "session.title_changed": {
          yield* offerRuntimeEvent({
            ...buildEventBase({
              threadId: context.session.threadId,
              createdAt: event.timestamp,
              raw: event,
            }),
            type: "thread.metadata.updated",
            payload: {
              name: event.data.title,
            },
          });
          return;
        }
        case "session.mode_changed": {
          context.currentMode = event.data.newMode as CopilotSessionMode;
          return;
        }
        case "session.model_change": {
          context.session = {
            ...context.session,
            model: event.data.newModel,
            updatedAt: nowIso(),
          };
          return;
        }
        case "session.warning": {
          yield* offerRuntimeEvent({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId: activeTurn?.turnId,
              createdAt: event.timestamp,
              raw: event,
            }),
            type: "runtime.warning",
            payload: {
              message: event.data.message,
              detail: event.data,
            },
          });
          return;
        }
        case "session.error": {
          if (activeTurn) {
            activeTurn.failureMessage = event.data.message;
          }
          yield* offerRuntimeEvent({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId: activeTurn?.turnId,
              createdAt: event.timestamp,
              raw: event,
            }),
            type: "runtime.error",
            payload: {
              message: event.data.message,
              class: "provider_error",
              detail: event.data,
            },
          });
          return;
        }
        case "abort": {
          if (!activeTurn) {
            return;
          }
          activeTurn.aborted = true;
          yield* offerRuntimeEvent({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId: activeTurn.turnId,
              createdAt: event.timestamp,
              raw: event,
            }),
            type: "turn.aborted",
            payload: {
              reason: event.data.reason,
            },
          });
          return;
        }
        case "session.idle": {
          if (activeTurn) {
            yield* finalizeTurn(
              context,
              activeTurn.failureMessage
                ? "failed"
                : activeTurn.aborted || event.data.aborted
                  ? "interrupted"
                  : "completed",
            );
          } else if (context.session.status !== "closed") {
            context.session = {
              ...context.session,
              status: "ready",
              updatedAt: nowIso(),
            };
            yield* emitSessionState(context, "ready");
          }
          return;
        }
        case "session.shutdown": {
          if (activeTurn) {
            activeTurn.failureMessage = event.data.errorReason ?? activeTurn.failureMessage;
            yield* finalizeTurn(
              context,
              event.data.shutdownType === "error"
                ? "failed"
                : activeTurn.aborted
                  ? "interrupted"
                  : "completed",
            );
          }
          context.session = {
            ...context.session,
            status: "closed",
            updatedAt: nowIso(),
          };
          yield* offerRuntimeEvent({
            ...buildEventBase({
              threadId: context.session.threadId,
              createdAt: event.timestamp,
              raw: event,
            }),
            type: "session.exited",
            payload: {
              reason: event.data.errorReason ?? "Session ended",
              recoverable: event.data.shutdownType !== "error",
              exitKind: event.data.shutdownType === "error" ? "error" : "graceful",
            },
          });
          return;
        }
        default:
          return;
      }
    });

  const awaitPermissionDecision = async (
    context: CopilotSessionContext,
    request: SdkPermissionRequest,
  ): Promise<PermissionRequestResult> => {
    const signature = permissionSignature(request);
    const pending =
      shiftMapQueue(context.permissionQueueBySignature, signature) ??
      (await new Promise<PendingPermissionRequest>((resolve) => {
        pushMapQueue(context.waitingPermissionResolvers, signature, resolve);
      }));

    if (shouldAutoApprovePermissionRequest(context.session.runtimeMode, request)) {
      context.ignoredPermissionRequestIds.add(pending.requestId);
      return toPermissionDecision(pending.request, "acceptForSession");
    }

    return toPermissionDecision(pending.request, await pending.decision.promise);
  };

  const awaitUserInputResponse = async (
    context: CopilotSessionContext,
    request: CopilotUserInputRequest,
  ): Promise<CopilotUserInputResponse> => {
    const signature = userInputSignature(request);
    const pending =
      shiftMapQueue(context.userInputQueueBySignature, signature) ??
      (await new Promise<PendingUserInputRequest>((resolve) => {
        pushMapQueue(context.waitingUserInputResolvers, signature, resolve);
      }));

    const answers = await pending.answers.promise;
    const answer = extractUserInputAnswer(answers);
    return {
      answer,
      wasFreeform: chooseWasFreeform(request, answer),
    };
  };

  const stopSessionContext = (
    context: CopilotSessionContext,
  ): Effect.Effect<void, ProviderAdapterRequestError> =>
    Effect.tryPromise({
      try: async () => {
        settlePendingPermissions(context, "cancel");
        settlePendingUserInputs(context);
        context.unsubscribeEvents();
        await context.sdkSession.disconnect().catch(() => undefined);
        await stopCopilotClient(context.client);
      },
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/stop",
          detail: toMessage(cause, "Failed to stop Copilot SDK session."),
          cause,
        }),
    });

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
          issue: "GitHub Copilot currently supports only full-access runtime mode.",
        });
      }

      yield* validateModelSelection(input.modelSelection, "startSession");

      const existing = sessions.get(input.threadId);
      if (existing) {
        yield* stopSessionContext(existing).pipe(Effect.orDie);
        sessions.delete(input.threadId);
      }

      const settings = yield* serverSettingsService.getSettings.pipe(
        Effect.map((serverSettings) => serverSettings.providers.copilot),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "startSession",
              detail: "Failed to load Copilot settings.",
              cause,
            }),
        ),
      );

      const modelSelection: CopilotModelSelection = (input.modelSelection as
        | CopilotModelSelection
        | undefined) ?? {
        provider: PROVIDER,
        model: DEFAULT_MODEL_BY_PROVIDER[PROVIDER],
      };
      const normalizedOptions = normalizeCopilotModelOptionsWithCapabilities(
        getCopilotModelCapabilities(modelSelection.model),
        modelSelection.options,
      );
      const launch = buildCopilotSdkClientLaunch({
        settings,
        cwd: input.cwd,
      });
      const client =
        options?.createClient?.({
          settings,
          launch,
        }) ??
        new CopilotClient({
          ...launch.clientOptions,
          logLevel: "error",
        });

      const providerSessionId = readCopilotResumeCursor(input.resumeCursor);
      let contextRef: CopilotSessionContext | undefined;
      const workingDirectory = translateCopilotWorkingDirectory(input.cwd, launch.executionTarget);
      const sessionConfig: SessionConfig = {
        model: resolveApiModelId(modelSelection),
        streaming: true,
        ...(normalizedOptions?.reasoningEffort
          ? { reasoningEffort: normalizedOptions.reasoningEffort as CopilotReasoningEffort }
          : {}),
        onPermissionRequest: (request) => {
          if (!contextRef) {
            return { kind: "user-not-available" };
          }
          return awaitPermissionDecision(contextRef, request);
        },
        onUserInputRequest: (request) => {
          if (!contextRef) {
            return { answer: "", wasFreeform: true };
          }
          return awaitUserInputResponse(contextRef, request);
        },
        ...(workingDirectory ? { workingDirectory } : {}),
        includeSubAgentStreamingEvents: true,
      };

      const sdkSession = yield* Effect.tryPromise({
        try: async () =>
          providerSessionId
            ? client.resumeSession(providerSessionId, sessionConfig satisfies ResumeSessionConfig)
            : client.createSession(sessionConfig),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: providerSessionId ? "session/resume" : "session/create",
            detail: toMessage(cause, "Failed to start GitHub Copilot SDK session."),
            cause,
          }),
      });

      const unsubscribeEvents = sdkSession.on((event) => {
        if (!contextRef) {
          return;
        }
        runFork(handleSessionEvent(contextRef, event));
      });

      const history = yield* Effect.tryPromise({
        try: () => sdkSession.getMessages(),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/getMessages",
            detail: toMessage(cause, "Failed to load Copilot session history."),
            cause,
          }),
      }).pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<SessionEvent>)));
      const rebuilt = rebuildTurnsFromHistory(history);
      const createdAt = nowIso();
      const session: ProviderSession = {
        provider: PROVIDER,
        status: "ready",
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        model: modelSelection.model,
        threadId: input.threadId,
        resumeCursor: makeResumeCursor(sdkSession.sessionId, rebuilt.turns.length),
        createdAt,
        updatedAt: createdAt,
      };

      const context: CopilotSessionContext = {
        session,
        settings,
        client,
        sdkSession,
        unsubscribeEvents,
        initialResumeCursor: input.resumeCursor,
        ignoredPermissionRequestIds: new Set(),
        permissionQueueBySignature: new Map(),
        waitingPermissionResolvers: new Map(),
        userInputQueueBySignature: new Map(),
        waitingUserInputResolvers: new Map(),
        pendingPermissionRequests: new Map(),
        pendingUserInputRequests: new Map(),
        turns: [...rebuilt.turns],
        currentMode: "interactive",
        sessionBoundaryEventId: rebuilt.sessionBoundaryEventId,
        activeTurn: undefined,
      };
      contextRef = context;
      sessions.set(input.threadId, context);

      yield* offerRuntimeEvent({
        type: "session.started",
        eventId: nextEventId(),
        provider: PROVIDER,
        threadId: input.threadId,
        createdAt,
        payload: {
          resume: context.session.resumeCursor,
        },
      });
      yield* offerRuntimeEvent({
        type: "thread.started",
        eventId: nextEventId(),
        provider: PROVIDER,
        threadId: input.threadId,
        createdAt: nowIso(),
        payload: {
          providerThreadId: sdkSession.sessionId,
        },
      });
      yield* emitSessionState(context, "ready");

      return session;
    });

  const buildSdkAttachments = (
    attachments: ReadonlyArray<ChatAttachment>,
  ): Effect.Effect<NonNullable<MessageOptions["attachments"]>, ProviderAdapterRequestError> =>
    Effect.forEach(attachments, (attachment) =>
      Effect.tryPromise({
        try: async () => {
          const resolvedPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!resolvedPath) {
            throw new Error(`Invalid attachment id '${attachment.id}'.`);
          }
          const bytes = await readFile(resolvedPath);
          return {
            type: "blob" as const,
            data: bytes.toString("base64"),
            mimeType: attachment.mimeType,
            displayName: attachment.name,
          };
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/send",
            detail: toMessage(cause, "Failed to read Copilot image attachment."),
            cause,
          }),
      }),
    );

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
      const promptInput =
        input.input?.trim() ||
        (interactionMode === "plan"
          ? "Review the attached context and propose an implementation plan."
          : "Review the attached context and continue.");
      const attachments = input.attachments ?? [];
      const prompt = buildPrompt({
        text: promptInput,
        attachments,
        interactionMode,
      });
      const sdkAttachments =
        attachments.length > 0 ? yield* buildSdkAttachments(attachments) : undefined;
      const desiredMode = mapInteractionModeToSessionMode(interactionMode);
      if (context.currentMode !== desiredMode) {
        yield* Effect.tryPromise({
          try: () => context.sdkSession.rpc.mode.set({ mode: desiredMode }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/mode/set",
              detail: toMessage(cause, "Failed to change Copilot session mode."),
              cause,
            }),
        });
        context.currentMode = desiredMode;
      }

      const apiModel = resolveApiModelId(modelSelection);
      if (context.session.model !== modelSelection.model) {
        const setModelOptions = normalizedOptions?.reasoningEffort
          ? { reasoningEffort: normalizedOptions.reasoningEffort as CopilotReasoningEffort }
          : undefined;
        yield* Effect.tryPromise({
          try: () => context.sdkSession.setModel(apiModel, setModelOptions),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/model/set",
              detail: toMessage(cause, "Failed to switch Copilot session model."),
              cause,
            }),
        });
      }

      const turnId = nextTurnId();
      const itemId = nextItemId();
      context.activeTurn = {
        turnId,
        itemId,
        input: promptInput,
        interactionMode,
        attachments,
        toolCalls: new Map(),
        completedToolItems: [],
        assistantMessages: new Map(),
        reasoningBlocks: new Map(),
        assistantSegmentIndex: 0,
        pendingAssistantSegmentSplit: false,
        providerTurnId: undefined,
        lastPersistedEventId: undefined,
        lastUsage: undefined,
        failureMessage: undefined,
        aborted: false,
      };
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

      yield* Effect.tryPromise({
        try: () =>
          context.sdkSession.send({
            prompt,
            ...(sdkAttachments ? { attachments: sdkAttachments } : {}),
          }),
        catch: (cause) => {
          context.activeTurn = undefined;
          context.session = {
            ...context.session,
            status: "ready",
            activeTurnId: undefined,
            updatedAt: nowIso(),
          };
          return new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/send",
            detail: toMessage(cause, "Failed to send turn to GitHub Copilot."),
            cause,
          });
        },
      });

      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: context.session.resumeCursor,
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
      context.activeTurn.aborted = true;
      settlePendingPermissions(context, "cancel");
      settlePendingUserInputs(context);
      yield* Effect.tryPromise({
        try: () => context.sdkSession.abort(),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/abort",
            detail: toMessage(cause, "Failed to abort GitHub Copilot turn."),
            cause,
          }),
      });
    });

  const respondToRequest: CopilotAdapterShape["respondToRequest"] = (
    threadId,
    requestId,
    decision,
  ) =>
    Effect.gen(function* () {
      const context = yield* ensureOpenContext(threadId);
      const pending = context.pendingPermissionRequests.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/permission/respond",
          detail: `Unknown pending approval request: ${requestId}`,
        });
      }
      if (!pending.decision.settled()) {
        pending.decision.resolve(decision);
      }
    });

  const respondToUserInput: CopilotAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.gen(function* () {
      const context = yield* ensureOpenContext(threadId);
      const pending = context.pendingUserInputRequests.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/user-input/respond",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      }
      if (!pending.answers.settled()) {
        pending.answers.resolve(answers);
      }
    });

  const stopSession: CopilotAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* ensureContext(threadId);
      settlePendingPermissions(context, "cancel");
      settlePendingUserInputs(context);
      if (context.activeTurn) {
        context.activeTurn.aborted = true;
        yield* Effect.ignore(
          Effect.tryPromise({
            try: () => context.sdkSession.abort(),
            catch: () => undefined,
          }),
        );
      }
      yield* stopSessionContext(context);
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
      sessions.delete(threadId);
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
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        });
      }

      if (context.activeTurn) {
        context.activeTurn.aborted = true;
        settlePendingPermissions(context, "cancel");
        settlePendingUserInputs(context);
        yield* Effect.ignore(
          Effect.tryPromise({
            try: () => context.sdkSession.abort(),
            catch: () => undefined,
          }),
        );
        context.activeTurn = undefined;
      }

      const nextLength = Math.max(0, context.turns.length - numTurns);
      const lastTurnToKeep = nextLength > 0 ? context.turns[nextLength - 1] : undefined;
      const truncateTarget = lastTurnToKeep?.truncateToEventId ?? context.sessionBoundaryEventId;
      if (truncateTarget) {
        yield* Effect.tryPromise({
          try: () => context.sdkSession.rpc.history.truncate({ eventId: truncateTarget }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/history/truncate",
              detail: toMessage(cause, "Failed to roll back GitHub Copilot session history."),
              cause,
            }),
        });
      }

      context.turns = context.turns.slice(0, nextLength);
      context.session = {
        ...context.session,
        status: "ready",
        activeTurnId: undefined,
        updatedAt: nowIso(),
        resumeCursor: makeResumeCursor(context.sdkSession.sessionId, context.turns.length),
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
    Effect.forEach([...sessions.values()], (context) =>
      stopSessionContext(context).pipe(
        Effect.catch(() => Effect.void),
        Effect.tap(() =>
          Effect.sync(() => {
            sessions.delete(context.session.threadId);
          }),
        ),
      ),
    ).pipe(Effect.asVoid);

  yield* Effect.addFinalizer(() =>
    stopAll().pipe(
      Effect.catch(() => Effect.void),
      Effect.tap(() => Queue.shutdown(runtimeEventQueue)),
      Effect.tap(() => nativeEventLogger?.close() ?? Effect.void),
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
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

export function makeCopilotAdapterLive(options?: CopilotAdapterLiveOptions) {
  return Layer.effect(CopilotAdapter, makeCopilotAdapter(options));
}

export const CopilotAdapterLive = makeCopilotAdapterLive();
