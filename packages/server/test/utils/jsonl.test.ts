import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile as realReadFile, rm, writeFile } from "node:fs/promises";
import * as zlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

const zstdCompressSync = (
  zlib as typeof zlib & {
    zstdCompressSync?: (buffer: Buffer) => Buffer;
  }
).zstdCompressSync;

function zstdCompressed(content: string): Buffer {
  if (!zstdCompressSync) {
    throw new Error("zstd compression is unavailable in this Node.js");
  }
  return zstdCompressSync(Buffer.from(content, "utf-8"));
}

describe("jsonl utilities", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("streams the first line of zstd JSONL without full file reads", async () => {
    const dir = join(tmpdir(), `jsonl-zstd-${randomUUID()}`);
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });

    const firstLine = JSON.stringify({
      type: "session_meta",
      payload: {
        id: "streamed-zstd",
        cwd: "/tmp/project",
        timestamp: "2026-06-25T00:00:00.000Z",
      },
    });
    const filePath = join(dir, "rollout-streamed-zstd.jsonl.zst");
    await writeFile(
      filePath,
      zstdCompressed(`${firstLine}\n${"tail\n".repeat(20_000)}`),
    );

    vi.doMock("node:fs/promises", async () => {
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      return {
        ...actual,
        readFile: vi.fn(
          async (...args: Parameters<typeof realReadFile>) => {
            if (String(args[0]).endsWith(".zst")) {
              throw new Error("zstd first-line read used full-file read");
            }
            return realReadFile(...args);
          },
        ),
      };
    });

    const { readFirstLine } = await import("../../src/utils/jsonl.js");

    await expect(readFirstLine(filePath, 1024 * 1024)).resolves.toBe(
      firstLine,
    );
  });
});
