# Prompt Suggestion Mode Persistence

Status: Planned

Progress:

- [ ] Add `promptSuggestionMode` to `SessionMetadata` + service write/prune.
- [ ] Accept/validate/emit it in `PUT /sessions/:sessionId/metadata`.
- [ ] Persist the chosen mode to metadata when a session is created.
- [ ] Resolve the resume mode from metadata.
- [ ] Add a current-session toggle in the client (writes metadata).

## Context

`promptSuggestionMode` (`"off" | "native"`, `packages/shared/src/types.ts:123`)
is currently a per-request value only. The client sends it in the body of
create/resume calls and nothing persists it per session. Two failures result:

1. **Suggestions come back after a resume.** The four `api.resumeSession`
   callers omit the field (`SessionPage.tsx:1419/1533/1817/2391`), the route
   parses `undefined` (`sessions.ts:277` `parseOptionalPromptSuggestionMode`),
   and the resolver maps `undefined → "native"` for Claude:

   ```ts
   // Supervisor.resolvePromptSuggestionMode — Supervisor.ts:509
   if (requestedMode === "off") return "off";
   if (provider.supportsNativePromptSuggestions === true) return "native"; // Claude
   return "off";
   ```

   So an explicitly-disabled session re-enables suggestions whenever the live
   process is gone (idle-reaped, restart, 404 retry) and the next turn resumes.

2. **No way to change it after creation, no cross-device value.** The only
   durable store is the server-wide `newSessionDefaults` (`NewSessionForm.tsx:1048`),
   which is a default for *new* sessions, not a per-session value. A client
   localStorage approach (the `MessageInput` `patient-queue-enabled` pattern,
   `MessageInput.tsx:330`) is rejected: device-local, not synced.

## Design

**Session metadata is the single source of truth for this per-session
preference.** It already stores per-session settings keyed by session id in
`session-metadata.json` (`SessionMetadataService`), with the recent
`heartbeatTurnsEnabled` cluster as the precedent to copy
(`SessionMetadataService.ts:30`, route `sessions.ts:4068`, event
`EventBus.ts:135`, client `client.ts:967`, toggle `SessionHeartbeatModal.tsx:223`).

The flow becomes one path through metadata:

- **Create** — the route resolves the mode from the request body (as today) and
  writes the resolved value to metadata, next to where it already persists
  `provider`/`executor` (`sessions.ts:2906` `setExecutor`).
- **Resume** — the route reads the mode from metadata and uses it. The resume
  request body no longer needs to carry this field, so the four client resume
  callers stay untouched.
- **Change** — a current-session toggle writes metadata via
  `PUT /sessions/:sessionId/metadata`; the next resume/turn picks it up.

No dual sourcing, no client/server fallback chains. The body carries the value
once (at create); after that the per-session value lives in metadata.

## Server changes

1. **Field** — `SessionMetadataService.ts:12` (`SessionMetadata`):
   ```ts
   /** Per-session prompt-suggestion preference. */
   promptSuggestionMode?: PromptSuggestionMode;
   ```
2. **Write** — `updateMetadata` (`SessionMetadataService.ts:226`): accept it and
   apply. `""`/`null` clears (revert to default); `"off"`/`"native"` store as-is.
   Do not collapse `"off"` to `undefined` — `"off"` is a meaningful stored value
   that must override the provider's native default.
3. **Prune** — `cleaned` block (`SessionMetadataService.ts:300`): keep the field
   so the entry survives (`if (updated.promptSuggestionMode) cleaned.promptSuggestionMode = ...`).
4. **PUT route** — `sessions.ts:4068`: add to the body type, the "at least one
   field" guard, validate with `parseOptionalPromptSuggestionMode`
   (`sessions.ts:277`), pass to `updateMetadata`, and add to the
   `session-metadata-changed` emit (`sessions.ts:4209`).
5. **Event** — `EventBus.ts:136` (`SessionMetadataChangedEvent`): add the field.
6. **Persist on create** — in the create handler, after the session id is known,
   `updateMetadata(sessionId, { promptSuggestionMode: <resolved> })`. Mirror the
   existing `setExecutor`/`updateMetadata` calls in the route layer
   (`sessions.ts:2906`, `:3285`).
7. **Resume from metadata** — in the resume handler, read
   `getMetadata(sessionId)` (the handler already reads metadata for provider
   lookup, `sessions.ts:2916`) and pass its `promptSuggestionMode` into
   `resumeSession`. Still run it through `resolvePromptSuggestionMode` so a
   stored `"native"` degrades to `"off"` if the resumed provider lacks native
   support.

## Client changes

1. **API type** — `client.ts:967` (`updateSessionMetadata` updates type): add
   `promptSuggestionMode?: PromptSuggestionMode`.
2. **Toggle UI** — a current-session control that calls
   `api.updateSessionMetadata(sessionId, { promptSuggestionMode })`, modeled on
   `SessionHeartbeatModal.tsx:223`. Reflect the persisted value (via session
   summary/metadata, kept current by the `session-metadata-changed` event).

No change to the resume call sites and no new shared type
(`PromptSuggestionMode`/`PROMPT_SUGGESTION_MODES` already exist,
`packages/shared/src/types.ts:123`).

## Notes / edge cases

- **Legacy sessions** created before this feature have no stored value, so they
  resolve to the provider default (`"native"` for Claude) on resume — unchanged
  from today. The fix applies to sessions created or toggled after it ships.
- **Per-session stickiness is intended.** A session keeps the mode it was
  created/toggled with; later changes to `newSessionDefaults` do not retroact
  onto existing sessions.
- **Live in-process mutation is out of scope.** The SDK query fixes
  `promptSuggestions:` at launch (`claude.ts:1407`, `Supervisor.ts:720`), so a
  toggle takes effect on the next resume/turn, matching the heartbeat model.

## Tests

- `updateMetadata({ promptSuggestionMode: "off" })` round-trips via
  `getMetadata`; `null`/`""` clears it; `"off"` survives the prune block.
- PUT route rejects an invalid mode with 400.
- Create with `"off"` persists `"off"` to metadata.
- Resume with stored `"off"` and a body that omits the field →
  `resumeSession` receives `"off"` (process launches `promptSuggestions:false`).
- Regression: create with suggestions off → let the process terminate → resume
  → no `prompt_suggestion` is requested.
