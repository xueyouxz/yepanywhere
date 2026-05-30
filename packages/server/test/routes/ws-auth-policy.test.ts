import { describe, expect, it } from "vitest";
import {
  type WsConnectionPolicy,
  deriveWsConnectionPolicy,
  isPolicySrpRequired,
  isPolicyTrustedWithoutSrp,
} from "../../src/routes/ws-auth-policy.js";
import { isLoopbackWsRequest } from "../../src/routes/ws-relay.js";

describe("WebSocket Auth Policy", () => {
  it("returns srp_required for relay connections", () => {
    const policy = deriveWsConnectionPolicy({
      remoteAccessEnabled: false,
      hasSessionCookieAuth: true,
      isRelayConnection: true,
      isLoopbackConnection: true,
    });

    expect(policy).toBe("srp_required");
  });

  it("returns local_unrestricted when remote access is disabled", () => {
    const policy = deriveWsConnectionPolicy({
      remoteAccessEnabled: false,
      hasSessionCookieAuth: false,
      isRelayConnection: false,
      isLoopbackConnection: false,
    });

    expect(policy).toBe("local_unrestricted");
  });

  it("returns local_cookie_trusted when remote access is enabled and cookie auth exists", () => {
    const policy = deriveWsConnectionPolicy({
      remoteAccessEnabled: true,
      hasSessionCookieAuth: true,
      isRelayConnection: false,
      isLoopbackConnection: false,
    });

    expect(policy).toBe("local_cookie_trusted");
  });

  it("returns srp_required when remote access is enabled without cookie auth", () => {
    const policy = deriveWsConnectionPolicy({
      remoteAccessEnabled: true,
      hasSessionCookieAuth: false,
      isRelayConnection: false,
      isLoopbackConnection: false,
    });

    expect(policy).toBe("srp_required");
  });

  it("returns local_unrestricted for loopback connections without cookie auth", () => {
    const policy = deriveWsConnectionPolicy({
      remoteAccessEnabled: true,
      hasSessionCookieAuth: false,
      isRelayConnection: false,
      isLoopbackConnection: true,
    });

    expect(policy).toBe("local_unrestricted");
  });

  it("marks only local policies as trusted without SRP", () => {
    const trustedPolicies: WsConnectionPolicy[] = [
      "local_unrestricted",
      "local_cookie_trusted",
    ];
    const untrustedPolicies: WsConnectionPolicy[] = ["srp_required"];

    for (const policy of trustedPolicies) {
      expect(isPolicyTrustedWithoutSrp(policy)).toBe(true);
    }

    for (const policy of untrustedPolicies) {
      expect(isPolicyTrustedWithoutSrp(policy)).toBe(false);
    }
  });

  it("marks only srp_required as SRP-required policy", () => {
    const srpRequiredPolicies: WsConnectionPolicy[] = ["srp_required"];
    const notSrpRequiredPolicies: WsConnectionPolicy[] = [
      "local_unrestricted",
      "local_cookie_trusted",
    ];

    for (const policy of srpRequiredPolicies) {
      expect(isPolicySrpRequired(policy)).toBe(true);
    }

    for (const policy of notSrpRequiredPolicies) {
      expect(isPolicySrpRequired(policy)).toBe(false);
    }
  });

  it("requires both loopback TCP peer and loopback authority for loopback WS trust", () => {
    expect(isLoopbackWsRequest("127.0.0.1", "localhost")).toBe(true);
    expect(isLoopbackWsRequest("::ffff:127.0.0.1", "127.0.0.1")).toBe(true);

    expect(isLoopbackWsRequest("203.0.113.10", "localhost")).toBe(false);
    expect(isLoopbackWsRequest("127.0.0.1", "example.com")).toBe(false);
    expect(isLoopbackWsRequest(null, "localhost")).toBe(false);
  });
});
