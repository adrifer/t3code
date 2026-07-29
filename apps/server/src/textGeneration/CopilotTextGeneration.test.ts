import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { CopilotSettings, ProviderInstanceId } from "@t3tools/contracts";
import { expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { makeCopilotTextGeneration } from "./CopilotTextGeneration.ts";

const copilotSdk = vi.hoisted(() => {
  const sendAndWait = vi.fn(async () => ({
    data: {
      content: JSON.stringify({
        subject: "Add Copilot support",
        body: "",
      }),
    },
  }));
  const disconnect = vi.fn(async () => undefined);
  const createSession = vi.fn(async () => ({ sendAndWait, disconnect }));
  const start = vi.fn(async () => undefined);
  const stop = vi.fn(async () => []);
  const forceStop = vi.fn(async () => undefined);
  const clientOptions: Array<Record<string, unknown>> = [];

  class CopilotClient {
    constructor(options: Record<string, unknown>) {
      clientOptions.push(options);
    }

    start = start;
    createSession = createSession;
    stop = stop;
    forceStop = forceStop;
  }

  return {
    CopilotClient,
    approveAll: vi.fn(),
    clientOptions,
    createSession,
    sendAndWait,
  };
});

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: copilotSdk.CopilotClient,
  approveAll: copilotSdk.approveAll,
}));

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);
const CopilotTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-copilot-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(CopilotTextGenerationTestLayer)("CopilotTextGeneration", (it) => {
  it.effect("supports custom instance IDs and the bundled CLI loader", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("copilot-work");
      const textGeneration = yield* makeCopilotTextGeneration(
        instanceId,
        decodeCopilotSettings({ binaryPath: "copilot" }),
        { PATH: "" },
      );

      const generated = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/copilot",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: createModelSelection(instanceId, "gpt-5.1-codex"),
      });

      expect(generated.subject).toBe("Add Copilot support");
      expect(copilotSdk.clientOptions.at(-1)?.cliPath).toMatch(
        /@github[/\\]copilot[/\\]npm-loader\.js$/,
      );
      expect(copilotSdk.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gpt-5.1-codex",
          workingDirectory: process.cwd(),
        }),
      );
      expect(copilotSdk.sendAndWait).toHaveBeenCalledOnce();
    }),
  );
});
