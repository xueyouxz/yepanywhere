import { afterEach, describe, expect, it, vi } from "vitest";

type ExecFileCallback = (
  error: Error | null,
  stdout?: string,
  stderr?: string,
) => void;

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  return {
    ...actual,
    execFile: execFileMock,
  };
});

function completeExecFile(
  error: Error | null,
): Parameters<typeof execFileMock>[0] {
  return (
    _command: string,
    _args: string[],
    _options: unknown,
    callback: ExecFileCallback,
  ) => {
    callback(error, "", error ? error.message : "");
  };
}

describe("local STT runtime validation", () => {
  afterEach(() => {
    execFileMock.mockReset();
    vi.resetModules();
  });

  it("does not bootstrap when the frozen import check already passes", async () => {
    execFileMock.mockImplementation(completeExecFile(null));
    const { ensureLocalSttRuntime } = await import(
      "../../src/services/voice/localSttRuntime.js"
    );

    const result = await ensureLocalSttRuntime({
      backendLabel: "local STT",
      checkPython: "from faster_whisper import WhisperModel",
      bootstrapTask: "stt-bootstrap",
    });

    expect(result).toEqual({ ok: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]?.[1]).toEqual([
      "run",
      "--frozen",
      "-e",
      "stt",
      "python",
      "-c",
      "from faster_whisper import WhisperModel",
    ]);
  });

  it("runs the matching pixi bootstrap when the first import check fails", async () => {
    execFileMock
      .mockImplementationOnce(completeExecFile(new Error("missing package")))
      .mockImplementationOnce(completeExecFile(null))
      .mockImplementationOnce(completeExecFile(null));
    const { ensureLocalSttRuntime } = await import(
      "../../src/services/voice/localSttRuntime.js"
    );

    const result = await ensureLocalSttRuntime({
      backendLabel: "local Parakeet",
      checkPython: "import torch; from transformers import pipeline",
      bootstrapTask: "stt-bootstrap-parakeet",
    });

    expect(result).toEqual({ ok: true });
    expect(execFileMock).toHaveBeenCalledTimes(3);
    expect(execFileMock.mock.calls[1]?.[1]).toEqual([
      "run",
      "-e",
      "stt",
      "stt-bootstrap-parakeet",
    ]);
  });
});
