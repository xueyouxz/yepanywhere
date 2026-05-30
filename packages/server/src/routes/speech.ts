import type { Context } from "hono";
import { Hono } from "hono";
import type { WSContext, WSEvents } from "hono/ws";
import { getLogger } from "../logging/logger.js";
import type { SpeechBackendRegistry } from "../services/voice/registry.js";

const logger = getLogger();

// biome-ignore lint/suspicious/noExplicitAny: third-party WS upgrade type
type UpgradeWebSocketFn = (createEvents: (c: Context) => WSEvents) => any;

export interface SpeechRouteDeps {
  speechBackendRegistry: SpeechBackendRegistry;
  upgradeWebSocket: UpgradeWebSocketFn;
}

interface StartMsg {
  type: "start";
  backendId?: string;
  mimeType?: string;
}
interface StopMsg {
  type: "stop";
}
type ClientMsg = StartMsg | StopMsg;

interface ServerMsg {
  type: "ready" | "interim" | "final" | "error";
  text?: string;
  message?: string;
}

function send(ws: WSContext, msg: ServerMsg): void {
  ws.send(JSON.stringify(msg));
}

export function createSpeechRoutes(deps: SpeechRouteDeps): Hono {
  const routes = new Hono();

  routes.get(
    "/ws",
    deps.upgradeWebSocket((_c: Context) => {
      const chunks: Buffer[] = [];
      let mimeType = "audio/webm;codecs=opus";
      let backendId: string | null = null;

      return {
        onOpen(_evt: Event, ws: WSContext) {
          send(ws, { type: "ready" });
        },

        onMessage(evt: MessageEvent, ws: WSContext) {
          const { data } = evt;

          // Binary frame → audio chunk
          if (data instanceof ArrayBuffer) {
            chunks.push(Buffer.from(data));
            return;
          }
          if (Buffer.isBuffer(data)) {
            chunks.push(data);
            return;
          }

          // Text frame → JSON control message
          let msg: ClientMsg;
          try {
            msg = JSON.parse(String(data)) as ClientMsg;
          } catch {
            logger.warn("Unparseable speech WS control frame");
            return;
          }

          if (msg.type === "start") {
            chunks.length = 0;
            backendId = msg.backendId ?? null;
            mimeType = msg.mimeType ?? "audio/webm;codecs=opus";
            return;
          }

          if (msg.type === "stop") {
            const audio = Buffer.concat(chunks);
            chunks.length = 0;

            if (!backendId) {
              send(ws, { type: "error", message: "No backend selected" });
              return;
            }

            const backend = deps.speechBackendRegistry.getBackend(backendId);
            if (!backend) {
              send(ws, {
                type: "error",
                message: `Backend not available: ${backendId}`,
              });
              return;
            }

            if (audio.length === 0) {
              send(ws, { type: "final", text: "" });
              return;
            }

            backend
              .transcribe(audio, { mimeType })
              .then((text) => {
                send(ws, { type: "final", text });
              })
              .catch((err: unknown) => {
                const message =
                  err instanceof Error ? err.message : String(err);
                logger.error(`Transcription error (${backendId}): ${message}`);
                send(ws, { type: "error", message });
              });
          }
        },

        onClose() {
          chunks.length = 0;
        },
      } satisfies WSEvents;
    }),
  );

  return routes;
}
