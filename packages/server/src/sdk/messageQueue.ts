import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { UploadedFile } from "@yep-anywhere/shared";
import type { UserMessage } from "./types.js";

export const CONCAT_SEPARATOR = "--------";
export const INTERRUPT_PREAMBLE = "interrupt resumable after:";

/**
 * Concatenate multiple UserMessages into one, joined by separator lines.
 * Shared by MessageQueue and Process to avoid duplicating the merge logic.
 */
export function concatUserMessages(
  messages: UserMessage[],
  preamble?: string,
): UserMessage {
  const first = messages[0]!;
  const parts: string[] = [];
  const allImages: string[] = [];
  const allDocs: string[] = [];
  const allAttachments: UploadedFile[] = [];

  if (preamble) {
    parts.push(preamble);
    parts.push(CONCAT_SEPARATOR);
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (i > 0) parts.push(CONCAT_SEPARATOR);
    parts.push(msg.text);
    if (msg.images?.length) allImages.push(...msg.images);
    if (msg.documents?.length) allDocs.push(...msg.documents);
    if (msg.attachments?.length) allAttachments.push(...msg.attachments);
  }

  const combined: UserMessage = {
    text: parts.join("\n\n"),
    uuid: first.uuid,
    tempId: first.tempId,
  };
  if (allImages.length) combined.images = allImages;
  if (allDocs.length) combined.documents = allDocs;
  if (allAttachments.length) combined.attachments = allAttachments;
  return combined;
}

function escapeMarkdownLinkText(text: string): string {
  return text.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function formatUploadedFileReference(
  file: {
    originalName: string;
    size: number;
    mimeType: string;
    path: string;
    width?: number;
    height?: number;
  },
  formatSize: (bytes: number) => string,
): string {
  const dimensions =
    file.width && file.height ? `, ${file.width}x${file.height}` : "";
  return `- [${escapeMarkdownLinkText(file.originalName)}](<${file.path}>) (${formatSize(file.size)}, ${file.mimeType}${dimensions})`;
}

/**
 * Detect the media type from base64 image data.
 * Supports data URLs (data:image/png;base64,...) and raw base64 with magic byte detection.
 */
function detectImageMediaType(base64Data: string): string {
  const dataUrlMatch = base64Data.match(/^data:([^;]+);base64,/);
  if (dataUrlMatch?.[1]) {
    return dataUrlMatch[1];
  }

  try {
    const rawBase64 = base64Data.replace(/^data:[^;]+;base64,/, "");
    const bytes = Buffer.from(rawBase64.slice(0, 24), "base64");

    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    ) {
      return "image/png";
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return "image/jpeg";
    }
    if (
      bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x38
    ) {
      return "image/gif";
    }
    if (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return "image/webp";
    }
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
      return "image/bmp";
    }
  } catch {
    // Fall back to PNG
  }

  return "image/png";
}

/**
 * MessageQueue holds user messages and exposes two interfaces:
 *
 * 1. AsyncIterable — consumed by the SDK's `query()` loop. Each `.next()`
 *    drains all accumulated messages, concatenates them, and yields one
 *    combined SDKUserMessage. This ensures the provider never receives
 *    queued messages serially.
 *
 * 2. concatDrain() — synchronous drain for stop/interrupt paths. Consumed
 *    by Process to deliver queued messages with an interruption preamble.
 */
