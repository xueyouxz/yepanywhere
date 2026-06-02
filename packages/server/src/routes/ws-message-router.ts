import type { RemoteClientMessage } from "@yep-anywhere/shared";
import {
  BinaryEnvelopeError,
  BinaryFormat,
  BinaryFrameError,
  isBinaryData,
  isClientCapabilities,
} from "@yep-anywhere/shared";
import { decompressGzip, decryptBinaryEnvelopeRaw } from "../crypto/index.js";
import type { UploadManager } from "../uploads/manager.js";
import type {
  ConnectionState,
  HandleMessageOptions,
  RelayUploadState,
  SendFn,
  WSAdapter,
} from "./ws-relay-handlers.js";
import { hasEstablishedSrpTransport } from "./ws-transport-auth.js";
import {
  isBinaryEncryptedEnvelope,
  rejectPlaintextBinaryWhenEncryptedRequired,
  unwrapSequencedClientMessage,
} from "./ws-transport-message-auth.js";

interface DecodeFrameDeps {
  uploads: Map<string, RelayUploadState>;
  send: SendFn;
  uploadManager: UploadManager;
  routeClientMessage: (msg: RemoteClientMessage) => Promise<void>;
  handleBinaryUploadChunk: (
    uploads: Map<string, RelayUploadState>,
    payload: Uint8Array,
    send: SendFn,
    uploadManager: UploadManager,
  ) => Promise<void>;
}

/**
 * Decode a WS frame into parsed JSON when it needs SRP/auth processing.
 * Returns null when the frame was fully handled.
 */
export async function decodeFrameToParsedMessage(
  ws: WSAdapter,
  data: unknown,
  options: HandleMessageOptions,
  connState: ConnectionState,
  srpRequiredPolicy: boolean,
  deps: DecodeFrameDeps,
): Promise<unknown | null> {
  const {
    uploads,
    send,
    uploadManager,
    routeClientMessage,
    handleBinaryUploadChunk,
  } = deps;

  const isFrameBinary = options.isBinary ?? isBinaryData(data);

  if (isFrameBinary) {
    let bytes: Uint8Array;
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
      bytes = data;
    } else {
      console.warn("[WS Relay] Binary frame has unexpected data type");
      return null;
    }

    if (bytes.length === 0) {
      console.warn("[WS Relay] Empty binary frame");
      return null;
    }

    if (
      hasEstablishedSrpTransport(connState) &&
      isBinaryEncryptedEnvelope(bytes, connState)
    ) {
      try {
        const result = connState.sessionKey
          ? decryptBinaryEnvelopeRaw(bytes, connState.sessionKey)
          : null;
        if (!result) {
          console.warn("[WS Relay] Failed to decrypt binary envelope");
          ws.close(4004, "Decryption failed");
          return null;
        }

        const { format, payload } = result;

        if (format === BinaryFormat.BINARY_UPLOAD) {
          await handleBinaryUploadChunk(uploads, payload, send, uploadManager);
          return null;
        }

        if (
          format !== BinaryFormat.JSON &&
          format !== BinaryFormat.COMPRESSED_JSON
        ) {
          const formatByte = format as number;
          console.warn(
            `[WS Relay] Unsupported encrypted format: 0x${formatByte.toString(16).padStart(2, "0")}`,
          );
          send({
            type: "response",
            id: "binary-format-error",
            status: 400,
            body: {
              error: `Unsupported binary format: 0x${formatByte.toString(16).padStart(2, "0")}`,
            },
          });
          return null;
        }

        try {
          let jsonStr: string;
          if (format === BinaryFormat.COMPRESSED_JSON) {
            jsonStr = decompressGzip(payload);
          } else {
            jsonStr = new TextDecoder().decode(payload);
          }
          const parsed = JSON.parse(jsonStr);
          const msg = unwrapSequencedClientMessage(ws, connState, parsed);
          if (!msg) {
            return null;
          }

          if (isClientCapabilities(msg)) {
            connState.supportedFormats = new Set(msg.formats);
            console.log(
              `[WS Relay] Client capabilities: formats=${[...connState.supportedFormats].map((f) => `0x${f.toString(16).padStart(2, "0")}`).join(", ")}`,
            );
            return null;
          }

          await routeClientMessage(msg);
          return null;
        } catch {
          console.warn("[WS Relay] Failed to parse decrypted binary envelope");
          ws.close(4004, "Decryption failed");
          return null;
        }
      } catch (err) {
        if (err instanceof BinaryEnvelopeError) {
          console.warn(
            `[WS Relay] Binary envelope error (${err.code}):`,
            err.message,
          );
          if (err.code === "UNKNOWN_VERSION") {
            ws.close(4002, err.message);
          }
        } else {
          console.warn("[WS Relay] Failed to process binary envelope:", err);
        }
        return null;
      }
    }

    if (
      rejectPlaintextBinaryWhenEncryptedRequired(
        ws,
        connState,
        srpRequiredPolicy,
      )
    ) {
      return null;
    }

    try {
      const format = bytes[0] as number;
      if (
        format !== BinaryFormat.JSON &&
        format !== BinaryFormat.BINARY_UPLOAD &&
        format !== BinaryFormat.COMPRESSED_JSON
      ) {
        throw new BinaryFrameError(
          `Unknown format byte: 0x${format.toString(16).padStart(2, "0")}`,
          "UNKNOWN_FORMAT",
        );
      }
      const payload = bytes.slice(1);
      connState.useBinaryFrames = true;

      if (format === BinaryFormat.BINARY_UPLOAD) {
        await handleBinaryUploadChunk(uploads, payload, send, uploadManager);
        return null;
      }

      if (format !== BinaryFormat.JSON) {
        console.warn(
          `[WS Relay] Unsupported binary format: 0x${format.toString(16).padStart(2, "0")}`,
        );
        send({
          type: "response",
          id: "binary-format-error",
          status: 400,
          body: {
            error: `Unsupported binary format: 0x${format.toString(16).padStart(2, "0")}`,
          },
        });
        return null;
      }

      const decoder = new TextDecoder("utf-8", { fatal: true });
      const json = decoder.decode(payload);
      return JSON.parse(json);
    } catch (err) {
      if (err instanceof BinaryFrameError) {
        console.warn(
          `[WS Relay] Binary frame error (${err.code}):`,
          err.message,
        );
        if (err.code === "UNKNOWN_FORMAT") {
          ws.close(4002, err.message);
        }
      } else {
        console.warn("[WS Relay] Failed to decode binary frame:", err);
      }
      return null;
    }
  }

  let textData: string;
  if (typeof data === "string") {
    textData = data;
  } else if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
    textData = Buffer.from(data).toString("utf-8");
  } else {
    console.warn("[WS Relay] Ignoring unknown message type");
    return null;
  }

  try {
    return JSON.parse(textData);
  } catch {
    console.warn("[WS Relay] Failed to parse message:", textData);
    return null;
  }
}

