# Glossary

Project-specific terminology for Yep Anywhere. Topic-linked rows point to
`topics/<name>.md` cross-cutting-concern docs.

See [`topics/glossary.md`](topics/glossary.md) for contribution and
regeneration rules.

| term | definition | topic / refs |
|---|---|---|
| `/btw` asides | YA-owned side work streams started from `/btw`, kept separate from the parent session unless the user explicitly injects their output. | [provider-agnostic-btw-asides](topics/provider-agnostic-btw-asides.md) |
| `architecture-mandates` | Load-bearing requirements that preserve bounded resource use, recoverability, and user-visible state correctness across provider, transport, and client changes. | [architecture-mandates](topics/architecture-mandates.md) |
| `claude` | Claude-specific control surface, especially which sessions YA can actively configure versus only observe through provider transcript files. | [claude](topics/claude.md) |
| `codex-api-provider` | Future OpenAI Platform API-backed Codex provider, distinct from the current Codex CLI/app-server path for ChatGPT subscription users. | [codex-api-provider](topics/codex-api-provider.md) |
| `compact-and-handoff` | Targeted Codex mitigation that treats compaction and replacement-session handoff as explicit state transitions rather than generic restart behavior. | [compact-and-handoff](topics/compact-and-handoff.md) |
| `cost-efficiency` | Preferring subscription/local capacity over metered APIs, avoiding accidental expensive paths, and never silently switching a credential or model to a pricier one. | [cost-efficiency](topics/cost-efficiency.md) |
| `emulated-slash-commands` | YA-advertised commands whose submitted text is rewritten or routed by YA when the provider has no native command for that behavior. | [emulated-slash-commands](topics/emulated-slash-commands.md) |
| `glossary` | The root project vocabulary table: topic-linked definitions come from topic-doc ledes and curated vernacular rows preserve local naming decisions. | [glossary](topics/glossary.md) |
| `grok` | xAI Grok Build provider integration, isolated behind provider-specific files and feature gates while ACP supervision matures. | [grok](topics/grok.md) |
| `hard-development-rules` | Binding upstream-facing constraints that protect user trust, explicit configuration, and operator intent across YA changes. | [hard-development-rules](topics/hard-development-rules.md) |
| `heartbeat` | YA's heartbeat-shaped mechanisms, separating transport/status frames from provider liveness evidence and user-visible state. | [heartbeat](topics/heartbeat.md) |
| `kzahel-disabled` | YA UI or behavior experiments that upstream disables or removes, but that may still be worth preserving behind explicit user configuration. | [kzahel-disabled](topics/kzahel-disabled.md) |
| `memory-growth` | Browser and server memory constraints for long-lived YA sessions, especially avoiding whole-transcript work on idle UI timers. | [memory-growth](topics/memory-growth.md) |
| `message-control-steer-queue-btw-later-interrupt` | UI-visible message-control contract for direct sends, steering, queueing, `/btw`, and deferred or later intent while a session is busy. | [message-control-steer-queue-btw-later-interrupt](topics/message-control-steer-queue-btw-later-interrupt.md) |
| `opencode-backend` | The OpenCode backend is YA's provider integration contract for starting, resuming, controlling, and rendering OpenCode sessions without losing provider-specific transcript meaning. | [opencode-backend](topics/opencode-backend.md) |
| `pixel-aesthetic` | Native-size pixel judgment for tiny UI glyphs, including their real toolbar, device-pixel-ratio, theme, and button context. | [pixel-aesthetic](topics/pixel-aesthetic.md) |
| `pluggable-speech-recognition` | User-selected speech recognition methods where browser-native remains local fallback and configured YA backends receive browser-captured audio. | [pluggable-speech-recognition](topics/pluggable-speech-recognition.md) |
| `predictive-scroll` | On-demand hydration and placeholder sizing for expensive session rows so long transcripts avoid unnecessary upfront render work. | [predictive-scroll](topics/predictive-scroll.md) |
| `prompt-suggestions` | Predicted next-user-turn affordances surfaced in the composer without becoming provider transcript turns unless the user accepts one. | [prompt-suggestions](topics/prompt-suggestions.md) |
| provider | Shorthand for an LLM/agent provider such as Claude, Codex, Gemini, Grok, or OpenCode; do not use it for speech recognition. | |
| `provider-model-glyphs` | Compact provider and model identity glyphs for status surfaces where full provider/model text is too wide. | [provider-model-glyphs](topics/provider-model-glyphs.md) |
| `provider-state-machine` | Provider and process state contract that determines what YA renders and which actions are valid in each state. | [provider-state-machine](topics/provider-state-machine.md) |
| `recaps` | Short on-return summaries of what the agent did or is doing while the user was away, shown without polluting provider transcript state. | [recaps](topics/recaps.md) |
| `relative-filenames` | Shortest-unambiguous file path display policy: project-relative, home-relative, then absolute as fallback. | [relative-filenames](topics/relative-filenames.md) |
| `relay-origin-and-share-gating` | Public share and relay-origin rules keep hosted links, relay transport, and secret-bearing read-only access explicit about who can fetch what and who can observe it. | [relay-origin-and-share-gating](topics/relay-origin-and-share-gating.md) |
| `rich-text-rendering` | Rendering pipeline for agent action panels, including command output, file reads, diffs, edits, and their always-on or toggleable transforms. | [rich-text-rendering](topics/rich-text-rendering.md) |
| `security` | YA's trust-boundary contract: local authenticated controls may expose privileged host state, while public and relay surfaces must stay explicit, scoped, and revocable. | [security](topics/security.md) |
| `session-liveness` | Provider/session liveness contract and dependent behaviors such as heartbeat turns, deferred queue promotion, and experimental patient queue intent. | [session-liveness](topics/session-liveness.md) |
| `session-ui-customization` | User control over which session controls are visible or enabled while keyboard access to advanced actions is preserved. | [session-ui-customization](topics/session-ui-customization.md) |
| `side-session-config` | Shared opt-in, model-selection, and lifecycle contract for YA-simulated helper features that run outside the parent provider turn. | [side-session-config](topics/side-session-config.md) |
| STT backend | A speech-to-text backend used by YA speech recognition, such as browser-native, Grok STT, Deepgram STT, or Whisper; prefer this wording over "speech provider" in UI and project docs. | [pluggable-speech-recognition](topics/pluggable-speech-recognition.md) |
| `ui-architecture` | UI architecture keeps shared rendering, layout, and interaction behavior attached to the data or render boundary that produces it, rather than patching generated DOM after the fact. | [ui-architecture](topics/ui-architecture.md) |
| `ui-control-alignment` | Shared baseline and metric policy for aligning compact control rows without per-control visual nudges. | [ui-control-alignment](topics/ui-control-alignment.md) |
| `ui-testing` | Browser-first visual QA protocol for layout-sensitive client control changes. | [ui-testing](topics/ui-testing.md) |
| YA | Shorthand for Yep Anywhere, the mobile-first supervisor for local provider sessions and remote/mobile session UI. | |
| `ya-env-vars` | Catalog of YA environment variables and the naming conventions distinguishing YA-private consume-and-strip secrets, YA config toggles, and inherited vars. | [ya-env-vars](topics/ya-env-vars.md) |
