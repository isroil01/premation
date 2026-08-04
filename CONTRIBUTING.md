# Contributing to Premation

Thanks for considering it. This is a large codebase with a few strong opinions;
this document is mostly about those, so your first PR doesn't get bounced on
something nobody told you.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Getting set up

```bash
npm install
```

```bash
npm run electron:dev:local
```

Use the `:local` scripts. They build the **local edition** — no accounts, no
backend, everything on disk. The default (`server`) edition expects a hosted
service that is not part of this repository, so it will stop at a sign-in screen.

Before you open a PR:

```bash
npm run typecheck && npm test && npm run lint
```

All three must be clean. Tests run in under a minute, so there is no excuse for
skipping them.

## Environment hazards

Two things about *where and how* you check this repo out have cost real hours.
Neither announces itself. Both produce corruption that is silent at the moment it
happens and hard to attribute afterwards, because the symptom surfaces a long way
from the cause — in someone else's commit, or in a test run that reported success.
Read these before you start, not after.

**Do not put the repo in OneDrive, Dropbox, or any syncing folder.** OneDrive
hides files from jest: thirteen test suites went invisible, and the run went
green because the failures were never collected. A green suite that did not run
looks exactly like a green suite that passed. It also breaks `git stash`. If you
suspect it, **check the suite count**, not the pass/fail line.

**Do not run two sessions in one checkout.** A working tree and its index are
shared, so `git add -A` in one session stages whatever the other has
half-finished — and commits it cleanly, under the wrong author, in an unrelated
commit. That is not hypothetical: it swept roughly a thousand lines of in-flight
timeline work into two commits here. It was caught before the push, but only
because someone read the diffstat.

Give each session its own checkout:

```bash
npm run worktree -- feat/my-thing
```

That makes a `git worktree` beside the repo — separate directory, separate index,
one shared `.git`. It needs its own `npm install` (npm trees are not relocatable,
and symlinking breaks the native modules) and its own dev-server port. The
install is the real cost and it is not small: **`node_modules` measures 760M**, so
each worktree is about a gigabyte on disk. Two or three at a time is fine; a
dozen left lying around is not. `npm run worktree -- --list` shows what you have
and `-- --remove <branch>` cleans one up.

Worth the gigabyte anyway. The alternative is a failure mode that depends on
everyone being careful every time, and it has already not worked once.

Where a shared checkout is unavoidable, **never `git add -A` in this repo** —
name every file in every commit, and read the diffstat before you push.

## What to work on

Good first issues are labelled [`good first
issue`](https://github.com/isroil01/motion-editor/labels/good%20first%20issue).
Beyond that, the areas that would help most:

- **Bring-your-own-key AI.** The assistant is fully built but disabled in the
  local edition because model calls route through a hosted gateway. Making it
  call a provider directly, with the key in the OS keychain, is the highest-value
  work available. See [ROADMAP.md](ROADMAP.md).
- **After Effects parity gaps** — anything AE does that this doesn't.
- **Documentation that has drifted from the code.** Always welcome.
- **Render-test coverage** for subsystems that only have unit tests.

If you are planning something large, open an issue first. A design disagreement is
much cheaper to resolve before the code exists.

## How the code is organised

- `src/core/` — document model, commands, export, AI, plugins. No React.
- `src/layout/` — panels. React.
- `src/components/` — reusable UI primitives.
- `src/stores/` — Zustand state.
- `packages/` — the engine, split into workspace packages (`@motion/scene`,
  `@motion/renderer`, `@motion/animation`, …). These are deliberately
  independent of the app shell.
- `electron/` — main process and IPC.

Import through the path aliases (`@core/…`, `@layout/…`, `@motion/scene`), not
long relative chains. The alias table lives in `tsconfig.json`.

## House style

**Comments explain *why*, never *what*.** The code already says what it does. A
comment earns its place by recording a decision, a constraint, or a bug that a
future reader would otherwise reintroduce. Look at any file in `src/core/` for
the register — several carry the "this used to do X, which was wrong because Y"
note that stops the mistake coming back. Please keep writing those.

Do not add comments that restate the next line.

**No dead code, no write-only UI.** A control that renders but doesn't affect
anything is worse than a missing feature, because it reads as working. If you add
a control, wire it end to end: the write path *and* the read/binding path. If you
find one that isn't wired, say so in the PR rather than leaving it.

**Don't duplicate a panel or an editor.** This codebase has had four separate
easing editors at once. If something similar exists, extend it.

**TypeScript.** Keep it strict. `any` needs a reason in a comment.

**Feature flags and editions.** New capability that depends on a backend goes
behind a capability predicate in `src/core/config/edition.ts` — read
`billingEnabled()`, never `isLocalEdition()`, so the call site says *why* it is
gated. Anything gated must be *absent* in the local edition, not present and
broken.

## Tests

- Unit tests live next to the code (`foo.ts` → `foo.test.ts`).
- Engine and rendering changes need a **render test** — a golden image — not just
  a unit test. `npm run render-tests`.
- Only re-bless a golden (`npm run render-tests:update`) when you have looked at
  the diff and can explain in the PR why the new pixels are correct. "The test
  was failing" is not a reason.
- A test that asserts on a mock, rather than on real behaviour, will be asked
  about in review.

## Commits and pull requests

- Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `docs:`, `refactor:`,
  `perf:`, `chore:`. A scope helps — `fix(render): …`.
- Write commit messages that say what changed and why, in the imperative.
- Keep a PR to one concern. Two unrelated fixes are two PRs.
- Describe how you verified it. "Tests pass" is the floor; screenshots or a
  render-test diff are better for anything visual.
- Say plainly what you did *not* do — known gaps in a PR are fine, silent ones
  are not.

## Reporting bugs

Use the issue templates. What actually helps:

- What you expected versus what happened.
- Exact steps, ideally from a fresh project.
- OS, GPU, and which render backend is active (shown in the viewport header:
  `WebGPU` or `WebGL2`).
- A `.motion` bundle or screen recording if it is at all visual.

Do not file security vulnerabilities as public issues — see
[SECURITY.md](SECURITY.md).

## Branches and releases

**Releases are cut from `main` only.** Nothing is released, tagged or published
from `dev` or a feature branch.

    feature branch  →  dev  →  main  →  tag  →  release

`.github/workflows/release.yml` enforces this: a tag that is not an ancestor of
`main` fails the pipeline before anything is built. That gate exists because a
tag pushed from `dev` produces a release indistinguishable from a real one — the
installer works, the update manifest is valid, and installed apps take the
update. Nothing downstream can catch it, so CI has to.

Two more things the release pipeline refuses:

- **A tag whose version disagrees with `package.json`.** electron-builder writes
  the package version into `latest.yml`, so a mismatch means every client either
  misses the update or reinstalls it forever.
- **An unsigned artifact.** If signing or notarization fails, the release fails.
  There is no unsigned fallback — see `RELEASING.md` § Code signing.

Platform targets are **Windows and macOS**. Linux is deliberately unsupported;
see RELEASING.md § Platform support before adding it back.

## Licensing your contribution

This project is licensed under the **GNU AGPL v3.0**. By submitting a
contribution you agree that it is licensed under the same terms. Don't paste in
code you don't have the right to relicense — including output you cannot
establish the provenance of.
