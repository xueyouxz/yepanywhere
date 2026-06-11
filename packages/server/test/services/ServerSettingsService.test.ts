import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServerSettingsService } from "../../src/services/ServerSettingsService.js";

describe("ServerSettingsService", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "server-settings-test-"));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("uses continue as the default heartbeat turn text", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("heartbeatTurnText")).toBe("continue");
  });

  it("hides patient queue controls by default", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(
      service.getSetting("clientDefaults")?.sessionToolbarVisibility
        ?.queueControls,
    ).toBe(false);
  });

  it("preserves explicit patient queue visibility defaults", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: {
          clientDefaults: {
            sessionToolbarVisibility: {
              queueControls: true,
            },
          },
        },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(
      service.getSetting("clientDefaults")?.sessionToolbarVisibility
        ?.queueControls,
    ).toBe(true);
  });

  it.each([
    "heartbeat",
    "yepanywhere heartbeat",
  ])("migrates legacy built-in heartbeat turn text default %j", async (heartbeatTurnText) => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 1,
        settings: {
          heartbeatTurnText,
        },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("heartbeatTurnText")).toBe("continue");
    const persisted = JSON.parse(
      await fs.readFile(path.join(testDir, "server-settings.json"), "utf-8"),
    ) as { settings: { heartbeatTurnText?: string }; version: number };
    expect(persisted.version).toBe(2);
    expect(persisted.settings.heartbeatTurnText).toBe("continue");
  });

  it("preserves custom heartbeat turn text", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 1,
        settings: {
          heartbeatTurnText: "checking in",
        },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("heartbeatTurnText")).toBe("checking in");
  });
});
