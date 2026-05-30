let estimatedServerOffsetMs = 0;
let hasServerOffset = false;

function coerceMs(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function getServerClockTimestamp(
  clientWallClockMs: number = Date.now(),
): number {
  return Math.round(clientWallClockMs + estimatedServerOffsetMs);
}

export function getEstimatedServerOffsetMs(): number {
  return estimatedServerOffsetMs;
}

export function recordServerClockSample(options: {
  clientRequestStartMs: number;
  clientResponseEndMs: number;
  serverTimestamp: number;
}): {
  serverOffsetMs: number;
  roundTripMs: number;
  sampleOffsetMs: number;
} | null {
  if (!Number.isFinite(options.serverTimestamp)) {
    return null;
  }

  const requestStartMs = coerceMs(options.clientRequestStartMs);
  const requestEndMs = coerceMs(options.clientResponseEndMs);
  const roundTripMs = Math.max(0, requestEndMs - requestStartMs);
  const midpointClientMs = requestStartMs + roundTripMs / 2;
  const sampleOffsetMs = options.serverTimestamp - midpointClientMs;

  estimatedServerOffsetMs = hasServerOffset
    ? estimatedServerOffsetMs * 0.8 + sampleOffsetMs * 0.2
    : sampleOffsetMs;
  hasServerOffset = true;

  return {
    serverOffsetMs: estimatedServerOffsetMs,
    roundTripMs,
    sampleOffsetMs,
  };
}

export function measureServerLatencyMs(
  clientTimestamp: number,
  serverTimestamp: number,
): number | undefined {
  if (!Number.isFinite(clientTimestamp) || !Number.isFinite(serverTimestamp)) {
    return undefined;
  }
  return serverTimestamp - clientTimestamp;
}
