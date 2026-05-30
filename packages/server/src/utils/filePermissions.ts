import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { userInfo } from "node:os";
import { promisify } from "node:util";

export const OWNER_READ_WRITE_FILE_MODE = 0o600;

const execFileAsync = promisify(execFile);

const WINDOWS_SHARED_PRINCIPALS_TO_REMOVE = [
  "*S-1-1-0", // Everyone
  "*S-1-5-11", // Authenticated Users
  "*S-1-5-32-545", // Builtin Users
  "*S-1-5-32-546", // Builtin Guests
];

/**
 * Build an `icacls` command that removes inherited shared access and grants
 * only the server user full control. Exported so non-Windows tests can verify
 * the Windows ACL shape without shelling out to platform-specific tooling.
 */
export function buildOwnerOnlyIcaclsArgs(
  filePath: string,
  username = userInfo().username,
): string[] {
  return [
    filePath,
    "/inheritance:r",
    "/grant:r",
    `${username}:F`,
    "/remove:g",
    ...WINDOWS_SHARED_PRINCIPALS_TO_REMOVE,
  ];
}

/**
 * Enforce owner read/write file permissions for local secret files.
 */
export async function enforceOwnerReadWriteFilePermissions(
  filePath: string,
  logPrefix: string,
): Promise<void> {
  if (process.platform === "win32") {
    await enforceWindowsOwnerOnlyFilePermissions(filePath, logPrefix);
    return;
  }

  try {
    await fs.chmod(filePath, OWNER_READ_WRITE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    console.warn(
      `${logPrefix} Failed to enforce 0600 permissions on ${filePath}:`,
      error,
    );
  }
}

async function enforceWindowsOwnerOnlyFilePermissions(
  filePath: string,
  logPrefix: string,
): Promise<void> {
  try {
    await fs.access(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  try {
    await execFileAsync("icacls", buildOwnerOnlyIcaclsArgs(filePath), {
      windowsHide: true,
    });
  } catch (error) {
    console.warn(
      `${logPrefix} Failed to enforce owner-only ACL on ${filePath}:`,
      error,
    );
  }
}
