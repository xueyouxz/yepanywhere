# 022 - API response compression

Status: Implemented (gzip/deflate, `/api/*`)

Progress:

- [x] 2026-06-27: Mounted `hono/compress` on `/api/*` in
  `packages/server/src/app.ts`, registered first so it wraps the whole API
  response. Added end-to-end tests in
  `packages/server/test/api/sessions.test.ts` (encodes when the client accepts
  it + round-trips; leaves the body alone when `Accept-Encoding` is absent).

## Problem

A user running the server directly behind a Cloudflare tunnel reported that
large sessions (multi-MB Codex transcripts, >6MB) were slow to load. Nothing in
the direct HTTP path compressed responses — gzip existed only in the relay layer
(`encryptToBinaryEnvelopeWithCompression`, `crypto/nacl-wrapper.ts`), which the
direct/tunnel/LAN path never touches.

## Why a proxy in front doesn't fix it

The full session loads over a buffered HTTP GET
(`GET /api/projects/:projectId/sessions/:sessionId` → `c.json(...)`,
`routes/sessions.ts`), not over the WebSocket — so HTTP-level compression is the
right tool, and browsers send `Accept-Encoding` and decompress transparently
(no client change).

The wrong assumption was that Cloudflare/nginx would handle gzip for us.
Cloudflare's edge compression only covers the **edge → browser** hop. It does
nothing for **origin → edge**: `cloudflared` ships the origin response raw, so
the full payload crosses the dev machine's (often residential, slow-uplink)
first mile uncompressed. That first hop is the bottleneck the user saw.
Tailscale/LAN clients have no compressing proxy at all. Compressing at the
application is what closes both gaps.

Measured gzip ratios on real on-disk sessions: ~2x for image/base64-heavy
transcripts (base64 is near-incompressible), ~4–6x for text/code-dominated
ones. Brotli would add ~10–20% but needs a custom middleware (Hono's compress is
gzip/deflate only); deferred as not worth the complexity for v1.

## Decision

`app.use("/api/*", compress())` — one line, gzip/deflate, default 1KB threshold.

- Covers every JSON API endpoint, not just session detail.
- Verified to work with the pinned `@hono/node-server` and on the Node-20 CI
  floor. The only modern API it relies on is `CompressionStream`, a Node global
  since v18.
- Safe across the routes under `/api/*`: it bails on WebSocket upgrades
  (`RESPONSE_ALREADY_SENT` has no compressible content-type / null body), SSE
  (`text/event-stream` is excluded from the compressible set), already-encoded
  responses, and sub-threshold bodies. Internal `app.fetch()` calls (public
  shares) send no `Accept-Encoding`, so they're never encoded — no
  double-encode risk on `response.json()`.

## Not done / follow-ups

- Brotli (better ratio) — would need a small custom middleware using
  `zlib.createBrotliCompress`. Deferred.
- Production static assets (`frontend/static.ts`) are still served uncompressed
  via raw `fs.readFile`. Lower priority: they're cacheable and CF edge-caches
  them after the first fetch, unlike the dynamic, uncacheable session JSON.
