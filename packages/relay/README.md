# Yep Anywhere Relay

A WebSocket pair-matcher that lets a yep-anywhere server behind NAT
accept browser clients without port forwarding, Tailscale, or a VPN.
The relay does **not** see message contents: clients and the
yep-anywhere server complete SRP-6a + NaCl (XSalsa20-Poly1305)
end-to-end, and the relay only forwards opaque frames.

The publicly hosted relay is `wss://relay.yepanywhere.com/ws`. Most
operators do not need to self-host. Reasons to run your own:

- You want a relay you control end to end.
- You want to keep connection metadata (which usernames are online,
  timing, frame sizes) off third-party infrastructure.
- You want the relay to remain available if the public one is
  withdrawn.

## What the process does and does not do

Does:

- Tracks one waiting yep-anywhere server per registered username.
- Pairs an incoming client with the matching waiting server and
  forwards frames between them, preserving binary vs. text framing.
- Persists username ownership (`username` → `installId`) in SQLite
  with first-come-first-served registration and configurable
  inactivity reclamation.
- Exposes `/health`, `/status`, `/stats`, `/online/:username`.

Does not:

- Read, decrypt, or modify message payloads.
- Hold the user's password, SRP verifier, or any per-user secret.
  Those live on the yep-anywhere server, never on the relay.
- Terminate TLS. The process listens plain WS/HTTP. TLS must be
  terminated by a reverse proxy in front of it.

## Running

```bash
pnpm --filter @yep-anywhere/relay build
node packages/relay/dist/index.js
```

Defaults: listens on `:4400`, state in `~/.yep-relay/`.

## TLS is effectively required

Browsers refuse `ws://` from an `https://` page (mixed-content
blocking), so any client coming from the public website or another
HTTPS page must use `wss://`. Even setting that aside, TLS to the
relay matters for two reasons:

1. The `server_register` and `client_connect` envelopes (containing
   the username) are JSON in cleartext on the wire **before** the
   encrypted session is established. TLS hides them from on-path
   observers; without it, anyone in path knows who is connecting.
2. SRP-6a resists offline dictionary attack on the verifier, but
   an active MITM can attempt online password guesses at relay
   speed. TLS to a trusted reverse proxy lets the proxy rate-limit
   guessing; plain `ws://` does not. The SRP password gives full
   remote control of your yep-anywhere server, so the cost of a
   successful guess is high.

Run the relay behind nginx, Caddy, or Cloudflare doing TLS. A Caddy
example:

```caddy
relay.example.com {
  reverse_proxy 127.0.0.1:4400
}
```

Caddy adds `X-Forwarded-For` automatically. For nginx, set it
explicitly:

```nginx
location / {
  proxy_pass http://127.0.0.1:4400;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_read_timeout 3600s;
}
```

## Trust the proxy's X-Forwarded-For

The relay's per-IP unauthenticated-connection cap sees the **direct
peer**. Behind a reverse proxy that peer is the proxy and the cap
collapses into a single global counter unless you tell the relay
which peers to trust.

Set `RELAY_TRUSTED_PROXIES` to a comma-separated list of IPs or
CIDRs whose `X-Forwarded-For` header the relay should honor:

```bash
RELAY_TRUSTED_PROXIES=127.0.0.1,::1
```

The relay walks the header rightmost-to-leftmost, skipping entries
that are themselves in the trusted list, and uses the first
non-trusted entry as the client IP. If unset, the relay uses only
the direct peer.

Do **not** set this to a public range. An attacker who can reach
the relay directly while spoofing `X-Forwarded-For` would otherwise
impersonate any source IP, defeating the per-IP cap entirely.

## Environment variables

