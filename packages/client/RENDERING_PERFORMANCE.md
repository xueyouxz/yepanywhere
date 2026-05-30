# Client Rendering Performance

This document describes the Yep Anywhere client render/update pipeline and the
performance invariants worth checking when browser-side latency regresses.

YA uses React for the ordinary app shell because most UI state is low-rate:
navigation, approvals, settings, queued-message controls, tool rows, and
completed transcript items. High-rate agent output is the exception. The design
is therefore to keep React for coarse UI structure while preventing token-sized
or bursty work from invalidating the whole transcript or running expensive
formatters repeatedly.

Do not replace React or introduce a custom framework-level renderer for this
class of bug. Prefer simple, standard React data flow first. Imperative DOM
updates are reserved for narrow leaf streaming paths where YA owns the chunking
and can prove the update is cheaper and behaviorally isolated.

Do not assume React will compute useful edit scripts inside long strings.
Changed text props and `dangerouslySetInnerHTML` updates should be treated as
coarse updates. Incremental wins come from YA-owned chunking, block DOM updates,
stable component identity, and lower update cadence.

## Pipeline

1. Session streams enter through `useSessionStream` and are dispatched in
   `useSession`.
2. Token-level `stream_event` messages go to `useStreamingContent`, which
   accumulates deltas in refs and flushes React message updates at a bounded,
   adaptive cadence. Queue acknowledgements, full user/assistant messages,
   status changes, and explicit controls stay immediate.
3. Server-rendered streaming markdown enters through `useStreamingMarkdown`.
   Completed block augments are applied to DOM refs at a bounded cadence, with
   final flushes on stream end/reset/capture.
4. `useSessionMessages` merges live stream messages and persisted JSONL
   messages. Hot streaming-placeholder updates check the tail first before
   scanning the loaded transcript.
5. `MessageList` preprocesses loaded messages into `RenderItem[]`, groups
   adjacent assistant items into turns, and stabilizes unchanged render item
   object identity so memoized row components can skip unchanged history.
6. `RenderItemComponent` routes exactly one render item to one block/tool
   renderer: text, thinking, tool call, user prompt, session setup, or system.
7. Rich renderers operate on block/tool-sized input:
   - text blocks use server markdown HTML when available, streaming markdown
     DOM while live, and local fixed-font math as fallback after completion;
   - tool renderers receive one tool input/result or one file/diff/output
     block, not the session transcript;
   - ANSI rendering receives one output string at a time.

## Invariants

- Rich formatting components must not receive the whole session history.
  KaTeX, markdown, Shiki HTML, ANSI, diff, and fixed-font renderers operate on
  one message block, one tool result, one file, or one preview.
- High-rate events must be coalesced before they reach React state unless they
  are user-visible acknowledgements or controls that need sub-second latency.
- Light-load queue/ack/status UI should remain immediate. Backpressure belongs
  on token/render/freshness paths, not on user message acceptance.
- Conditional UI controls must not run an expensive render only to decide
  whether the control exists. Prefer transforms that return structured metadata
  such as `{ html, changed }`, and pass that first completed scan into the
  toggle/display component. Do not require expensive edit-distance or span
  mapping for packages that do not naturally expose it. Span/position edits are
  an acceptable optional result only when the transform already knows them and a
  caller can apply them incrementally.
- Avoid string comparisons as change detection after a formatter has already
  determined whether it changed anything. Preserve and reuse the boolean.
- When fixing one high-rate path, keep tracing. A throttled markdown path does
  not prove text placeholders, tool previews, activity/freshness state,
  queued-message UI, or composer-adjacent state are also covered.
- Long transcript work must preserve row identity for unchanged history and
  should avoid front-to-back scans on hot current-message updates.
- Composer text is user data. Streaming/render work must not steal focus,
  defeat normal browser key buffering, or delay page-lifecycle draft flushes.

## Profiling

Enable Developer Mode remote log collection, or set this in DevTools:

```js
window.__RENDER_PROFILE__ = { thresholdMs: 4 };
```

Slow formatter calls emit `[RenderProfile]` console entries locally and
`render-profile` entries through the remote client log path when remote logging
is enabled. Current profiled components include:

- `fixed-font-math`
- `fixed-font-rich-content`
- `ansi-render`

Each entry includes duration plus coarse input size (`chars`, `lines`) where
available. Use these timings with stream-event counts and React update cadence:
a slow formatter matters most when it is reached by a high-rate path or when it
runs over a long block more than once.

## Review Checklist

- Does this change introduce a new path from token-sized events to React state?
- Does any formatter see more than a block/tool/file-sized input?
- Does a conditional affordance render or parse content just to decide whether
  it should appear?
- Is the first expensive transform result reused by the component that displays
  it?
- Do unchanged transcript rows keep stable object identity across a streaming
  update?
- Do tests cover both the cheap live path and the completed rich path?
