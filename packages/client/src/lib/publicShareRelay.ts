import type {
  PublicSessionShareResponse,
  RelayResponse,
} from "@yep-anywhere/shared";

function generateRequestId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function decodeWebSocketData(
  data: MessageEvent["data"],
): Promise<string> {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof Blob) {
    return await data.text();
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  return String(data);
}

export interface PublicShareRelayRequestOptions {
  path: string;
  relayUrl: string;
  relayUsername: string;
}

export async function fetchPublicShareRelayResponse({
  path,
  relayUrl,
  relayUsername,
}: PublicShareRelayRequestOptions): Promise<RelayResponse> {
  const ws = new WebSocket(relayUrl);
  const requestId = generateRequestId();

  return await new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      ws.close();
      reject(new Error("Share request timed out"));
    }, 30000);

    const cleanup = () => {
      window.clearTimeout(timeout);
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
    };

    ws.onopen = () => {
      ws.send(
        JSON.stringify({ type: "client_connect", username: relayUsername }),
      );
    };

    ws.onerror = () => {
      cleanup();
      reject(new Error("Relay connection failed"));
    };

    ws.onclose = () => {
      cleanup();
      reject(new Error("Relay connection closed"));
    };

    ws.onmessage = (event) => {
      void (async () => {
        let message: unknown;
        try {
          message = JSON.parse(await decodeWebSocketData(event.data));
        } catch {
          return;
        }

        if (
          message &&
          typeof message === "object" &&
          (message as { type?: unknown }).type === "client_connected"
        ) {
          ws.send(
            JSON.stringify({
              type: "request",
              id: requestId,
              method: "GET",
              path,
              headers: {},
            }),
          );
          return;
        }

        if (
          message &&
          typeof message === "object" &&
          (message as RelayResponse).type === "response" &&
          (message as RelayResponse).id === requestId
        ) {
          cleanup();
          ws.close();
          resolve(message as RelayResponse);
        }
      })();
    };
  });
}

export async function fetchPublicShareJsonViaRelay<T>(
  options: PublicShareRelayRequestOptions,
): Promise<T> {
  const response = await fetchPublicShareRelayResponse(options);
  if (response.status >= 400) {
    throw new Error("Share not found");
  }
  return response.body as T;
}

export async function fetchPublicShareBlobViaRelay(
  options: PublicShareRelayRequestOptions,
): Promise<Blob> {
  const response = await fetchPublicShareRelayResponse(options);
  if (response.status >= 400) {
    throw new Error("Share not found");
  }

  const contentType =
    response.headers?.["content-type"] ||
    response.headers?.["Content-Type"] ||
    "application/octet-stream";
  const body = response.body as unknown;
  if (
    body &&
    typeof body === "object" &&
    (body as { _binary?: unknown })._binary === true &&
    typeof (body as { data?: unknown }).data === "string"
  ) {
    const binary = atob((body as { data: string }).data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: contentType });
  }

  if (typeof body === "string") {
    return new Blob([body], { type: contentType });
  }

  return new Blob([JSON.stringify(body ?? null)], {
    type: contentType || "application/json",
  });
}

export async function fetchPublicShareViaRelay(options: {
  afterMessageId?: string;
  relayUrl: string;
  relayUsername: string;
  secret: string;
  viewerId: string;
}): Promise<PublicSessionShareResponse> {
  const shareParams = new URLSearchParams({ viewerId: options.viewerId });
  if (options.afterMessageId) {
    shareParams.set("afterMessageId", options.afterMessageId);
  }
  return await fetchPublicShareJsonViaRelay<PublicSessionShareResponse>({
    relayUrl: options.relayUrl,
    relayUsername: options.relayUsername,
    path: `/public-api/shares/${encodeURIComponent(options.secret)}?${shareParams}`,
  });
}
