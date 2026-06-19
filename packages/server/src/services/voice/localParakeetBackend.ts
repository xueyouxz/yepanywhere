import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getLogger } from "../../logging/logger.js";
import type {
  PrewarmableSpeechBackend,
  TranscribeOptions,
} from "./SpeechBackend.js";
import {
  ensureLocalSttRuntime,
  PIXI_COMMAND,
  PIXI_PYTHON_ARGS,
  PIXI_STT_ENV,
  cacheFreeSpaceSummary,
  defaultHuggingFaceHubCache,
  summarizeChildError,
} from "./localSttRuntime.js";
import { SerialQueue } from "./serialQueue.js";

const logger = getLogger();

const WORKER_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "parakeet_worker.py",
);

export const DEFAULT_PARAKEET_MODEL = "nvidia/parakeet-tdt-0.6b-v3";

/** Milliseconds to wait for model load before giving up. */
const MODEL_LOAD_TIMEOUT_MS = 180_000;

const PARAKEET_REPAIR_HINT =
  "If Hugging Face auth or a gated model is the problem, run `pixi run --frozen -e stt hf auth login` and accept the model terms on Hugging Face. If the error is ENOSPC, free the cache/tmp filesystem or set HF_HUB_CACHE, HF_XET_CACHE, and TMPDIR before starting YA.";

export class LocalParakeetBackend implements PrewarmableSpeechBackend {
  readonly id = "ya-parakeet";
  readonly label = "Local Parakeet (pixi stt)";

  private readonly model: string;
  private readonly device: string;

  private proc: ChildProcess | null = null;
  private warmPromise: Promise<void> | null = null;
  private workerReady = false;
  private workerModel: string | null = null;
  private workerDevice: string | null = null;
  private pendingResolve: ((text: string) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;
  // Serializes loads + transcriptions onto one queue (single worker by design),
  // so a request during a load waits instead of failing as "busy".
  private readonly queue = new SerialQueue();

  constructor(opts: { model?: string; device?: string } = {}) {
    this.model = opts.model ?? DEFAULT_PARAKEET_MODEL;
    this.device = opts.device ?? "auto";
  }

  async validate(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const runtime = await ensureLocalSttRuntime({
      backendLabel: "local Parakeet",
      checkPython: "import torch; from transformers import pipeline",
      bootstrapTask: "stt-bootstrap-parakeet",
    });
    if (!runtime.ok) return runtime;

    const cacheDir = defaultHuggingFaceHubCache();
    logger.info(
      `[Voice] ya-parakeet model preflight: loading fallback model "${this.model}" on device=${this.device} (cache=${cacheDir}; ${cacheFreeSpaceSummary(cacheDir)})`,
    );
    logger.info(`[Voice] ya-parakeet repair hints: ${PARAKEET_REPAIR_HINT}`);

    try {
      await this.startWorker(this.model, this.device);
      return { ok: true };
    } catch (error) {
      this.stopWorker();
      return {
        ok: false,
        reason: `${summarizeChildError(error)} ${PARAKEET_REPAIR_HINT}`,
      };
    }
  }

  private stopWorker(): void {
    const proc = this.proc;
    this.proc = null;
    this.warmPromise = null;
    this.workerReady = false;
    this.workerModel = null;
    this.workerDevice = null;
    proc?.kill();
  }

  private startWorker(model: string, device: string): Promise<void> {
    if (this.warmPromise) {
      if (this.workerModel === model && this.workerDevice === device) {
        return this.warmPromise;
      }
      if (!this.workerReady || this.pendingResolve) {
        throw new Error("Parakeet backend is busy with another request");
      }
      this.stopWorker();
    }

    this.warmPromise = new Promise<void>((resolve, reject) => {
      logger.info(
        `Starting parakeet worker via pixi env "${PIXI_STT_ENV}" (model=${model} device=${device})`,
      );
      this.workerReady = false;
      this.workerModel = model;
      this.workerDevice = device;

      const proc = spawn(
        PIXI_COMMAND,
        [...PIXI_PYTHON_ARGS, WORKER_SCRIPT, model, device],
        { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
      );
      this.proc = proc;

      let ready = false;
      let loadTimeout: NodeJS.Timeout | null = null;

      proc.stderr?.on("data", (chunk: Buffer) => {
        logger.debug(`[parakeet] ${chunk.toString().trim()}`);
      });

      proc.on("error", (error) => {
        if (this.proc !== proc) return;
        if (!ready) {
          if (loadTimeout) clearTimeout(loadTimeout);
          reject(error);
        }
      });

      proc.on("exit", (code) => {
        logger.warn(`Parakeet worker exited (code=${code})`);
        const currentWorkerExited = this.proc === proc;
        if (currentWorkerExited) {
          this.proc = null;
          this.warmPromise = null;
          this.workerReady = false;
          this.workerModel = null;
          this.workerDevice = null;
        }
        if (currentWorkerExited && this.pendingReject) {
          this.pendingReject(new Error("Parakeet worker exited unexpectedly"));
          this.pendingResolve = null;
          this.pendingReject = null;
        }
      });

      const rl = createInterface({ input: proc.stdout! });

      loadTimeout = setTimeout(() => {
        if (!ready) {
          reject(new Error("Parakeet model load timed out"));
          proc.kill();
        }
      }, MODEL_LOAD_TIMEOUT_MS);

      rl.on("line", (line: string) => {
        if (this.proc !== proc) return;
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
              this.workerReady = true;
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
          logger.warn(`Unparseable parakeet output: ${line}`);
        }
      });
    });

    return this.warmPromise;
  }

  async prewarm(options: TranscribeOptions = {}): Promise<void> {
    const model = options.model?.trim() || this.model;
    await this.queue.run(() => this.startWorker(model, this.device));
  }

  async transcribe(
    audio: Buffer,
    options: TranscribeOptions = {},
  ): Promise<string> {
    const model = options.model?.trim() || this.model;
    // Queue behind any in-flight load/transcribe: record audio, block on the
    // load, then transcribe — instead of rejecting as "busy".
    return this.queue.run(async () => {
      await this.startWorker(model, this.device);

      if (!this.proc?.stdin) {
        throw new Error("Parakeet worker is not running");
      }

      return new Promise<string>((resolve, reject) => {
        this.pendingResolve = resolve;
        this.pendingReject = reject;

        const req = {
          audio_b64: audio.toString("base64"),
          mime_type: options.mimeType ?? "audio/webm;codecs=opus",
        };

        this.proc!.stdin!.write(`${JSON.stringify(req)}\n`);
      });
    });
  }
}