| Variable | Default | Effect |
|----------|---------|--------|
| `RELAY_PORT` | `4400` | TCP port to listen on. |
| `RELAY_DATA_DIR` | `~/.yep-relay` | SQLite registry, logs, telemetry. |
| `RELAY_TRUSTED_PROXIES` | empty | IPs/CIDRs whose `X-Forwarded-For` is trusted (see above). |
| `RELAY_RECLAIM_DAYS` | `90` | Days of inactivity before another `installId` can claim a username. |
| `RELAY_UNAUTHENTICATED_CONNECTION_LIMIT_PER_IP` | `10` | Pre-handshake connections per source IP. `0` disables. |
| `RELAY_UNAUTHENTICATED_CONNECTION_TIMEOUT_MS` | `30000` | Time a connection has to send a valid protocol frame before being closed. |
| `RELAY_PING_INTERVAL_MS` | `60000` | Ping interval for waiting connections (paired connections rely on the encrypted protocol's own keep-alive). |
| `RELAY_PONG_TIMEOUT_MS` | `30000` | Drop a waiting connection if no pong within this window. |
| `RELAY_LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |
| `RELAY_TELEMETRY_ENABLED` | `true` | Periodic samples + event log under `{dataDir}/telemetry/`. |

## HTTP endpoints

- `GET /health` — `{ status, uptime, waiting, pairs }`.
- `GET /status` — adds memory, registered count, and the list of
  active server registrations including username and `installId`.
- `GET /stats` — HTML rendering of telemetry samples.
- `GET /online/:username` — `{ online: boolean }`. Used by the
  client to check whether the user's yep-anywhere server is
  currently waiting.

`/status` and `/stats` reveal which usernames are registered and
connected. If you do not want this enumeration to be world-readable,
gate those paths with HTTP auth or an IP allow-list in your reverse
proxy.

## Data directory

```
~/.yep-relay/
├── registry.db        # SQLite: username → installId, timestamps
├── logs/relay.log     # if RELAY_LOG_TO_FILE
└── telemetry/         # if RELAY_TELEMETRY_ENABLED
```

`chmod 700 ~/.yep-relay` on a shared host. The SQLite file is not
sensitive in the cryptographic sense — it holds usernames and
opaque `installId` strings, not secrets — but other local users do
not need to read it.

## On the Node.js runtime

Node + npm carries real supply-chain and runtime-attack surface — this
process pulls in `ws`, `hono`, `better-sqlite3`, `pino`, and their
transitive trees. For something that holds nothing but a username
table and forwards opaque frames between paired sockets, that is more
trusted code than the design strictly needs.

A rewrite in Rust or Go would shed most of that: a few hundred lines
of WebSocket framing, a single SQLite touchpoint, an HTTP router for
four endpoints, the trusted-proxy IP logic above. Performance is not
the motivation — the hot path is `socket → socket` byte copy and the
workload is small — but a smaller TCB, a single statically-linked
binary, and an easier-to-audit dependency tree are. The protocol on
the wire is plain WS + small JSON envelopes followed by opaque framed
traffic, so a reimplementation is well-scoped and would not require
any client- or yep-anywhere-server-side change.

If you self-host and want to minimize the trusted footprint, this is
a viable direction. The Node implementation is the reference, not a
long-term commitment.

## Design

See `docs/project/relay-design.md` for the full protocol and crypto
design. This README is the operator's view; the design doc is the
contract.

## Setting up a Cloudflare Tunnel (end-to-end)

Cloudflare Tunnel (the `cloudflared` outbound-tunnel product) is a
practical free alternative to opening inbound ports on a home or
private-network box. The tunnel daemon dials outbound to Cloudflare;
Cloudflare terminates TLS at its edge with a free cert, accepts
public traffic on your hostname, and forwards it down the tunnel to
the relay process. No router NAT rules, no Let's Encrypt renewals,
and CGNAT-proof.

The free Cloudflare Zero Trust tier covers this use case (up to 50
users at the time of writing); confirm pricing on Cloudflare's site
before committing.

This walkthrough assumes the relay's box is on a private/home
network with outbound internet. For a persistent Cloudflare hostname
on a Free or Pro plan, expect to move the apex domain to Cloudflare's
primary DNS setup. If the apex DNS must stay with another provider,
skip to the Tailscale Funnel option below instead. Substitute
`example.com` and `relay.example.com` with your own.

### 1. Create a Cloudflare account

Sign up at `dash.cloudflare.com/sign-up`. Email + password, verify
the email, enable 2FA (TOTP or hardware key). No payment method is
required for the Free plan or for Zero Trust Free.

Signing in with Google works too; `cloudflared` does not touch
Google directly — the CLI auth flow opens a browser, you log in to
`dash.cloudflare.com` however you configured it, and the CLI
receives a `cert.pem` used non-interactively afterward. The cost of
SSO is that losing the Google account locks you out of Cloudflare;
set account-recovery options either way.

### 2. Add a domain to Cloudflare

On Free and Pro, Cloudflare's primary (full) DNS setup is the
available setup for a persistent custom hostname. Subdomain-only
partial setups require a paid Business-or-higher path, and delegated
subdomain setups are Enterprise-only. Two realistic free paths remain:

**Option A: Move the apex (`example.com`) to Cloudflare DNS.** This is
the Cloudflare Free path to a custom `relay.example.com` hostname.
Use Cloudflare's domain onboarding flow to add `example.com` on the
Free plan, then review the imported DNS records before changing the
registrar's nameservers to the two Cloudflare nameservers assigned
to the zone. Records currently served by a third party (GitHub
Pages, Netlify, Vercel, mail providers) should usually stay DNS-only
unless you have verified that proxying them is supported. After the
nameserver change, Cloudflare is authoritative for all of
`example.com`'s DNS.

**Option B: Use Tailscale Funnel instead.** Different vendor, same
shape: outbound tunnel from the relay box, free for personal use,
no DNS changes anywhere. The public URL becomes
`https://<machine>.<tailnet>.ts.net`. If you do not want to move
your apex to Cloudflare, this is the simplest path; the rest of
this section is Cloudflare-specific and does not apply.

Cloudflare also offers ephemeral "TryCloudflare" tunnels at random
`*.trycloudflare.com` URLs — useful for a one-off test, but the
URL rotates every restart, so not suitable for a persistent relay.

### 3. Enable Zero Trust (free)

Open Cloudflare Zero Trust (also branded Cloudflare One in some
flows) for the account. Pick an account-wide team name if prompted
and choose the Free plan.

### 4. Create the tunnel

Create a remotely-managed Cloudflare Tunnel that uses `cloudflared`,
then name it (for example, `home-relay`).

The dashboard shows install commands tailored to the box's OS. On
Linux, a typical sequence:

```bash
curl -fsSL \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared
# One-time service-install command (with token) from the dashboard:
sudo cloudflared service install <TOKEN>
```

Swap `-amd64` for `-arm64` on ARM hardware (Raspberry Pi 4/5,
Apple-silicon Linux VMs, ARM cloud instances). Verify:

```bash
sudo systemctl status cloudflared
```

### 5. Map the public hostname to the local relay

In the tunnel's public hostname/application route configuration, add
a hostname-to-service route:

- Subdomain: `relay`
- Domain: `example.com` (the apex you moved to Cloudflare in step 2)
- Path: (blank)
- Service: `HTTP` → `localhost:4400`

Save. Cloudflare publishes the routing record inside its zone for
you; nothing else to touch in DNS.

### 6. Smoke test

```bash
curl -sS https://relay.example.com/health
# expect: {"status":"ok","uptime":...,"waiting":0,"pairs":0}
```

A successful JSON response means the tunnel is up and the edge
cert is good. Point a yep-anywhere server at the new relay:

```bash
yepanywhere --setup-remote-access \
  --username <name> --password <pw> \
  --relay wss://relay.example.com/ws
```

### 7. Tighten the configuration

With cloudflared in front, the relay always sees its peer as
`127.0.0.1`. Set:

```bash
RELAY_TRUSTED_PROXIES=127.0.0.1,::1
```

so the per-IP cap counts the real client IP that cloudflared puts
in `X-Forwarded-For`, not the single shared loopback address.

If you do not want `/status` and `/stats` world-readable, put them
behind a Cloudflare Access policy (free with Zero Trust) rather
than at the relay process.
