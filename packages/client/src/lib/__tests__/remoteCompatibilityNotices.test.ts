import { describe, expect, it } from "vitest";
import {
  compareSemver,
  getEffectiveInstallSource,
  getRemoteCompatibilityNotices,
  isStableReleaseVersion,
  isVersionLessThan,
  parseSemver,
} from "../remoteCompatibilityNotices";

describe("remoteCompatibilityNotices", () => {
  it("does not emit notices outside relay-hosted connections", () => {
    expect(
      getRemoteCompatibilityNotices({
        currentVersion: "0.4.28",
        latestVersion: "0.4.29",
        updateAvailable: true,
        resumeProtocolVersion: 3,
      }),
    ).toEqual([]);
  });

  it("emits a warning notice for protocol 2 relay resume metadata", () => {
    const notices = getRemoteCompatibilityNotices({
      currentVersion: "0.5.0",
      latestVersion: "0.5.1",
      updateAvailable: false,
      resumeProtocolVersion: 2,
      relayUsername: "dev-box",
    });

    expect(notices.map((notice) => notice.id)).toEqual([
      "relay-resume-v3-grace",
    ]);
    expect(notices[0]?.severity).toBe("security");
    expect(notices[0]?.title).toBe("Server update required soon");
    expect(notices[0]?.versionSummary).toBe(
      "Server v0.5.0; recommended v0.5.1",
    );
  });

  it("does not display unrelated site tags as server versions", () => {
    const notices = getRemoteCompatibilityNotices({
      currentVersion: "site-v1.6.1",
      latestVersion: null,
      updateAvailable: false,
      installSource: "source",
      resumeProtocolVersion: 2,
      relayUsername: "dev-box",
    });

    expect(notices.map((notice) => notice.id)).toEqual([
      "relay-resume-v3-grace",
    ]);
    expect(notices[0]?.versionSummary).toBe(
      "Server version unknown; recommended v0.5.1+",
    );
    expect(notices[0]?.guidance).toContain("Source checkout detected");
  });

  it("emits a blocking notice for pre-v2 relay resume protocol metadata", () => {
    const notices = getRemoteCompatibilityNotices({
      currentVersion: "0.4.29",
      latestVersion: "0.5.1",
      updateAvailable: true,
      resumeProtocolVersion: 1,
      relayUsername: "dev-box",
    });

    expect(notices.map((notice) => notice.id)).toContain(
      "relay-resume-security",
    );
    expect(notices[0]?.severity).toBe("blocking");
  });

  it("falls back to version < 0.4.0 for relay resume security", () => {
    const notices = getRemoteCompatibilityNotices({
      currentVersion: "0.3.9",
      latestVersion: "0.4.29",
      updateAvailable: true,
      relayUsername: "dev-box",
    });

    expect(
      notices.some((notice) => notice.id === "relay-resume-security"),
    ).toBe(true);
  });

  it("does not use the version fallback for 0.4.0+ servers", () => {
    const notices = getRemoteCompatibilityNotices({
      currentVersion: "0.4.0",
      latestVersion: "0.4.29",
      updateAvailable: true,
      relayUsername: "dev-box",
      recommendedBaselineVersion: "0.4.0",
    });

    expect(
      notices.some((notice) => notice.id === "relay-resume-security"),
    ).toBe(false);
  });

  it("treats git-describe builds after 0.4.0 as past the security baseline", () => {
    const notices = getRemoteCompatibilityNotices({
      currentVersion: "0.4.0-3-gabcdef",
      latestVersion: "0.4.29",
      updateAvailable: true,
      relayUsername: "dev-box",
      recommendedBaselineVersion: "0.4.0",
    });

    expect(
      notices.some((notice) => notice.id === "relay-resume-security"),
    ).toBe(false);
  });

  it("avoids unsafe old-version claims for unknown versions", () => {
    const notices = getRemoteCompatibilityNotices({
      currentVersion: "dev",
      latestVersion: null,
      updateAvailable: false,
      relayUsername: "dev-box",
    });

    expect(notices).toEqual([]);
  });

  it("emits the release-specific recommended update notice", () => {
    const notices = getRemoteCompatibilityNotices({
      currentVersion: "0.4.28",
      latestVersion: "0.4.29",
      updateAvailable: true,
      resumeProtocolVersion: 3,
      relayUsername: "dev-box",
      recommendedBaselineVersion: "0.4.29",
    });

    expect(notices.map((notice) => notice.id)).toEqual([
      "backend-api-compat-0.4.29",
    ]);
    expect(notices[0]?.versionSummary).toBe(
      "Server v0.4.28; recommended v0.4.29",
    );
    expect(notices[0]?.guidance).toContain(
      "If this host was installed with npm",
    );
    expect(notices[0]?.action?.command).toBe("npm update -g yepanywhere");
  });

  it("suggests source update steps for git-describe checkout versions", () => {
    const notices = getRemoteCompatibilityNotices({
      currentVersion: "0.4.28-3-gabcdef",
      latestVersion: "0.4.29",
      updateAvailable: true,
      resumeProtocolVersion: 3,
      relayUsername: "dev-box",
      recommendedBaselineVersion: "0.4.29",
    });

    expect(notices.map((notice) => notice.id)).toEqual([
      "backend-api-compat-0.4.29",
    ]);
    expect(notices[0]?.guidance).toContain("Source checkout detected");
    expect(notices[0]?.action?.label).toBe("Copy source steps");
    expect(notices[0]?.action?.command).toContain("git merge origin/main");
  });

  it("uses explicit source metadata even when the version is exactly tagged", () => {
    const notices = getRemoteCompatibilityNotices({
      currentVersion: "0.4.28",
      latestVersion: "0.4.29",
      updateAvailable: true,
      installSource: "source",
      resumeProtocolVersion: 3,
      relayUsername: "dev-box",
      recommendedBaselineVersion: "0.4.29",
    });

    expect(notices[0]?.guidance).toContain("Source checkout detected");
    expect(notices[0]?.action?.label).toBe("Copy source steps");
  });

  it("uses npm-global metadata for direct npm guidance", () => {
    const notices = getRemoteCompatibilityNotices({
      currentVersion: "0.4.28",
      latestVersion: "0.4.29",
      updateAvailable: true,
      installSource: "npm-global",
      resumeProtocolVersion: 3,
      relayUsername: "dev-box",
      recommendedBaselineVersion: "0.4.29",
    });

    expect(notices[0]?.guidance).toContain(
      "Run npm update -g yepanywhere on the host",
    );
    expect(notices[0]?.action?.label).toBe("Copy npm command");
  });

  it("uses a generic update notice when no specific notice applies", () => {
    const notices = getRemoteCompatibilityNotices({
      currentVersion: "0.4.29",
      latestVersion: "0.4.30",
      updateAvailable: true,
      resumeProtocolVersion: 3,
      relayUsername: "dev-box",
      recommendedBaselineVersion: "0.4.29",
    });

    expect(notices.map((notice) => notice.id)).toEqual([
      "remote-update-available",
    ]);
    expect(notices[0]?.versionSummary).toBe("Server v0.4.29; latest v0.4.30");
  });

  it("shows the bundled baseline when latest is not published yet", () => {
    const notices = getRemoteCompatibilityNotices({
      currentVersion: "0.4.28",
      latestVersion: "0.4.28",
      updateAvailable: false,
      resumeProtocolVersion: 3,
      relayUsername: "dev-box",
      recommendedBaselineVersion: "0.4.29",
    });

    expect(notices[0]?.versionSummary).toBe(
      "Server v0.4.28; recommended v0.4.29+",
    );
  });
});

