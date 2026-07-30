<!--
Thanks for contributing. Keep a PR to one concern — two unrelated fixes are two PRs.
See CONTRIBUTING.md for house style.
-->

## What this changes

<!-- What, and why. If it fixes an issue: "Fixes #123" -->

## How I verified it

<!--
"Tests pass" is the floor, not the answer. Say what you actually did:
- which tests you added, and what they'd catch
- for anything visual: a screenshot, or a render-test diff
- for anything in the engine: which render tests cover it
-->

- [ ] `npm run typecheck` clean
- [ ] `npm test` clean
- [ ] `npm run lint` clean

## What I did not do

<!--
Known gaps are fine — silent ones are not. Anything left unwired, untested,
or deliberately out of scope, say so here.
-->

## Checklist

- [ ] Comments explain *why*, not *what* — no comments that restate the next line
- [ ] No write-only UI: any control I added is wired end to end, read path included
- [ ] I did not duplicate an existing panel, editor or helper
- [ ] Anything that needs a backend is behind a capability predicate in
      `src/core/config/edition.ts`, and is *absent* (not broken) in the local edition
- [ ] If I re-blessed a golden image, I looked at the diff and explained above why
      the new pixels are correct
- [ ] I have the right to license this contribution under the **AGPL v3.0**
