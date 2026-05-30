import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { InputRequest } from "@yep-anywhere/shared";
import { enforceOwnerReadWriteFilePermissions } from "../utils/filePermissions.js";

export interface ApprovalAuditEntry {
  timestamp: string;
  sessionId: string;
  processId: string;
  provider?: string;
  requestId: string;
  request: InputRequest | null;
  response: string;
  normalizedResponse: "approve" | "deny";
  answers?: Record<string, string>;
  feedback?: string;
  accepted: boolean;
  failure?: string;
  permissionModeBefore: string;
  permissionModeAfter: string;
}

export async function appendApprovalAuditLog(
  dataDir: string | undefined,
  entry: ApprovalAuditEntry,
): Promise<void> {
  if (!dataDir) return;

  const dir = path.join(dataDir, "logs");
  const filePath = path.join(dir, "approval-decisions.jsonl");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await fs.chmod(dir, 0o700);
  }
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  await enforceOwnerReadWriteFilePermissions(filePath, "[approval-audit]");
}
