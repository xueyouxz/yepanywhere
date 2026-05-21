# Codex Protocol Subset

This directory contains a checked-in subset of Codex app-server generated
TypeScript types used by the Codex provider runtime.

- `generated/`: copied subset from `codex app-server generate-ts --experimental`
- `index.ts`: stable typed exports consumed by provider code

Update subset:

```bash
pnpm codex:protocol:update
```

Check subset drift:

```bash
pnpm codex:protocol:check
```

Notes:

- The full generated Codex protocol dump is intentionally not checked in.
- Expected local Codex CLI version is configured in root `package.json` at
  `yepAnywhere.codexCli.expectedVersion`; server startup warns on mismatch.
