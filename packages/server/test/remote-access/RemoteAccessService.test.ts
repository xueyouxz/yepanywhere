import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RemoteAccessService } from "../../src/remote-access/RemoteAccessService.js";

describe("RemoteAccessService file permissions", () => {
  let service: RemoteAccessService;
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-access-test-"));
    service = new RemoteAccessService({ dataDir: testDir });
    await service.initialize();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("writes remote-access.json with 0600 permissions", async () => {
    if (process.platform === "win32") {
      return;
    }

    await service.setRelayConfig({
      url: "wss://relay.example.com/ws",
      username: "test-user",
    });

    const filePath = path.join(testDir, "remote-access.json");
    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("normalizes bare relay hosts to the websocket endpoint", async () => {
    await service.setRelayConfig({
      url: "relay.graehl.org",
      username: "test-user",
    });

    expect(service.getRelayConfig()).toEqual({
      url: "wss://relay.graehl.org/ws",
      username: "test-user",
    });
  });

  it("tightens permissions on existing remote-access.json files at startup", async () => {
    if (process.platform === "win32") {
      return;
    }

    const filePath = path.join(testDir, "remote-access.json");
    await fs.writeFile(
      filePath,
      JSON.stringify({ version: 1, enabled: false }, null, 2),
      "utf-8",
    );
    await fs.chmod(filePath, 0o644);

    const newService = new RemoteAccessService({ dataDir: testDir });
    await newService.initialize();

    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