export class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private queue: UserMessage[] = [];
  private waiting: (() => void) | null = null;
  /** Set when concatDrain() is called to prevent generator from yielding stale data */
  private drainedByExternal = false;

  /**
   * Push a message onto the queue.
   * If the consumer is waiting, resolves immediately.
   * Otherwise, adds to the buffer.
   *
   * @returns The new queue depth (0 if resolved immediately)
   */
  push(message: UserMessage): number {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      this.queue.push(message);
      resolve();
      return 0;
    }
    this.queue.push(message);
    return this.queue.length;
  }

  /**
   * Synchronously drain and concatenate all queued messages into a single
   * UserMessage. Used by Process for stop/interrupt delivery.
   *
   * @param options.interrupted - if true, prepend interrupt preamble
   */
   concatDrain(options?: { interrupted?: boolean }): UserMessage | null {
    this.drainedByExternal = true;
    const drained = this.queue.splice(0);
    if (drained.length === 0) return null;

    return concatUserMessages(
      drained,
      options?.interrupted ? INTERRUPT_PREAMBLE : undefined,
    );
  }

  /**
   * Remove and return messages that have been queued but not yet yielded.
   */
  drain(): UserMessage[] {
    return this.queue.splice(0);
  }

  /* ------------------------------------------------------------------ */
  /* AsyncIterable interface (consumed by SDK query loop)               */
  /* ------------------------------------------------------------------ */

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return this.createIterator();
  }

  private createIterator(): AsyncIterator<SDKUserMessage> {
    let closed = false;

    const self = this;
    return {
      async next(): Promise<IteratorResult<SDKUserMessage>> {
        if (closed) return { done: true, value: undefined };

        // Wait until at least one message is available
        await self.waitForMessage();

        // Check if external drain stole our messages
        if (self.drainedByExternal) {
          self.drainedByExternal = false;
          // Retry — wait for new messages
          return this.next();
        }

        // Drain all accumulated and concatenate
        const combined = self.concatDrainInternal();
        if (!combined) {
          // Empty drain — retry
          return this.next();
        }

        return { done: false, value: self.toSDKMessage(combined) };
      },

      return(): Promise<IteratorResult<SDKUserMessage>> {
        closed = true;
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }

  /** Wait until at least one message is available */
  private waitForMessage(): Promise<void> {
    if (this.queue.length > 0) return Promise.resolve();

    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  /** Internal drain without the drainedByExternal flag (used by iterator) */
  private concatDrainInternal(): UserMessage | null {
    const drained = this.queue.splice(0);
    if (drained.length === 0) return null;

    return concatUserMessages(drained);
  }

  /* ------------------------------------------------------------------ */
  /* Formatting                                                         */
  /* ------------------------------------------------------------------ */

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}\u202fb`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}\u202fkb`;
    if (bytes < 1024 * 1024 * 1024)
      return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}\u202fmb`;
    return `${Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10}\u202fgb`;
  }

  private toSDKMessage(msg: UserMessage): SDKUserMessage {
    let text = msg.text;

    if (msg.attachments?.length) {
      const lines = msg.attachments.map((f) =>
        formatUploadedFileReference(f, this.formatSize.bind(this)),
      );
      text += `\n\nUser uploaded files in .attachments:\n${lines.join("\n")}`;
    }

    if (msg.images?.length || msg.documents?.length) {
      const content: Array<
        | { type: "text"; text: string }
        | {
            type: "image";
            source: { type: "base64"; media_type: string; data: string };
          }
      > = [{ type: "text", text }];

      for (const image of msg.images ?? []) {
        const mediaType = detectImageMediaType(image);
        const rawBase64 = image.replace(/^data:[^;]+;base64,/, "");
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: rawBase64,
          },
        });
      }

      if (msg.documents?.length) {
        content[0] = {
          type: "text",
          text: `${text}\n\nAttached documents: ${msg.documents.join(", ")}`,
        };
      }

      return {
        type: "user",
        uuid: msg.uuid,
        message: {
          role: "user",
          content,
        },
      } as SDKUserMessage;
    }

    return {
      type: "user",
      uuid: msg.uuid,
      message: {
        role: "user",
        content: text,
      },
    } as SDKUserMessage;
  }

  /** Current number of messages waiting in the queue. */
  get depth(): number {
    return this.queue.length;
  }

  /** Whether the iterator is currently waiting for a message. */
  get isWaiting(): boolean {
    return this.waiting !== null;
  }

  /** Backward-compatible alias for the async iterator (used by existing callers). */
  generator(): AsyncGenerator<SDKUserMessage> {
    return this[Symbol.asyncIterator]() as any as AsyncGenerator<SDKUserMessage>;
  }
}
