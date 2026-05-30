import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type UploadClientMessage,
  type UploadCompleteMessage,
  type UploadErrorMessage,
  type UploadProgressMessage,
  type UploadServerMessage,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { WSContext, WSEvents } from "hono/ws";
import type { ProjectScanner } from "../projects/scanner.js";
import {
  UploadManager,
  getProjectAttachmentDir,
  resolveUploadStoragePath,
  UPLOADS_DIR,
} from "../uploads/index.js";

/** Progress update interval in bytes (64KB) */
const PROGRESS_INTERVAL_BYTES = 64 * 1024;

// biome-ignore lint/suspicious/noExplicitAny: Complex third-party type from @hono/node-ws
type UpgradeWebSocketFn = (createEvents: (c: Context) => WSEvents) => any;

export interface UploadDeps {
  scanner: ProjectScanner;
  upgradeWebSocket: UpgradeWebSocketFn;
  /** Maximum upload file size in bytes. 0 = unlimited */
  maxUploadSizeBytes?: number;
}

export function createUploadRoutes(deps: UploadDeps): Hono {
  const routes = new Hono();
  const uploadManager = new UploadManager({
    maxUploadSizeBytes: deps.maxUploadSizeBytes,
  });

  const sendMessage = (ws: WSContext, msg: UploadServerMessage) => {
    ws.send(JSON.stringify(msg));
  };

  const sendError = (ws: WSContext, message: string, code?: string) => {
    const errorMsg: UploadErrorMessage = { type: "error", message, code };
    sendMessage(ws, errorMsg);
  };

  // WebSocket endpoint: /projects/:projectId/sessions/:sessionId/upload/ws
  routes.get(
    "/projects/:projectId/sessions/:sessionId/upload/ws",
    deps.upgradeWebSocket((c) => {
      const projectId = c.req.param("projectId") as string;
      const sessionId = c.req.param("sessionId") as string;

      // Track current upload for this connection
      let currentUploadId: string | null = null;
      let lastProgressSent = 0;

      // Validation promise - we need to await this before processing messages
      // because onOpen can be async but @hono/node-ws doesn't wait for it
      let validationPromise: Promise<boolean> | null = null;
      let validationResult: boolean | null = null;

      // Message queue to serialize async message handling
      // This prevents race conditions where binary chunks arrive before
      // the async startUpload() completes
      let messageQueue: Promise<void> = Promise.resolve();
      let projectPath: string | null = null;

      const validate = async (): Promise<boolean> => {
        // Validate projectId format
        if (!isUrlProjectId(projectId)) {
          return false;
        }

        // Validate project exists, including first-time directories that have
        // not produced provider session files yet.
        const project = await deps.scanner.getOrCreateProject(projectId);
        if (!project) {
          return false;
        }
        projectPath = project.path;

        return true;
      };

      // Process a single message - must be called sequentially via the queue
      const processMessage = async (
        data: string | ArrayBuffer | SharedArrayBuffer | Buffer | Blob,
        ws: WSContext,
      ): Promise<void> => {
        // Wait for validation to complete if it hasn't yet
        if (validationResult === null && validationPromise) {
          validationResult = await validationPromise;
        }

        if (!validationResult) {
          sendError(ws, "Connection not validated", "NOT_VALIDATED");
          return;
        }

        // When using the unified upgrade handler with wss.handleUpgrade,
        // the 'ws' library delivers ALL messages as Buffer by default,
        // bypassing @hono/node-ws's text/binary conversion.
        // We need to handle both Buffer and string data types.

        // Convert Buffer/ArrayBuffer to string for potential JSON parsing
        let stringData: string | null = null;
        let bufferData: Buffer | null = null;

        if (typeof data === "string") {
          stringData = data;
        } else if (
          data instanceof ArrayBuffer ||
          data instanceof SharedArrayBuffer ||
          Buffer.isBuffer(data)
        ) {
          bufferData = Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as ArrayBuffer);
          // Try to interpret as UTF-8 string for JSON control messages
          stringData = bufferData.toString("utf8");
        } else if (data instanceof Blob) {
          // Blob handling (rare in Node.js WebSocket but possible)
          const arrayBuffer = await data.arrayBuffer();
          bufferData = Buffer.from(arrayBuffer);
          stringData = bufferData.toString("utf8");
        }

        // Try to parse as JSON control message first
        let msg: UploadClientMessage | null = null;
        if (stringData) {
          const trimmed = stringData.trim();
          if (trimmed.startsWith("{")) {
            try {
              msg = JSON.parse(trimmed) as UploadClientMessage;
            } catch {
              // Not valid JSON - treat as binary data
              msg = null;
            }
          }
        }

        // If we parsed a control message, handle it
        if (msg !== null) {
          switch (msg.type) {
            case "start": {
              // Clean up any previous upload
              if (currentUploadId) {
                await uploadManager.cancelUpload(currentUploadId);
              }

              try {
                const { uploadId } = await uploadManager.startUpload(
                  projectId,
                  sessionId,
                  msg.name,
                  msg.size,
                  msg.mimeType,
                  projectPath ?? undefined,
                  msg.width !== undefined && msg.height !== undefined
                    ? { width: msg.width, height: msg.height }
                    : undefined,
                );
                currentUploadId = uploadId;
                lastProgressSent = 0;
              } catch (err) {
                const message =
                  err instanceof Error ? err.message : "Failed to start upload";
                sendError(ws, message, "START_ERROR");
              }
              break;
            }

            case "end": {
              if (!currentUploadId) {
                sendError(ws, "No upload in progress", "NO_UPLOAD");
                return;
              }

              const uploadId = currentUploadId;
              try {
                const file = await uploadManager.completeUpload(uploadId);
                const complete: UploadCompleteMessage = {
                  type: "complete",
                  file,
                };
                sendMessage(ws, complete);
                currentUploadId = null;
              } catch (err) {
                const message =
                  err instanceof Error
                    ? err.message
                    : "Failed to complete upload";
                sendError(ws, message, "COMPLETE_ERROR");
                await uploadManager.cancelUpload(uploadId);
                currentUploadId = null;
              }
              break;
            }

            case "cancel": {
              if (currentUploadId) {
                await uploadManager.cancelUpload(currentUploadId);
                currentUploadId = null;
              }
              break;
            }
          }
          return;
        }

        // Otherwise, treat as binary chunk data
        if (!currentUploadId) {
          sendError(
            ws,
            "No upload started - send start message first",
            "NO_UPLOAD",
          );
          return;
        }

        const uploadId = currentUploadId;
        try {
          // Convert to Buffer if needed (bufferData should already be set at this point)
          const chunk =
            bufferData ?? (typeof data === "string" ? Buffer.from(data) : null);
          if (!chunk) {
            sendError(ws, "Invalid chunk data", "INVALID_CHUNK");
            return;
          }

          const bytesReceived = await uploadManager.writeChunk(uploadId, chunk);

          // Send progress updates periodically
          if (bytesReceived - lastProgressSent >= PROGRESS_INTERVAL_BYTES) {
            const progress: UploadProgressMessage = {
              type: "progress",
              bytesReceived,
            };
            sendMessage(ws, progress);
            lastProgressSent = bytesReceived;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "Write failed";
          sendError(ws, message, "WRITE_ERROR");
          await uploadManager.cancelUpload(uploadId);
          currentUploadId = null;
        }
      };

      return {
        onOpen(_evt, ws) {
          // Start validation (don't await - @hono/node-ws doesn't support async onOpen)
          validationPromise = validate();
          validationPromise.then((result) => {
            validationResult = result;
            if (!result) {
              sendError(ws, "Project validation failed", "VALIDATION_FAILED");
              ws.close(1008, "Validation failed");
            }
          });
        },

        onMessage(evt, ws) {
          // Queue this message to be processed after all previous messages complete
          // This serializes async processing and prevents race conditions
          messageQueue = messageQueue.then(() =>
            processMessage(evt.data, ws).catch((err) => {
              console.error("[Upload WS] Unexpected error:", err);
              sendError(ws, "Internal error", "INTERNAL_ERROR");
            }),
          );
        },

        async onClose(_evt, _ws) {
          // Wait for any pending messages to complete
          await messageQueue;
          // Clean up partial uploads on disconnect
          if (currentUploadId) {
            await uploadManager.cancelUpload(currentUploadId);
          }
        },

        onError(_evt, _ws) {
          // Clean up on error
          if (currentUploadId) {
            uploadManager.cancelUpload(currentUploadId).catch(() => {});
          }
        },
      };
    }),
  );

  // GET endpoint: /projects/:projectId/sessions/:sessionId/upload/:filename
  // Serves uploaded files for viewing in the client
  routes.get(
    "/projects/:projectId/sessions/:sessionId/upload/:filename",
    async (c) => {
      const projectId = c.req.param("projectId") as string;
      const sessionId = c.req.param("sessionId") as string;
      const filename = c.req.param("filename") as string;

      // Validate projectId format
      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID" }, 400);
      }

      // Validate filename - must have UUID prefix format
      if (!filename || !/^[0-9a-f-]{36}_/.test(filename)) {
        return c.json({ error: "Invalid filename" }, 400);
      }

      const project = await deps.scanner.getOrCreateProject(projectId);
      if (!project) {
        return c.json({ error: "Unknown project" }, 404);
      }

      const filePath = join(getProjectAttachmentDir(project.path, sessionId), filename);
      const legacyFilePath = resolveUploadStoragePath(
        UPLOADS_DIR,
        projectId,
        sessionId,
        filename,
      );

      try {
        const candidates = [filePath, legacyFilePath].filter(
          (candidate): candidate is string => Boolean(candidate),
        );

        for (const candidate of candidates) {
          const stats = await stat(candidate).catch((err) => {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
              return null;
            }
            throw err;
          });
          if (!stats || !stats.isFile()) {
            continue;
          }

          // Determine content type from filename extension
          const ext = filename.split(".").pop()?.toLowerCase() ?? "";
          const mimeTypes: Record<string, string> = {
            png: "image/png",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            gif: "image/gif",
            webp: "image/webp",
            svg: "image/svg+xml",
            pdf: "application/pdf",
            txt: "text/plain",
            json: "application/json",
          };
          const contentType = mimeTypes[ext] ?? "application/octet-stream";

          c.header("Content-Type", contentType);
          c.header("Content-Length", stats.size.toString());
          c.header("Cache-Control", "private, max-age=3600");

          return stream(c, async (s) => {
            const readable = createReadStream(candidate);
            for await (const chunk of readable) {
              await s.write(chunk);
            }
          });
        }

        return c.json({ error: "File not found" }, 404);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return c.json({ error: "File not found" }, 404);
        }
        console.error("[Upload] Error serving file:", err);
        return c.json({ error: "Internal error" }, 500);
      }
    },
  );

  return routes;
}
