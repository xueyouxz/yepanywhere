/**
 * CLI setup commands for headless authentication configuration.
 *
 * These commands allow setting up auth without the web interface,
 * useful for headless/automated deployments.
 */

import {
  DEFAULT_RELAY_URL,
  type RelayServerRejected,
  isRelayServerRegistered,
  isRelayServerRejected,
} from "@yep-anywhere/shared";
import { WebSocket } from "ws";
import { AuthService } from "./auth/AuthService.js";
import { getDataDir } from "./config.js";
import { RemoteAccessService } from "./remote-access/RemoteAccessService.js";
import { InstallService } from "./services/InstallService.js";

/** Timeout for relay registration check (ms) */
const RELAY_TIMEOUT_MS = 10_000;

export interface SetupAuthOptions {
  password: string;
}

export interface SetupRemoteAccessOptions {
  username: string;
  password: string;
  relayUrl?: string;
}

/**
 * Set up local cookie-based authentication.
 * Creates or updates the password in auth.json.
 */
export async function setupAuth(options: SetupAuthOptions): Promise<void> {
  const { password } = options;

  if (!password || password.length < 6) {
    throw new Error("Password must be at least 6 characters");
  }

  const dataDir = getDataDir();
  const authService = new AuthService({ dataDir });
  await authService.initialize();

  await authService.enableAuth(password);
  console.log("Local authentication configured successfully.");
  console.log(`Auth file: ${authService.getFilePath()}`);
}

/**
 * Set up remote access with SRP authentication.
 * Registers with the relay to verify username availability.
 */
export async function setupRemoteAccess(
  options: SetupRemoteAccessOptions,
): Promise<void> {
  const { username, password, relayUrl = DEFAULT_RELAY_URL } = options;

  // Validate inputs
  if (!username || username.length < 3) {
    throw new Error("Username must be at least 3 characters");
  }
  if (username.length > 32) {
    throw new Error("Username must be at most 32 characters");
  }
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]{1,2}$/.test(username)) {
    throw new Error(
      "Username can only contain lowercase letters, numbers, and hyphens (no leading/trailing hyphen)",
    );
  }
  if (!password || password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }

  const dataDir = getDataDir();

  // Initialize services
  const installService = new InstallService({ dataDir });
  await installService.initialize();
  const installId = installService.getInstallId();

  const remoteAccessService = new RemoteAccessService({ dataDir });
  await remoteAccessService.initialize();

  // Set relay config first (required before configure)
  await remoteAccessService.setRelayConfig({ url: relayUrl, username });

  // Configure SRP credentials
  await remoteAccessService.configure(password);

  console.log(`Relay configured: ${relayUrl}`);
  console.log(`Username: ${username}`);

  // Try to register with the relay to verify username availability
  console.log("Verifying username availability with relay...");

  const result = await verifyRelayRegistration({
    relayUrl,
    username,
    installId,
  });

  if (result.success) {
    console.log("Remote access configured successfully.");
    console.log(
      `You can now connect via: ${relayUrl.replace("/ws", "")}/${username}`,
    );
  } else {
    // Registration failed - clean up the configuration
    await remoteAccessService.clearCredentials();
    await remoteAccessService.clearRelayConfig();
    throw new Error(`Relay registration failed: ${result.error}`);
  }
}

interface VerifyResult {
  success: boolean;
  error?: string;
}

/**
 * Verify that a username can be registered with the relay.
 * Connects to the relay, sends registration, and waits for response.
 */
async function verifyRelayRegistration(options: {
  relayUrl: string;
  username: string;
  installId: string;
}): Promise<VerifyResult> {
  const { relayUrl, username, installId } = options;

  return new Promise((resolve) => {
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.close();
        resolve({ success: false, error: "Relay connection timeout" });
      }
    }, RELAY_TIMEOUT_MS);

    const ws = new WebSocket(relayUrl);

    ws.on("open", () => {
      // Send registration message
      const register = {
        type: "server_register",
        username,
        installId,
      };
      ws.send(JSON.stringify(register));
    });

    ws.on("message", (data: Buffer) => {
      if (resolved) return;

      try {
        const msg = JSON.parse(data.toString("utf-8"));

        if (isRelayServerRegistered(msg)) {
          resolved = true;
          clearTimeout(timeout);
          ws.close();
          resolve({ success: true });
        } else if (isRelayServerRejected(msg)) {
          resolved = true;
          clearTimeout(timeout);
          ws.close();

          const rejected = msg as RelayServerRejected;
          if (rejected.reason === "username_taken") {
            resolve({
              success: false,
              error: `Username "${username}" is already registered by another server`,
            });
          } else if (rejected.reason === "invalid_username") {
            resolve({
              success: false,
              error: `Invalid username format: "${username}"`,
            });
          } else {
            resolve({
              success: false,
              error: `Registration rejected: ${rejected.reason}`,
            });
          }
        }
      } catch {
        // Ignore parse errors
      }
    });

    ws.on("error", (error: Error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({
          success: false,
          error: `Connection error: ${error.message}`,
        });
      }
    });

    ws.on("close", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ success: false, error: "Connection closed unexpectedly" });
      }
    });
  });
}