interface MessageRouteHandlers {
  onRequest: (msg: RemoteClientMessage & { type: "request" }) => Promise<void>;
  onSubscribe: (
    msg: RemoteClientMessage & { type: "subscribe" },
  ) => Promise<void> | void;
  onUnsubscribe: (
    msg: RemoteClientMessage & { type: "unsubscribe" },
  ) => Promise<void> | void;
  onUploadStart: (
    msg: RemoteClientMessage & { type: "upload_start" },
  ) => Promise<void>;
  onUploadChunk: (
    msg: RemoteClientMessage & { type: "upload_chunk" },
  ) => Promise<void>;
  onUploadEnd: (
    msg: RemoteClientMessage & { type: "upload_end" },
  ) => Promise<void>;
  onPing: (msg: RemoteClientMessage & { type: "ping" }) => Promise<void> | void;
  onDeviceMessage?: (msg: RemoteClientMessage) => Promise<void> | void;
}

function getMessageId(msg: RemoteClientMessage): string | undefined {
  switch (msg.type) {
    case "request":
      return msg.id;
    case "subscribe":
      return msg.subscriptionId;
    case "upload_start":
    case "upload_chunk":
    case "upload_end":
      return msg.uploadId;
    case "device_stream_start":
    case "device_stream_stop":
    case "device_webrtc_answer":
    case "device_ice_candidate":
      return (msg as { sessionId?: string }).sessionId;
    default:
      return undefined;
  }
}

/**
 * Route a parsed client message and normalize error responses.
 */
export async function routeClientMessageSafely(
  msg: RemoteClientMessage,
  send: SendFn,
  handlers: MessageRouteHandlers,
): Promise<void> {
  try {
    switch (msg.type) {
      case "request":
        await handlers.onRequest(msg);
        break;
      case "subscribe":
        await handlers.onSubscribe(msg);
        break;
      case "unsubscribe":
        await handlers.onUnsubscribe(msg);
        break;
      case "upload_start":
        await handlers.onUploadStart(msg);
        break;
      case "upload_chunk":
        await handlers.onUploadChunk(msg);
        break;
      case "upload_end":
        await handlers.onUploadEnd(msg);
        break;
      case "ping":
        await handlers.onPing(msg);
        break;
      case "device_stream_start":
      case "device_stream_stop":
      case "device_webrtc_answer":
      case "device_ice_candidate":
        if (handlers.onDeviceMessage) {
          await handlers.onDeviceMessage(msg);
        } else {
          console.warn("[WS Relay] Device message received but no handler");
        }
        break;
      default:
        console.warn(
          "[WS Relay] Unknown message type:",
          (msg as { type?: string }).type,
        );
    }
  } catch (err) {
    const messageId = getMessageId(msg);
    console.error(
      `[WS Relay] Unhandled error in routeMessage (type=${msg.type}, id=${messageId}):`,
      err,
    );
    if (messageId) {
      try {
        send({
          type: "response",
          id: messageId,
          status: 500,
          body: { error: "Internal server error" },
        });
      } catch (sendErr) {
        console.warn("[WS Relay] Failed to send error response:", sendErr);
      }
    }
  }
}
