# Claude Provider Control Bearings

- [*] ★ Repair Claude YA-owned visibility and restart resume
  > why: User-observed Claude sessions can look stalled in YA while the provider
  > completed substantial autonomous work, and prior YA-owned sessions can fall
  > into handoff after a full YA restart instead of attempting safe normal resume.
  - [x] Record the observed gaps and suspected causes in `topics/claude.md`.
    > why: The investigation crosses live streaming, durable transcript parsing,
    > state-machine evidence, and restart/handoff policy; the durable topic needs
    > the contract before source edits narrow only one symptom.
  - [*] Audit live SDK message intake against Claude SDK 0.3.x types.
    > why: The installed SDK exposes many message shapes beyond the original
    > `assistant`/`user`/`result` path; unknown user-visible or state-bearing
    > messages may explain why an already-open tab and a later YA view diverge.
    - [ ] Compare `SDKMessage` union entries to `claude-sdk-schema`.
    - [ ] Classify each missing type as render, liveness/status, durable-only,
          debug-only, or intentionally ignored.
    - [x] Add focused coverage for `session_state_changed`, the first
          state-bearing gap closed in this pass.
      > evidence: `packages/shared/test/claude-sdk-schema.test.ts` verifies the
      > durable schema parses it; `packages/server/test/process.test.ts`
      > verifies `idle` and `requires_action` state handling.
    - [ ] Add focused coverage for remaining message types that affect visible
          progress, task/tool rows, prompt suggestions, or turn state.
  - [ ] Audit `Process` replay/catch-up for Claude live activity.
    > why: The live replay window excludes `stream_event` and currently catches
    > up only accumulated assistant text; late YA views may miss thinking,
    > task/tool progress, session-state, or status events that the original
    > subscriber saw.
    - [ ] Check whether server catch-up needs richer accumulated blocks or a
          durable refresh trigger after reconnect.
    - [x] Check whether listener/augmenter errors are being swallowed where a
          structured warning would expose a broken subscriber path.
      > evidence: `Process.emit()` now logs `process_listener_error` while
      > preserving fan-out, with focused test coverage.
    - [ ] Check whether the original-tab-only success points to per-subscriber
          replay/catch-up rather than provider intake.
  - [*] Audit Claude state-machine evidence.
    > why: SDK `session_state_changed` messages may provide authoritative
    > running/requires-action/idle state; YA currently relies mostly on `result`,
    > iterator completion, and legacy input-request handling.
    - [x] Decide how `session_state_changed` maps into `Process` state and
          `SessionLivenessSnapshot`.
      > decision: `idle` is accepted as a turn boundary; `running` moves back
      > to in-turn without clearing pending approvals; `requires_action` keeps
      > the process non-idle but does not fabricate an interview prompt.
    - [ ] Confirm queue promotion and heartbeat gates still use `verified-idle`
          rather than weak process-alive or raw event cadence.
  - [x] Publish the real Claude session id to later agentctl-managed tool
        shells for YA-owned local processes.
    > decision: YA cannot safely mutate a running provider process environment
    > after startup. Local Claude sessions instead start with a `BASH_ENV`
    > bridge that preserves an existing `BASH_ENV` and sources a tiny
    > YA-managed env file; when `system/init` reports the canonical session id,
    > `Process` asks the provider to rewrite that env file with
    > `AGENTCTL_SESSION_ID`. Resume sessions seed the id before startup.
    > evidence: focused server tests cover the real Bash bridge, the `Process`
    > publish hook, and the analogous Codex app-server shell timing.
  - [*] Audit Claude interview forms.
    > why: Claude can present modal TUI choice prompts with cancel and
    > free-form answer paths; YA needs to surface these as actionable
    > waiting-input UI rather than leaving the session looking stalled.
    > Claude `requires_action` may currently only cover approvals, so do not
    > assume it covers the richer interview form surface without tracing it.
    - [x] Identify the Claude SDK message/control path for multiple-choice,
          cancel, and free-form responses.
      > decision: Claude interviews arrive through the SDK `canUseTool` path as
      > `AskUserQuestion`, not as a new message mode. YA answers by returning
      > the original input plus `answers` through `updatedInput`.
    - [x] Classify Claude `AskUserQuestion` as user input rather than approval.
      > evidence: `packages/server/test/process.test.ts` verifies the request
      > uses `type: "question"` and ignores a matching deny permission rule.
    - [x] Preserve single-select, multi-select, and free-form answer shape in
          client/server/schema types.
      > evidence: `packages/client/src/components/__tests__/QuestionAnswerPanel.test.tsx`
      > covers multi-select plus "Other"; `packages/shared/test/claude-sdk-schema.test.ts`
      > accepts string-array answers.
    - [ ] Manually verify a real Claude `AskUserQuestion` round trip, including
          whether a completed answer can immediately lead to another prompt
          without flicker or lost pending-input state.
  - [*] ★ Repair normal resume after YA restart.
    > why: Losing the old YA-owned process after restart is expected and should
    > not route directly to handoff when Claude can safely resume the transcript.
    - [x] Trace the resume API path for `ownership.owner === "none"` after
          restart.
    - [x] Keep the active-branch API-error blocker, but prove no-owner and
          external-owner states are not misclassified as unsafe transcript
          states.
    - [x] Add route/supervisor coverage: safe Claude transcript resumes normally
          after restart; unsafe API-error tail still returns handoff-required.
      > evidence: `packages/server/test/routes/sessions-metadata.test.ts`
      > covers safe no-owner Claude resume and retains the API-error blocker
      > coverage.
    - [ ] Manually verify full YA restart against a real persisted Claude
          session before calling the user-observed restart gap fully repaired.
  - [ ] Validate against a real or synthetic long-autonomous Claude session.
    > why: The reported failure appears after several autonomous turns, so a
    > one-turn smoke can miss the visibility gap.
    - [ ] Use SDK raw logging or a fixture containing task/progress/state
          messages to verify live and reconnect views converge.
    - [ ] Verify full restart followed by normal resume before relying on
          handoff as recovery.
