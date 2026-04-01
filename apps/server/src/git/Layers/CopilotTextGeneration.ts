import { Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  type ChatAttachment,
  CopilotModelSelection,
  TextGenerationError,
} from "@t3tools/contracts";
import {
  resolveApiModelId,
  normalizeCopilotModelOptionsWithCapabilities,
} from "@t3tools/shared/model";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  resolveCommandExecution,
  resolveWslExecutionTarget,
  translatePathForExecution,
} from "../../wsl.ts";
import { getCopilotModelCapabilities } from "../../provider/Layers/CopilotProvider.ts";
import { type TextGenerationShape, TextGeneration } from "../Services/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../Prompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "../Utils.ts";

type CopilotJsonLine = {
  readonly type?: string;
  readonly data?: Record<string, unknown>;
  readonly sessionId?: string;
  readonly usage?: unknown;
};

const makeCopilotTextGeneration = Effect.gen(function* () {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* Effect.service(ServerConfig);
  const serverSettingsService = yield* Effect.service(ServerSettingsService);

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("copilot", operation, cause, "Failed to collect process output"),
      ),
    );

  const materializeImageAttachmentPaths = (
    attachments: ReadonlyArray<ChatAttachment> | undefined,
    executionTarget: ReturnType<typeof resolveWslExecutionTarget>,
  ) => {
    if (!attachments || attachments.length === 0) {
      return [] as string[];
    }

    const imagePaths: string[] = [];
    for (const attachment of attachments) {
      const resolvedPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!resolvedPath) {
        continue;
      }
      imagePaths.push(translatePathForExecution(resolvedPath, executionTarget));
    }
    return imagePaths;
  };

  const resolveImagePathsForCwd = Effect.fn("CopilotTextGeneration.resolveImagePathsForCwd")(
    function* (cwd: string, attachments: ReadonlyArray<ChatAttachment> | undefined) {
      const copilotSettings = yield* Effect.map(
        serverSettingsService.getSettings,
        (settings) => settings.providers.copilot,
      ).pipe(Effect.catch(() => Effect.undefined));
      const executionTarget = resolveWslExecutionTarget({
        cwd,
        enabled: copilotSettings?.useWsl,
        distro: copilotSettings?.wslDistro,
      });
      return materializeImageAttachmentPaths(attachments, executionTarget);
    },
  );

  const buildStructuredPrompt = (
    prompt: string,
    outputSchemaJson: Schema.Top,
    imagePaths: ReadonlyArray<string>,
  ): string => {
    const schemaJson = JSON.stringify(toJsonSchemaObject(outputSchemaJson), null, 2);
    const attachmentSection =
      imagePaths.length === 0
        ? ""
        : `\n\nAttached images are available at these absolute paths:\n${imagePaths
            .map((imagePath) => `- ${imagePath}`)
            .join("\n")}\nInspect them if needed before producing the final JSON.`;
    return `${prompt}${attachmentSection}

Return only a JSON object that matches this JSON Schema exactly:
\`\`\`json
${schemaJson}
\`\`\`
`;
  };

  const parseCopilotJsonOutput = (
    operation: string,
    rawStdout: string,
  ): Effect.Effect<
    { readonly content: string; readonly sessionId?: string; readonly usage?: unknown },
    TextGenerationError
  > =>
    Effect.try({
      try: () => {
        const lines = rawStdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        const events = lines.map((line) => JSON.parse(line) as CopilotJsonLine);
        const assistantMessage = [...events]
          .toReversed()
          .find(
            (event) =>
              event.type === "assistant.message" && typeof event.data?.content === "string",
          );
        const result = [...events].toReversed().find((event) => event.type === "result");
        const content = assistantMessage?.data?.content;
        if (typeof content !== "string" || content.trim().length === 0) {
          throw new Error("Copilot CLI did not return a final assistant message.");
        }
        return {
          content,
          ...(typeof result?.sessionId === "string" ? { sessionId: result.sessionId } : {}),
          ...(result?.usage !== undefined ? { usage: result.usage } : {}),
        };
      },
      catch: (cause) =>
        new TextGenerationError({
          operation,
          detail: "Copilot CLI returned unexpected JSON output.",
          cause,
        }),
    });

  const runCopilotJson = Effect.fn("runCopilotJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    imagePaths = [],
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    imagePaths?: ReadonlyArray<string>;
    modelSelection: CopilotModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const copilotSettings = yield* Effect.map(
      serverSettingsService.getSettings,
      (settings) => settings.providers.copilot,
    ).pipe(Effect.catch(() => Effect.undefined));

    const normalizedOptions = normalizeCopilotModelOptionsWithCapabilities(
      getCopilotModelCapabilities(modelSelection.model),
      modelSelection.options,
    );

    const structuredPrompt = buildStructuredPrompt(prompt, outputSchemaJson, imagePaths);
    const execution = resolveCommandExecution({
      command: copilotSettings?.binaryPath || "copilot",
      args: [
        "-s",
        "--output-format",
        "json",
        "--allow-all-tools",
        "--allow-all-paths",
        "--model",
        resolveApiModelId(modelSelection),
        ...(normalizedOptions?.reasoningEffort
          ? ["--effort", normalizedOptions.reasoningEffort]
          : []),
        "-p",
        structuredPrompt,
      ],
      cwd,
      wsl: {
        enabled: copilotSettings?.useWsl,
        distro: copilotSettings?.wslDistro,
      },
    });
    const command = ChildProcess.make(execution.command, [...execution.args], {
      ...(execution.cwd ? { cwd: execution.cwd } : {}),
      shell: execution.shell,
    });

    const child = yield* commandSpawner
      .spawn(command)
      .pipe(
        Effect.mapError((cause) =>
          normalizeCliError(
            "copilot",
            operation,
            cause,
            "Failed to spawn GitHub Copilot CLI process",
          ),
        ),
      );

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        readStreamAsString(operation, child.stdout),
        readStreamAsString(operation, child.stderr),
        child.exitCode.pipe(
          Effect.mapError((cause) =>
            normalizeCliError(
              "copilot",
              operation,
              cause,
              "Failed to read GitHub Copilot CLI exit code",
            ),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    );

    if (exitCode !== 0) {
      const stderrDetail = stderr.trim();
      const stdoutDetail = stdout.trim();
      const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
      return yield* new TextGenerationError({
        operation,
        detail:
          detail.length > 0
            ? `GitHub Copilot CLI command failed: ${detail}`
            : `GitHub Copilot CLI command failed with code ${exitCode}.`,
      });
    }

    const parsed = yield* parseCopilotJsonOutput(operation, stdout);
    const structuredOutput = yield* Effect.try({
      try: () => JSON.parse(parsed.content),
      catch: (cause) =>
        new TextGenerationError({
          operation,
          detail: "Copilot did not return valid JSON structured output.",
          cause,
        }),
    });

    return yield* Schema.decodeEffect(outputSchemaJson)(structuredOutput).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Copilot returned invalid structured output.",
            cause,
          }),
        ),
      ),
    );
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "CopilotTextGeneration.generateCommitMessage",
  )(function* (input) {
    if (input.modelSelection.provider !== "copilot") {
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Invalid model selection.",
      });
    }

    if (input.includeBranch === true) {
      const { prompt } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: true,
      });
      const outputSchema = Schema.Struct({
        subject: Schema.String,
        body: Schema.String,
        branch: Schema.String,
      });

      const generated = yield* runCopilotJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        branch: sanitizeFeatureBranchName(generated.branch),
      };
    }

    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: false,
    });

    const generated = yield* runCopilotJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "CopilotTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    if (input.modelSelection.provider !== "copilot") {
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runCopilotJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "CopilotTextGeneration.generateBranchName",
  )(function* (input) {
    const imagePaths = yield* resolveImagePathsForCwd(input.cwd, input.attachments);
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    if (input.modelSelection.provider !== "copilot") {
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runCopilotJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      imagePaths,
      modelSelection: input.modelSelection,
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "CopilotTextGeneration.generateThreadTitle",
  )(function* (input) {
    const imagePaths = yield* resolveImagePathsForCwd(input.cwd, input.attachments);
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    if (input.modelSelection.provider !== "copilot") {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runCopilotJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      imagePaths,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});

export const CopilotTextGenerationLive = Layer.effect(TextGeneration, makeCopilotTextGeneration);
