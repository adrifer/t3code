import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, expect, vi } from "vitest";

const nodePtyMock = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node-pty", () => nodePtyMock);

import { PtyAdapter } from "../Services/PTY";
import { layer as NodePTYLayer } from "./NodePTY";

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

afterEach(() => {
  nodePtyMock.spawn.mockReset();
  setPlatform(originalPlatform);
});

it.layer(NodeServices.layer, { excludeTestServices: true })("NodePTY", (it) => {
  it.effect("converts synchronous node-pty spawn failures into PtySpawnError", () =>
    Effect.gen(function* () {
      setPlatform("win32");
      nodePtyMock.spawn.mockImplementation(() => {
        throw new Error("File not found: ");
      });

      const error = yield* Effect.flip(
        Effect.gen(function* () {
          const pty = yield* PtyAdapter;
          return yield* pty.spawn({
            shell: "wsl.exe",
            args: ["--version"],
            cwd: String.raw`C:\Users\track`,
            cols: 120,
            rows: 30,
            env: {},
          });
        }).pipe(Effect.provide(NodePTYLayer)),
      );

      expect(error).toMatchObject({
        _tag: "PtySpawnError",
        adapter: "node-pty",
        message: "Failed to spawn PTY process",
      });
      expect(nodePtyMock.spawn).toHaveBeenCalledWith(
        "wsl.exe",
        ["--version"],
        expect.objectContaining({
          cwd: String.raw`C:\Users\track`,
          cols: 120,
          rows: 30,
        }),
      );
    }),
  );
});
