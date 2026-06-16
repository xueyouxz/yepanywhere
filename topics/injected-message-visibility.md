# Injected-message visibility contract

How YA-injected, non-user text (control commands, compaction summaries, skill
contents, resume re-injection) is shown — or hidden — in the transcript UI.

See also: [`ui-architecture.md`](ui-architecture.md) (rendering boundary),
task 029 (per-model compact threshold, the first consumer of the hide path).

## Invariant

**YA-injected context-initialization text must not render as an ordinary user
or assistant turn.** When YA, rather than the user, puts text in front of the
agent to shape context — the `/compact` command it queues, a post-compaction
summary, a skill body, a resume-from-full re-injection — that text either
carries a system/compaction visibility contract (rendered as a boundary/system
item) or is hidden, but it is never a normal turn. The symptom this guards
against: a `/compact` user bubble, or a wall of skill/resume text, appearing as
if the user typed it.

## Single hide chokepoint (landed)

All hiding of injected user-role messages routes through **one** predicate so a
future "show hidden" UI can reveal them consistently instead of each call site
deciding ad hoc:

- `UserMessageMetadata.hidden?: boolean` (`packages/shared/src/user-message-metadata.ts`)
  is the only signal.
- `Process.isHiddenInjectedMessage(message)` (`packages/server/src/supervisor/Process.ts`)
  is the only reader. It gates the optimistic **user echo** in
  `queuePreparedMessage` (both the SSE-replay bucket push and the live emit) —
  and nothing else. It is deliberately **not** folded into `shouldEmitMessage`,
  which must stay an unconditional `return true` for provider-stream messages.
- Producer: `Supervisor.tryResumeCompaction` stamps `metadata.hidden` on the
  `/compact` it queues, so **both** resume-time compact-first and the task-029
  threshold trigger emit no `/compact` user turn — matching native
  auto-compaction, which shows none.

### Result vs. visibility contract

A YA-initiated compaction has two halves, both satisfied by reusing
`tryResumeCompaction`:

- **Result contract** — it drives a real `compact_boundary` system message,
  which the client renders as a collapsed "Context compacted" item
  (`preprocessMessages.ts`, system-subtype branch). Same as native.
- **Visibility contract** — the `/compact` command itself is hidden (above), so
  no spurious user bubble. Same as native.

Scope note: the hide path covers the **optimistic echo** (a YA-side SSE
broadcast, not the JSONL transcript). `/compact` as a recognized provider slash
command is not persisted as a user content turn, so suppressing the echo is
sufficient for the live path. If a provider ever did persist it, that becomes a
JSONL-classification problem — see Part 2.

## Part 2 — pre-existing leak (separate task, not yet built)

Skill contents and resume-from-full init text render as normal turns today.
Those are **real JSONL transcript messages**, not optimistic echoes, so the
echo chokepoint above does not touch them; the fix is to classify/tag injected
context-init text in the render pipeline (`preprocessMessages.ts`) so it
inherits the system/hidden contract. This predates task 029.

## "Show hidden" — future exploration (no implementation yet)

Hidden turns are currently fully suppressed. The intended direction is to make
them **hyper-collapsed** (outline/modal, like the collapsed-system style, or
more) rather than fully gone, so the user keeps visibility into the effective
context — e.g. the system prompt / initial AGENTS-load result, recalled as once
showing as an expandable turn. The single hide chokepoint exists precisely so
this can be added in one place: flip "suppress" to "emit with a hidden marker"
and give the client one render path for hidden items.
