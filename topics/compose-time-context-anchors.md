# Compose-Time Context Anchors
> Retired: queued/deferred user turns are delivered without prepended
> `(Ns ago)` / `(Ms later)` timing text.

Topic: compose-time-context-anchors

## Status

Compose-time context anchors used to be injected into deferred messages at the
moment they were promoted to the provider. A queued message that waited long
enough could arrive as:

```text
(93s ago)

user text
```

For multiple deferred chunks promoted as one provider turn, later chunks could
also carry `(Ms later)` markers between `--------` separators.

That behavior was removed because the timing marker was delivered inline as
part of the user turn. The provider saw text the user did not type, and the
client transcript echoed that same rewritten content. The current contract is
simple: queued/deferred delivery must preserve the user's message text, apart
from existing slash-command expansion and attachment references.

## Legacy Compatibility

Older transcripts and local pending-chip state can still contain anchored
queued turns. Client-side reconciliation may continue stripping leading
`(Ns ago)` / `(Ms later)` markers when matching an old delivered turn against a
persisted queued chip. That compatibility path must not be treated as license
to inject new timing anchors into provider input.

## Current Implementation

- `packages/server/src/supervisor/Process.ts` promotes deferred messages by
  passing the stored user text through the normal provider-message preparation
  path without adding timing prefixes.
- `packages/client/src/hooks/useSession.ts` retains legacy marker stripping
  only for reconciliation against older prefixed transcripts.
