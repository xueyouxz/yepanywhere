import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SpeechAudioRetentionSettings } from "../ServerSettingsService.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SpeechTranscriptionContext {
  projectId?: string;
  sessionId?: string;
  clientTurnId?: string;
  draftKey?: string;
}

export type SpeechAudioRequestSource = "http" | "ws";

export interface SpeechAudioRetentionInput {
  dataDir?: string;
  settings: SpeechAudioRetentionSettings;
  requestId: string;
  source: SpeechAudioRequestSource;
  backendId: string;
  mimeType: string;
  audio: Buffer;
  transcript: string;
  streamingTranscriptTrace?: string[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
  context?: SpeechTranscriptionContext;
}

export interface SpeechAudioRetentionResult {
  transcriptionId: string;
  stored: boolean;
  reason?: string;
  audioPath?: string;
  metadataPath?: string;
  prunedFiles: number;
  prunedBytes: number;
  pruneError?: string;
}

interface SpeechFile {
  filePath: string;
  bytes: number;
  mtimeMs: number;
}

interface SpeechFileGroup {
  key: string;
  files: SpeechFile[];
  bytes: number;
  mtimeMs: number;
}

export async function persistSpeechAudio(
  input: SpeechAudioRetentionInput,
): Promise<SpeechAudioRetentionResult> {
  const transcriptionId = randomUUID();
  const baseResult = {
    transcriptionId,
    prunedFiles: 0,
    prunedBytes: 0,
  };

  if (!input.settings.enabled) {
    return { ...baseResult, stored: false, reason: "disabled" };
  }
  if (!input.dataDir) {
    return { ...baseResult, stored: false, reason: "no-data-dir" };
  }
  if (input.audio.length === 0) {
    return { ...baseResult, stored: false, reason: "empty-audio" };
  }

  const rootDir = path.join(input.dataDir, "speech-audio");
  const day = input.startedAt.slice(0, 10);
  const dayDir = path.join(rootDir, day);
  const audioExt = extensionForMimeType(input.mimeType);
  const audioPath = path.join(dayDir, `${transcriptionId}${audioExt}`);
  const metadataPath = path.join(dayDir, `${transcriptionId}.json`);
  const audioRelativePath = normalizeRelativePath(
    path.relative(rootDir, audioPath),
  );

  try {
    await fs.mkdir(dayDir, { recursive: true });
    await fs.writeFile(audioPath, input.audio);
    await fs.writeFile(
      metadataPath,
      JSON.stringify(
        {
          version: 1,
          transcriptionId,
          requestId: input.requestId,
          source: input.source,
          backendId: input.backendId,
          mimeType: input.mimeType,
          audioBytes: input.audio.length,
          transcript: input.transcript,
          transcriptChars: input.transcript.length,
          streamingTranscriptTrace: input.streamingTranscriptTrace,
          streamingTranscriptTraceText: input.streamingTranscriptTrace?.join(
            "\n",
          ),
          startedAt: input.startedAt,
          completedAt: input.completedAt,
          durationMs: input.durationMs,
          context: input.context,
          audio: {
            path: audioRelativePath,
            bytes: input.audio.length,
            mimeType: input.mimeType,
          },
          retention: {
            maxAgeDays: input.settings.maxAgeDays,
            maxBytes: input.settings.maxBytes,
          },
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ...baseResult, stored: false, reason: `write-failed: ${reason}` };
  }

  const result: SpeechAudioRetentionResult = {
    ...baseResult,
    stored: true,
    audioPath,
    metadataPath,
  };

  try {
    const pruned = await pruneSpeechAudioStore(rootDir, input.settings);
    result.prunedFiles = pruned.files;
    result.prunedBytes = pruned.bytes;
  } catch (err: unknown) {
    result.pruneError = err instanceof Error ? err.message : String(err);
  }

  return result;
}

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("webm")) return ".webm";
  if (normalized.includes("ogg")) return ".ogg";
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return ".mp3";
  if (normalized.includes("wav")) return ".wav";
  if (normalized.includes("mp4") || normalized.includes("m4a")) return ".m4a";
  return ".bin";
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

async function pruneSpeechAudioStore(
  rootDir: string,
  settings: SpeechAudioRetentionSettings,
): Promise<{ files: number; bytes: number }> {
  const files = await listFiles(rootDir);
  const groups = groupFiles(files);
  let totalBytes = groups.reduce((sum, group) => sum + group.bytes, 0);
  let prunedFiles = 0;
  let prunedBytes = 0;

  const cutoffMs = Date.now() - settings.maxAgeDays * DAY_MS;
  const expired = groups.filter((group) => group.mtimeMs < cutoffMs);
  for (const group of expired) {
    const pruned = await deleteGroup(group);
    prunedFiles += pruned.files;
    prunedBytes += pruned.bytes;
    totalBytes -= group.bytes;
  }

  const expiredKeys = new Set(expired.map((group) => group.key));
  const remaining = groups
    .filter((group) => !expiredKeys.has(group.key))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const group of remaining) {
    if (totalBytes <= settings.maxBytes) break;
    const pruned = await deleteGroup(group);
    prunedFiles += pruned.files;
    prunedBytes += pruned.bytes;
    totalBytes -= group.bytes;
  }

  return { files: prunedFiles, bytes: prunedBytes };
}

async function listFiles(rootDir: string): Promise<SpeechFile[]> {
  const files: SpeechFile[] = [];

  async function visit(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(entryPath);
      files.push({
        filePath: entryPath,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  await visit(rootDir);
  return files;
}

function groupFiles(files: SpeechFile[]): SpeechFileGroup[] {
  const groups = new Map<string, SpeechFileGroup>();

  for (const file of files) {
    const parsed = path.parse(file.filePath);
    const key = path.join(parsed.dir, parsed.name);
    const current = groups.get(key);
    if (current) {
      current.files.push(file);
      current.bytes += file.bytes;
      current.mtimeMs = Math.max(current.mtimeMs, file.mtimeMs);
      continue;
    }
    groups.set(key, {
      key,
      files: [file],
      bytes: file.bytes,
      mtimeMs: file.mtimeMs,
    });
  }

  return [...groups.values()];
}

async function deleteGroup(
  group: SpeechFileGroup,
): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;

  for (const file of group.files) {
    try {
      await fs.rm(file.filePath);
      files += 1;
      bytes += file.bytes;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  return { files, bytes };
}
