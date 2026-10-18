# AGENTS.md

Thin provider for OMP/Pi: model list + local relay proxy + log. Host AI owns thinking/normalization — this repo only routes requests.

## Commands

- Typecheck: `npm run typecheck` (`tsc --noEmit`, must be clean)
- Tests: `npm test` (Node test runner, single concurrency)
- One file: `node --experimental-strip-types --import ./test/setup.mjs --test test/<name>.test.ts`
- Smoke: `npm run smoke` (loads `extensions/index.ts`)
- Docs site: `npm run docs:dev` / `npm run docs:build`
- Release packaging: `npm pack --dry-run`

Requires Node >= 22.19.0, ESM (`"type": "module"`).

## Layout

- `src/` — extension source (`proxy.ts` local daemon on port 28180, `relay*.ts` pool, `catalog.ts`/`models.ts` model list, `tool-translation.ts` wire-API converters, `opencode-fingerprint.ts` upstream fingerprint, `commands.ts` `/freeflow` handlers, `index.ts` provider registration)
- `test/` — `*.test.ts` via `node:test` + `node:assert/strict`, isolated per file through `test/setup.mjs`
- `extensions/index.ts` — host entrypoint; `docs/` — VitePress site
- `reference/` — read-only upstream checkouts for grounding (never import from it, never commit changes inside it)

## Conventions

- Indentation: single space in `src/`, tabs in `test/` (match the file you edit)
- Narrowing: inline `typeof x === "object" && x !== null` + `as Record<string, unknown>` casts (see `relay-state.ts`); no shared guard helpers, no new validation deps
- Proxy preserves caller tools verbatim; translation only reshapes wire format (`src/tool-translation.ts`)
- Reuse existing patterns; one convention per concern — a second parallel implementation is a bug
- Before changing an exported symbol, find all callsites first

## Testing rules

- Verification order: typecheck → full suite → smoke. The suite must be green before any done-claim.
- New behavior needs a test that fails without the fix; keep tests to observable contracts (no source-text or wiring assertions)
- Tests touching relay state must isolate BOTH the state file and its `.bak` (see `withIsolatedRelayFiles` in `test/relay-state-lifecycle.test.ts`); never touch real user state on disk
- Live upstream checks are opt-in scripts, never part of `npm test`
- CI is change-gated (`.github/workflows/ci.yml`): `code` changes run the test matrix (ubuntu lts + 22.19, windows lts), `docs/` changes build the docs site, shipped-file changes run the tarball whitelist. Keep jobs path-scoped — a job without a gate burns a runner on every push

## Versioning and releases

- Changesets workflow (`.changeset/`): `major` = breaking, `minor` = new compatible capability, `patch` = fix. Changelog headings follow suit (`### Minor Changes`).
- `npm publish` is always run by the maintainer in their own terminal (2FA). Agents never publish, never push/tag before the maintainer confirms the publish landed.
- The Release workflow re-verifies the published tarball against the tagged tree (`scripts/verify-published-tarball.mjs`); a tag whose content does not match what npm serves fails the run.

## Repo metadata (About panel)

The GitHub About description mirrors README's tagline — same facts, same numbers. Any README change to the headline (model count, tagline, relay story) MUST update the About in the same change:

```
gh repo edit --description "<new description>"
```

Topics in the About panel follow the README feature list: add one when a headline feature lands, drop one when it is removed. The About must never advertise an older model count than README and `src/models.ts`.

## Public-repo hygiene (this repo is public)

- No secrets, tokens, private hosts, LAN IPs, emails, or internal topology in tracked files or history
- Commits: `<type>(<scope>): imperative summary`, types `feat|fix|refactor|perf|test|docs|chore|ci|build|style|revert`
- Release notes, changelog, and comments: user-facing language only — what changed from the user's perspective, never internal symbol/file names or workflow jargon
