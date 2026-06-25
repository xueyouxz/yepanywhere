import * as path from "node:path";

export type CodexRolloutRepresentation = "plain" | "zstd";

export interface CodexRolloutDiscoveryIdentity {
  key: string;
  shardKey: string;
  relativePath: string;
  canonicalRelativePath: string;
  representation: CodexRolloutRepresentation;
}

export function isCodexRolloutFileName(name: string): boolean {
  return name.endsWith(".jsonl") || name.endsWith(".jsonl.zst");
}

export function isCompressedCodexRolloutPath(filePath: string): boolean {
  return filePath.endsWith(".jsonl.zst");
}

export function plainCodexRolloutPath(filePath: string): string {
  return isCompressedCodexRolloutPath(filePath)
    ? filePath.slice(0, -".zst".length)
    : filePath;
}

export function preferPlainCodexRollouts(filePaths: string[]): string[] {
  const plainPaths = new Set(
    filePaths
      .filter((filePath) => filePath.endsWith(".jsonl"))
      .map((filePath) => filePath),
  );

  return filePaths.filter((filePath) => {
    if (!isCompressedCodexRolloutPath(filePath)) return true;
    return !plainPaths.has(plainCodexRolloutPath(filePath));
  });
}

export function codexRolloutRepresentation(
  filePath: string,
): CodexRolloutRepresentation {
  return isCompressedCodexRolloutPath(filePath) ? "zstd" : "plain";
}

export function getCodexRolloutDiscoveryIdentity(
  sessionsDir: string,
  filePath: string,
): CodexRolloutDiscoveryIdentity {
  const relativePath = path.relative(sessionsDir, filePath).replace(/\\/g, "/");
  const canonicalRelativePath = plainCodexRolloutPath(relativePath);
  const shardDir = path.posix.dirname(canonicalRelativePath);
  return {
    key: path.posix.basename(canonicalRelativePath),
    shardKey: shardDir === "." ? "_root" : shardDir,
    relativePath,
    canonicalRelativePath,
    representation: codexRolloutRepresentation(filePath),
  };
}
