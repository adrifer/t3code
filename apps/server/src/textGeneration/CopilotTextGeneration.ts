import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { approveAll, CopilotClient } from "@github/copilot-sdk";

import {
  type ChatAttachment,
  type CopilotSettings,
  type ModelSelection,
  ProviderDriverKind,
  type ProviderInstanceId,
  TextGenerationError,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { getModelSelectionReasoningEffort, resolveApiModelId } from "@t3tools/shared/model";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { buildCopilotSdkClientLaunch } from "../provider/copilotSdk.ts";
import { type TextGenerationShape } from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";

const COPILOT_DRIVER_KIND = ProviderDriverKind.make("copilot");

function getCopilotReasoningEffort(
  modelSelection: ModelSelection,
): "low" | "medium" | "high" | "xhigh" | undefined {
  const value = getModelSelectionReasoningEffort(modelSelection);
  switch (value) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return value;
    default:
      return undefined;
  }
}

export const makeCopilotTextGeneration = Effect.fn("makeCopilotTextGeneration")(function* (
  instanceId: ProviderInstanceId,
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const serverConfig = yield* Effect.service(ServerConfig);
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;

  const materializeImageAttachmentPaths = (
    attachments: ReadonlyArray<ChatAttachment> | undefined,
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
      imagePaths.push(resolvedPath);
    }
    return imagePaths;
  };

  const resolveImagePaths = (
    attachments: ReadonlyArray<ChatAttachment> | undefined,
  ): ReadonlyArray<string> => {
    return materializeImageAttachmentPaths(attachments);
  };

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
    modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const structuredPrompt = buildStructuredPrompt(prompt, outputSchemaJson, imagePaths);
    const reasoningEffort = getCopilotReasoningEffort(modelSelection);
    const content = yield* Effect.tryPromise({
      try: async () => {
        const { clientOptions } = buildCopilotSdkClientLaunch({
          settings: copilotSettings,
          env: environment,
          runtime: { platform, arch },
        });
        const client = new CopilotClient({ ...clientOptions, logLevel: "error" });
        let session: Awaited<ReturnType<CopilotClient["createSession"]>> | undefined;
        try {
          await client.start();
          session = await client.createSession({
            model: resolveApiModelId(modelSelection, COPILOT_DRIVER_KIND),
            ...(reasoningEffort ? { reasoningEffort } : {}),
            workingDirectory: cwd,
            onPermissionRequest: approveAll,
          });
          const response = await session.sendAndWait({
            prompt: structuredPrompt,
            ...(imagePaths.length > 0
              ? {
                  attachments: imagePaths.map((imagePath) => ({
                    type: "file" as const,
                    path: imagePath,
                  })),
                }
              : {}),
          });
          const output = response?.data.content?.trim();
          if (!output) {
            throw new Error("Copilot SDK did not return a final assistant message.");
          }
          return output;
        } finally {
          await session?.disconnect().catch(() => undefined);
          const cleanupErrors = await client.stop().catch(async () => {
            await client.forceStop();
            return [];
          });
          if (cleanupErrors.length > 0) {
            await client.forceStop().catch(() => undefined);
          }
        }
      },
      catch: (cause) =>
        normalizeCliError("copilot", operation, cause, "GitHub Copilot SDK request failed"),
    });

    return yield* Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson))(content).pipe(
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
    if (input.modelSelection.instanceId !== instanceId) {
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

    if (input.modelSelection.instanceId !== instanceId) {
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
    const imagePaths = resolveImagePaths(input.attachments);
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    if (input.modelSelection.instanceId !== instanceId) {
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
    const imagePaths = resolveImagePaths(input.attachments);
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    if (input.modelSelection.instanceId !== instanceId) {
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
