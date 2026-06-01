# npm Trusted Publishing Release

Status: Implementing

Progress:

- [x] 2026-06-01: Captured the `v0.5.0` publish failure pattern, prior
  repo history, and current npm trusted-publishing requirements.
- [x] 2026-06-01: Split npm release validation from package publishing so
  Playwright runs under Node 20 and trusted publishing runs under npm 11.
- [x] 2026-06-01: Add an explicit OIDC token-exchange preflight before the
  irreversible `npm publish` step.
- [ ] 2026-06-01: Re-run the `v0.5.0` publish after CI validates the workflow
  fix.

## Context

The `v0.5.0` npm release initially hung in the publish workflow while
installing Playwright's Chromium browser under Node 24. The same Playwright
install completes in CI under Node 20.

Changing the publish workflow to Node 20 fixed the Playwright hang, but the
actual `npm publish` then failed with:

```text
npm error code E404
npm error 404 Not Found - PUT https://registry.npmjs.org/yepanywhere - Not found
npm error 404  'yepanywhere@0.5.0' is not in this registry.
```

The package exists, and the npm registry still reports `yepanywhere@0.4.28`.
The `0.5.0` version has not been published.

## Findings

npm's trusted-publishing documentation currently requires npm CLI `11.5.1` or
later and Node `22.14.0` or later. It recommends Node 24 because it ships with
a compatible npm version by default. The failed `v0.5.0` publish attempt used
Node `20.20.2` with npm `10.8.2`.

The npm CLI issue tracker has matching reports where trusted-publishing
failures surface as misleading `E404` or `ENEEDAUTH` errors. The practical
root cause in several cases was an unsupported npm CLI version, not a missing
package.

This repo has already hit the same release class:

- `v0.4.21` and `v0.4.22` failed with npm 10 `E404` publish errors.
- `v0.4.23` failed while trying to self-upgrade npm 11 under Node 22 with
  `MODULE_NOT_FOUND: promise-retry`.
- `v0.4.24` succeeded after moving the publish workflow to Node 24, whose
  bundled npm was already npm 11.

The current issue is therefore two independent requirements colliding in one
job:

- browser-test validation is stable under the Node 20 CI path;
- npm trusted publishing needs npm 11.5.1 or later.

## Plan

Split the release workflow into two jobs instead of switching runtimes inside a
single validation/publish job.

### Validate job

- Run on GitHub-hosted Ubuntu.
- Use Node 20 with pnpm cache, matching CI.
- Install dependencies with `pnpm install --frozen-lockfile`.
- Run lint, typecheck, Playwright Chromium install, and tests.
- Do not configure npm publish credentials in this job.

### Publish job

- Depend on the validate job.
- Run on GitHub-hosted Ubuntu.
- Use Node 24 and assert npm is at least `11.5.1`.
- Install dependencies and build the npm bundle.
- Verify the changelog entry and package contents.
- Run an explicit npm OIDC token-exchange preflight against
  `/-/npm/v1/oidc/token/exchange/package/<package>` before publishing.
- Publish with trusted publishing via `npm publish --access public`.
- Let trusted publishing generate provenance automatically; do not pass
  `--provenance`.
- Create the GitHub Release only after npm publish succeeds.

## Acceptance Criteria

- Playwright browser installation only runs in the Node 20 validation job.
- `npm publish` only runs in a job with npm `>=11.5.1`.
- The publish job fails before `npm publish` if trusted-publisher OIDC exchange
  is not configured correctly.
- The workflow no longer relies on bumping through throwaway versions after a
  trusted-publishing failure.
- `v0.5.0` remains the intended release version until npm confirms it is
  published.

## Follow-Up

If the OIDC preflight fails under npm 11, check the npm package's Trusted
Publisher settings for exact owner, repo, workflow filename, optional
environment, and allowed action values. Also verify that the generated npm
package `repository.url` still matches the GitHub repository identity expected
by npm.
