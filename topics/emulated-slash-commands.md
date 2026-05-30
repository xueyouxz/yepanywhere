# Emulated Slash Commands

> Emulated slash commands are YA-advertised commands whose submitted text is
> rewritten or routed by YA when the provider has no native command for that
> behavior.

Native provider slash commands win. YA should not shadow a command the provider
advertises; emulation exists to provide a stable user vocabulary across
providers and harnesses when the provider command inventory has a gap.

Default emulation behavior is based on the user-authored skills in
`github.com/graehl/agents`, whose local development checkout may be installed
as the runtime skills directory.

## Contracts

- A slash command entry may carry `emulation.providerText`, declaring the exact
  provider-visible replacement template YA sends when the user submits that
  command. `{{argument}}` is the raw text after the command name.
- Emulation must happen before provider ingress. Initial messages, resumed
  messages, direct queueing, and deferred-promotion paths should all pass
  through the same rewrite/routing layer before provider text is emitted.
- Provider-native commands take precedence. If the provider reports `/wish`,
  `/doubt`, `/rep`, `/harsh-review`, `/goal`, or another native equivalent, YA
  must expose and send the native command unaltered unless a provider-specific
  topic explicitly says otherwise.
- Codex user skills currently activate through `@skill`, not `/skill`, even
  when the skill's own instructions describe slash invocation. For Codex-backed
  sessions, YA should preserve native/system slash commands such as `/goal` but
  rewrite non-native skill-shaped submissions from `/name ...` to `@name ...`
  before provider ingress.
- The command menu should distinguish availability from implementation shape.
  A command may be native, provider-text emulated, YA-routed, or unavailable;
  unsupported commands should not silently fall through as ordinary prompt text
  when YA advertised them as commands.
- Emulated commands should preserve the user's argument text verbatim except
  for the declared template substitution. Parsing inside the command belongs to
  the skill/provider behavior, not to the generic rewrite layer.

## Default Skill Vocabulary

These are the default user-facing fallback commands YA should prefer when a
provider has no native equivalent:

- `/wish <goal>`: pursue a goal until it is verifiably done. On Codex, native
  `/goal` is preferred because the runtime preserves the goal across context
  limits. On Claude, YA may expose `/goal <goal>` as an alias that sends
  `/loop wish <goal>` when Claude reports `/loop` but not `/goal`.
- `/rep ...`: repeat or self-pace a prompt across wakeups. This is ordinary
  command behavior, not a side-session helper.
- `/doubt ...`: run an independent re-check before comparing with the prior
  answer. When YA implements this without provider-native support, it may use
  the shared helper side session from
  [side-session-config.md](side-session-config.md), but independence is an
  instruction to the helper, not a special partial-catch-up mode.
- `/harsh-review ...`: run the stricter structural/correctness review pass.
  This is ordinary command behavior unless a provider later ships an equivalent
  native review command.

## Future Skill Distribution

YA should not silently assume these skills exist in the user's provider
environment. If a provider session lacks the target skill/command, the first
product step is to explain that the command is unavailable and suggest
installing the relevant `github.com/graehl/agents` skill, with a link or
copyable install instruction.

Vendoring is a possible later implementation choice for YA-private use, such
as a side-session `doubt` helper. If YA vendors a skill, keep two concerns
separate:

- User slash-command invocation remains explicit. YA must not cause the user's
  agent harness to run a vendored skill just because matching text appears in
  the conversation; invocation still requires an advertised slash command or a
  YA-owned explicit route.
- A user-installed skill or provider-native command of the same name wins over
  YA's bundled fallback. Vendoring supplies a fallback implementation, not an
  override of the runner's chosen skill version.
- Private helper prompt text can be bundled for YA orchestration, but should
  use the same precedence rule: prefer the user's installed skill when it is
  available and intentionally invoked.

In other words, vendoring must not create accidental non-slash invocation, and
must not replace a user-customized skill of the same name. Native provider
commands still take precedence, and no vendoring work is implied by the current
recap/goal implementation.

## Tests That Should Fail On Contract Regressions

- A YA-advertised emulated command sent as the first message of a new or
  resumed provider session reaches the provider as its expanded/routed form.
- A directly queued or deferred-promoted emulated command reaches the provider
  as its expanded/routed form.
- If a provider advertises a native command with the same name, YA does not
  rewrite that command.
- An advertised but unsupported YA-routed command fails visibly instead of
  being sent to the provider as plain prompt text.
