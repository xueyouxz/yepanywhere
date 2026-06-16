import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { getLogger } from "../../logging/logger.js";
import type { SpeechBackend, TranscribeOptions } from "./SpeechBackend.js";

const execFileAsync = promisify(execFile);
const logger = getLogger();

const WORKER_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "whisper_worker.py",
);

const PIXI_COMMAND = "pixi";
const PIXI_STT_ENV = "stt";
const PIXI_PYTHON_ARGS = ["run", "--frozen", "-e", PIXI_STT_ENV, "python"];
const PIXI_STT_READY_HINT =
  "Run `pixi run -e stt stt-bootstrap` from the YA checkout, then restart YA.";

/** Milliseconds to wait for model load before giving up. */
const MODEL_LOAD_TIMEOUT_MS = 120_000;

function summarizeChildError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const record = error as {
      code?: unknown;
      message?: unknown;
      stderr?: unknown;
    };
    const stderr =
      typeof record.stderr === "string" ? record.stderr.trim() : "";
    if (stderr) return stderr.split("\n").slice(-4).join(" ");
    if (typeof record.code === "string" && typeof record.message === "string") {
      return `${record.code}: ${record.message}`;
    }
    if (typeof record.message === "string") return record.message;
  }
  return String(error);
}

export class LocalWhisperBackend implements SpeechBackend {
  readonly id = "ya-whisper";
  readonly label = "Local Whisper (pixi stt)";

  private readonly model: string;
  private readonly device: string;
  private readonly computeType: string;

  private proc: ChildProcess | null = null;
  private warmPromise: Promise<void> | null = null;
  private pendingResolve: ((text: string) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;

  constructor(opts: { model?: string; device?: string; computeType?: string } = {}) {
    this.model = opts.model ?? "distil-large-v3";
    this.device = opts.device ?? "cpu";
    this.computeType = opts.computeType ?? "int8";
  }

  async validate(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await execFileAsync(
        PIXI_COMMAND,
        [...PIXI_PYTHON_ARGS, "-c", "from faster_whisper import WhisperModel"],
        { cwd: process.cwd(), timeout: 30_000 },
      );
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: `local STT pixi environment is not ready. ${PIXI_STT_READY_HINT} Detail: ${summarizeChildError(error)}`,
      };
    }
  }

  private startWorker(): Promise<void> {
    if (this.warmPromise) return this.warmPromise;

    this.warmPromise = new Promise<void>((resolve, reject) => {
      logger.info(
        `Starting whisper worker via pixi env "${PIXI_STT_ENV}" (model=${this.model} device=${this.device} compute_type=${this.computeType})`,
      );

      const proc = spawn(
        PIXI_COMMAND,
        [
          ...PIXI_PYTHON_ARGS,
          WORKER_SCRIPT,
          this.model,
          this.device,
          this.computeType,
        ],
        { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
      );
      this.proc = proc;

      let ready = false;
      let loadTimeout: NodeJS.Timeout | null = null;

      proc.stderr?.on("data", (chunk: Buffer) => {
        logger.debug(`[whisper] ${chunk.toString().trim()}`);
      });

      proc.on("error", (error) => {
        if (!ready) {
          if (loadTimeout) clearTimeout(loadTimeout);
          reject(error);
        }
      });

      proc.on("exit", (code) => {
        logger.warn(`Whisper worker exited (code=${code})`);
        this.proc = null;
        this.warmPromise = null;
        if (this.pendingReject) {
          this.pendingReject(new Error("Whisper worker exited unexpectedly"));
          this.pendingResolve = null;
          this.pendingReject = null;
        }
      });

      const rl = createInterface({ input: proc.stdout! });

      loadTimeout = setTimeout(() => {
        if (!ready) {
          reject(new Error("Whisper model load timed out"));
          proc.kill();
        }
      }, MODEL_LOAD_TIMEOUT_MS);

      rl.on("line", (line: string) => {
        try {
          const msg = JSON.parse(line) as {
            status?: string;
            text?: string;
            error?: string;
          };

          if (!ready) {
            clearTimeout(loadTimeout);
            if (msg.status === "ready") {
              ready = true;
              resolve();
            } else {
              reject(new Error(msg.error ?? "Worker failed to start"));
            }
            return;
          }

          if (this.pendingResolve && this.pendingReject) {
            if (msg.error) {
              this.pendingReject(new Error(msg.error));
            } else {
              this.pendingResolve(msg.text ?? "");
            }
            this.pendingResolve = null;
            this.pendingReject = null;
          }
        } catch {
          logger.warn(`Unparseable whisper output: ${line}`);
        }
      });
    });

    return this.warmPromise;
  }

  async transcribe(audio: Buffer, options: TranscribeOptions = {}): Promise<string> {
    if (this.pendingResolve) {
      throw new Error("Whisper backend is busy with another request");
    }

    await this.startWorker();

    if (!this.proc?.stdin) {
      throw new Error("Whisper worker is not running");
    }

    return new Promise<string>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      const req = {
        audio_b64: audio.toString("base64"),
        mime_type: options.mimeType ?? "audio/webm;codecs=opus",
        prompt: options.prompt ?? "",
      };

      this.proc!.stdin!.write(`${JSON.stringify(req)}\n`);
    });
  }
}