describe("remote compatibility semver helpers", () => {
  it("compares stable and prerelease versions", () => {
    expect(compareSemver("0.4.28", "0.4.29")).toBeLessThan(0);
    expect(compareSemver("v0.4.29", "0.4.29")).toBe(0);
    expect(compareSemver("0.4.29-rc.1", "0.4.29")).toBeLessThan(0);
    expect(compareSemver("dev", "0.4.29")).toBeNull();
  });

  it("parses git-describe source versions without marking them stable", () => {
    expect(parseSemver("0.4.28-3-gabcdef")).toMatchObject({
      normalized: "0.4.28-3-gabcdef",
      stable: false,
    });
    expect(compareSemver("0.4.28-3-gabcdef", "0.4.28")).toBeGreaterThan(0);
    expect(isVersionLessThan("0.4.28-3-gabcdef", "0.4.29")).toBe(true);
    expect(isVersionLessThan("0.4.0-3-gabcdef", "0.4.0")).toBe(false);
    expect(isStableReleaseVersion("0.4.28-3-gabcdef")).toBe(false);
    expect(isStableReleaseVersion("0.4.28")).toBe(true);
  });

  it("uses installSource first and git-describe versions as a fallback", () => {
    expect(
      getEffectiveInstallSource({
        currentVersion: "0.4.28",
        installSource: "source",
      }),
    ).toBe("source");
    expect(
      getEffectiveInstallSource({
        currentVersion: "0.4.28-6-g1ccc58f4",
      }),
    ).toBe("source");
    expect(getEffectiveInstallSource({ currentVersion: "0.4.28" })).toBe(
      "unknown",
    );
  });
});
