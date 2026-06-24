import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";

export const DEFAULT_UNAUTHENTICATED_CONNECTION_LIMIT_PER_IP = 10;
export const DEFAULT_UNAUTHENTICATED_CONNECTION_TIMEOUT_MS = 30_000;

export class UnauthenticatedConnectionLimiter {
  private readonly countsByIp = new Map<string, number>();
  private readonly socketsByWs = new WeakMap<
    WebSocket,
    { ip: string; timeout: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly limitPerIp: number,
    private readonly timeoutMs: number,
  ) {}

  canAccept(ip: string): boolean {
    return (
      this.limitPerIp <= 0 || (this.countsByIp.get(ip) ?? 0) < this.limitPerIp
    );
  }

  track(ws: WebSocket, ip: string): void {
    if (this.limitPerIp <= 0) return;

    this.countsByIp.set(ip, (this.countsByIp.get(ip) ?? 0) + 1);
    const timeout = setTimeout(() => {
      try {
        ws.close(1008, "Unauthenticated connection timed out");
      } catch {
        // Socket is already closed or closing.
      }
    }, this.timeoutMs);
    this.socketsByWs.set(ws, { ip, timeout });
  }

  release(ws: WebSocket): void {
    const tracked = this.socketsByWs.get(ws);
    if (!tracked) return;

    clearTimeout(tracked.timeout);
    this.socketsByWs.delete(ws);

    const nextCount = (this.countsByIp.get(tracked.ip) ?? 1) - 1;
    if (nextCount > 0) {
      this.countsByIp.set(tracked.ip, nextCount);
    } else {
      this.countsByIp.delete(tracked.ip);
    }
  }
}

export function rejectUpgrade(socket: Duplex, status = 429): void {
  socket.write(
    `HTTP/1.1 ${status} Too Many Requests\r\nConnection: close\r\n\r\n`,
  );
  socket.destroy();
}
