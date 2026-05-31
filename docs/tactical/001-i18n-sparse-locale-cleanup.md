# I18n Sparse Locale Cleanup

Status: In Progress

Progress:

- [x] 2026-05-31: Completed a read-only scope pass. The runtime already falls
  back per key from active locale messages to `en.json`; non-English locale
  files currently contain 858 exact English-value duplicates across five
  locales.
- [x] 2026-05-31: Updated the client i18n loader/cache types so non-English
  locale bundles can be sparse `Partial<Messages>` overlays while `en.json`
  remains the complete catalog.
- [x] 2026-05-31: Added a focused client test that loads a mocked sparse
  Spanish catalog and verifies missing non-English messages fall back to
  English.
- [x] 2026-05-31: Added dependency-free `i18n:check` and `i18n:prune`
  commands, then pruned 858 exact English placeholder entries from non-English
  locale files.

## Context

Yep Anywhere keeps UI strings in `packages/client/src/i18n/*.json`, with
`en.json` acting as the canonical complete message catalog. Non-English locale
files are currently also comprehensive, which encourages contributors and
agents to add English placeholders whenever new features add keys.

That creates two problems:

- It hides untranslated strings because an English placeholder looks like a
  deliberate locale entry.
- It makes translation maintenance noisier because every new English key tends
  to fan out into every locale file even when no translation is available.

The client runtime already handles sparse locale data:

```ts
activeMessages[key] ?? defaultMessages[key]
```

So exact English duplicates in non-English files can be removed without
changing displayed text. Missing locale keys should simply fall back to English.

## Current Findings

Read-only audit results from 2026-05-31:

| Locale | Keys | Exact English Duplicates |
| ------ | ---: | -----------------------: |
| `de` | 1116 | 175 |
| `es` | 1116 | 171 |
| `fr` | 1116 | 182 |
| `ja` | 1116 | 166 |
| `zh-CN` | 1116 | 164 |

Total duplicate entries: 858 out of 5580 non-English entries, about 15%.

Every non-English locale file also contains `toolbarSendTitle`, a key that is
absent from `en.json`. Since message keys are typed from the English catalog,
this looks like a stale/dead key and should be investigated separately from the
exact-placeholder cleanup.

The read-only audit also found four translated Chinese strings whose placeholder
sets differ from English:

- `zh-CN.devicesMinutesAgo`
- `zh-CN.devicesHoursAgo`
- `zh-CN.remoteSetupMinutesAgo`
- `zh-CN.remoteSetupHoursAgo`

Those omit the English `{suffix}` placeholder intentionally or harmlessly
because Chinese does not use the plural suffix, but any future validation should
distinguish deliberate locale grammar from accidental placeholder loss.

## Decisions

- Treat `en.json` as the only required complete catalog.
- Treat non-English JSON files as sparse overlays.
- Remove non-English entries only when their value is exactly identical to the
  corresponding English value.
- Keep the runtime fallback behavior explicit and tested.
- Keep locale display names such as `localeNameFr: "Français"` even when they
  are identical across locales; they are still intentional values. If they are
  removed by the duplicate pass, fallback to English preserves behavior because
  `en.json` already stores endonym labels.
- Report or prune keys that are absent from `en.json` as a separate follow-up
  check, not as part of the first exact-duplicate removal.

## Non-Goals

- Do not machine-translate missing strings.
- Do not infer placeholders from partial or fuzzy English matches.
- Do not remove strings that are merely similar to English.
- Do not require every locale to be complete.
- Do not redesign the i18n API or introduce a runtime i18n dependency.

## Tactical Work

### 1. Allow Sparse Locale Files

- Update `packages/client/src/i18n.tsx` so loaded non-English messages are typed
  as `Partial<Messages>`.
- Keep `en.json` typed as the complete `Messages` source.
- Ensure `t()` continues to fall back from active locale to English per key.
- Consider adding a focused unit test that switches to a test locale with a
  missing key and verifies the English fallback.

### 2. Add Placeholder-Pruning Script

- Add a script, likely `scripts/prune-i18n-placeholders.mjs`.
- Support `--check` mode:
  - scan every non-English locale file;
  - fail when a non-English key has exactly the same value as `en.json`;
  - print counts per locale and a concise key list or sample.
- Support `--write` mode:
  - remove exact English duplicates from non-English locale files;
  - preserve existing key order minus removed keys;
  - write stable 2-space JSON with trailing newline.
- Add package scripts such as:
  - `i18n:check`
  - `i18n:prune`
- Keep the script dependency-free.

### 3. Remove Existing Exact Placeholders

- Run the pruning script in write mode.
- Review the diff for accidental removals.
- Run `pnpm typecheck`.
- Run focused tests if an i18n fallback test is added.

### 4. Follow-Up Key Health Audit

- Add or extend a check script to report keys present in non-English files but
  absent from `en.json`.
- Investigate `toolbarSendTitle`:
  - if dead, remove it from every non-English locale;
  - if live intent remains, add the correct English key and wire the UI to it.
- Add checks for English keys that are not referenced by the client, while
  allowing known dynamic or externally referenced keys if any exist.
- Add placeholder-token validation that warns when translated strings drop or
  add `{name}` tokens, with an escape hatch for intentional grammar differences
  such as Chinese plural suffix omission.

## Open Questions

- Should `i18n:check` run in CI by default, or should it remain a maintainer
  tool until the existing locale files are cleaned up?
- Should duplicate endonym labels such as `localeNameJa: "日本語"` be allowed as
  explicit locale entries, or should they rely on English fallback like any
  other exact duplicate?
- Should placeholder-token mismatches fail CI, warn only, or support a small
  allowlist of intentional locale-specific omissions?

## Suggested Implementation Order

1. Update i18n types to support sparse non-English catalogs.
2. Add a fallback test for a missing non-English key.
3. Add the pruning script with `--check` and `--write`.
4. Run the script and remove exact English duplicates.
5. Add a dead/extra-key reporting mode and resolve `toolbarSendTitle`.
6. Decide whether the i18n checks should be part of default CI.

## Verification Checklist

- `pnpm typecheck` passes after non-English locale files become sparse.
- Switching to each supported locale still renders English fallback text for
  missing keys.
- The pruning script is idempotent after the first write.
- `i18n:check` fails when a non-English file reintroduces an exact English
  placeholder.
- Dead-key audit reports `toolbarSendTitle` until it is removed or made valid.
