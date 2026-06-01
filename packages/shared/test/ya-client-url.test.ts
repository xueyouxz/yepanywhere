import { describe, expect, it } from "vitest";
import {
  DEFAULT_YA_CLIENT_BASE_URL,
  buildYaClientPublicShareBaseUrl,
  buildYaClientPublicShareUrl,
  buildYaClientRelayLoginUrl,
  normalizeYaClientBaseUrl,
  normalizeYaClientBaseUrlFromShareViewerUrl,
} from "../src/ya-client-url.js";

describe("normalizeYaClientBaseUrl", () => {
  it("keeps the default hosted client canonical", () => {
    expect(normalizeYaClientBaseUrl(DEFAULT_YA_CLIENT_BASE_URL)).toBe(
      DEFAULT_YA_CLIENT_BASE_URL,
    );
  });

  it("accepts a bare YA host or address", () => {
    expect(normalizeYaClientBaseUrl("ya.graehl.org")).toBe(
      "https://ya.graehl.org",
    );
    expect(normalizeYaClientBaseUrl("192.168.1.25:3400")).toBe(
      "https://192.168.1.25:3400",
    );
  });

  it("preserves explicit HTTP origins and app path prefixes", () => {
    expect(normalizeYaClientBaseUrl("http://localhost:3400")).toBe(
      "http://localhost:3400",
    );
    expect(normalizeYaClientBaseUrl("https://example.com/remote/")).toBe(
      "https://example.com/remote",
    );
  });

  it("rejects non-HTTP URLs and URL extras", () => {
    expect(() => normalizeYaClientBaseUrl("wss://example.com")).toThrow(
      "YA URL must use http:// or https://",
    );
    expect(() => normalizeYaClientBaseUrl("example.com?debug=1")).toThrow(
      "YA URL must not include query or hash",
    );
    expect(() => normalizeYaClientBaseUrl("https://user@example.com")).toThrow(
      "YA URL must not include credentials",
    );
  });
});

describe("YA client route builders", () => {
  it("builds login and share routes under the default /remote prefix", () => {
    expect(buildYaClientRelayLoginUrl(DEFAULT_YA_CLIENT_BASE_URL)).toBe(
      "https://yepanywhere.com/remote/login/relay",
    );
    expect(buildYaClientPublicShareUrl("abc/def", DEFAULT_YA_CLIENT_BASE_URL))
      .toBe("https://yepanywhere.com/remote/share/abc%2Fdef");
  });

  it("builds login and share routes at a custom root host", () => {
    expect(buildYaClientRelayLoginUrl("ya.graehl.org")).toBe(
      "https://ya.graehl.org/login/relay",
    );
    expect(buildYaClientPublicShareBaseUrl("ya.graehl.org")).toBe(
      "https://ya.graehl.org/share",
    );
  });

  it("converts legacy share-viewer URLs to YA client bases", () => {
    expect(
      normalizeYaClientBaseUrlFromShareViewerUrl(
        "https://ya.graehl.org/share",
      ),
    ).toBe("https://ya.graehl.org");
    expect(
      normalizeYaClientBaseUrlFromShareViewerUrl(
        "https://example.com/remote/share",
      ),
    ).toBe("https://example.com/remote");
  });
});
