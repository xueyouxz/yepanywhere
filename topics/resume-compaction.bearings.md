# Resume Compaction Bearings

- [*] ‖ Provider-neutral resume-compaction plan
  > why: The missing user-visible behavior is a safe choice before expensive
  > old-session resume, not post-hoc rendering.
  - [x] Establish ground truth
    > why: Avoid building around handoff assumptions when providers already
    > expose compaction signals.
  - [ ] ‖ Gate 1: render/schema audit
    > why: The compact boundary is already the shared renderer signal;
    > initiation must not break existing continuity.
  - [x] ‖ Gate 2: provider contract/API
    > why: YA needs a first-class resume mode before UI can offer the choice
    > coherently.
  - [x] ‖ Gate 3: Claude compact-first resume
    > why: Claude TUI behavior is the observed regression target and SDK
    > slash-command compaction is available.
  - [ ] ‖ Gate 4: old-session user choice UI
    > why: Users need to choose the cost/context tradeoff instead of YA
    > silently creating handoff/new-session state.
  - [ ] Gate 5: Codex initiation probe
    > why: Codex has upstream compaction surfaces, but YA currently only
    > observes rendered items.
  - [ ] Gate 6: rollout/verification
    > why: Compaction can be slow, fail near limits, and consume provider
    > budget.
