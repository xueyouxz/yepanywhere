# Source name prefixes

> `YA_` and `YEP_` prefixes on TypeScript symbols are ordinary module naming
> choices, distinct from `YEP_*` process environment variables and from global
> runtime names.

Topic: source-name-prefixes

## TypeScript scope

Top-level declarations in a TypeScript file with imports or exports belong to
that module. They do not become process environment variables, browser globals,
or Node globals. TypeScript supports `namespace`, but YA normally uses ES
modules instead: callers import an exported symbol explicitly.

For example, `YA_GROK_BATCH_SPEECH_METHOD` is an exported constant whose value
is the persisted string `"ya-grok-batch"`. The identifier is compile-time
source vocabulary; the string is runtime data. Renaming only the identifier
does not migrate the persisted value.

## Rename risk

Source-symbol prefix cleanup is separate from environment-variable migration.
Before renaming an exported `YA_*` or `YEP_*` symbol, check:

- imports within this repository;
- exports from a package entry point that downstream packages may import;
- string values used in storage, URLs, API payloads, protocol messages, or
  generated artifacts;
- explicit globals created through `globalThis`, `window`, `declare global`,
  script-tag execution, or non-module JavaScript.

An unexported module constant can normally be renamed mechanically with its
local references. An exported constant may be a package API even when its
value does not change. A persisted or protocol string needs a compatibility
migration based on the string value, independent of the TypeScript identifier.

## Prefix direction

Do not infer that every source symbol mentioning Yep Anywhere needs a product
prefix. Prefer the narrow domain name when module scope already provides
context. Use `YEP_` only where a product distinction is useful; avoid redundant
forms such as `YEP_YA_*`. Existing `YA_*` source symbols can be reviewed in a
separate pass rather than mixed into the `YEP_*` environment compatibility
change.
