import { describe, expect, it } from "vitest";
import {
  FRONTEND_RELOAD_QUERY_PARAM,
  buildFrontendReloadUrl,
  getFrontendReloadCleanupUrl,
} from "../useReloadNotifications";

describe("useReloadNotifications URL helpers", () => {
  it("adds a cache-busting reload param while preserving query and hash", () => {
    const nextUrl = buildFrontendReloadUrl(
      "https://example.test/projects?foo=bar#session-1",
      "12345",
    );
    const parsed = new URL(nextUrl);

    expect(parsed.searchParams.get("foo")).toBe("bar");
    expect(parsed.searchParams.get(FRONTEND_RELOAD_QUERY_PARAM)).toBe("12345");
    expect(parsed.hash).toBe("#session-1");
  });

  it("removes only the reload param during post-load cleanup", () => {
    const cleanedUrl = getFrontendReloadCleanupUrl(
      "https://example.test/projects?foo=bar&__ya_reload=12345#session-1",
    );

    expect(cleanedUrl).toBe("https://example.test/projects?foo=bar#session-1");
  });

  it("returns null when there is no reload param to clean up", () => {
    expect(
      getFrontendReloadCleanupUrl(
        "https://example.test/projects?foo=bar#session-1",
      ),
    ).toBeNull();
  });
});
