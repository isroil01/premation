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

## Licensing your contribution

This project is licensed under the **GNU AGPL v3.0**. By submitting a
contribution you agree that it is licensed under the same terms. Don't paste in
code you don't have the right to relicense — including output you cannot
establish the provenance of.
