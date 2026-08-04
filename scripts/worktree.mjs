#!/usr/bin/env node
/**
 * Create an isolated checkout for a parallel working session.
 *
 * ## The hazard this removes
 *
 * Two sessions editing ONE checkout share a working tree and a staging area.
 * `git add -A` in either one stages whatever the other happens to have
 * half-finished, and it commits cleanly — the corruption is silent, and it is
 * attributed to the wrong author in the wrong commit. That happened here: an
 * agent's `git add -A` swept ~1,000 lines of another session's in-flight
 * timeline work into two unrelated commits. It was caught before the push, but
 * only because someone looked.
 *
 * `git worktree` gives each session its own directory and its own index while
 * sharing one `.git`, so the failure mode stops existing rather than being
 * guarded against.
 *
 * ## Usage
 *
 *   node scripts/worktree.mjs feat/my-thing          # branch off dev
 *   node scripts/worktree.mjs feat/my-thing --from main
 *   node scripts/worktree.mjs --list
 *   node scripts/worktree.mjs --remove feat/my-thing
 *
 * The checkout lands beside the repo as `../motion-editor-<slug>`, so it is
 * never nested inside the main one (a nested worktree is picked up by jest,
 * eslint and vite as duplicate sources).
 *
 * ## What is NOT shared, and why that is fine
 *
 * `node_modules` is per-worktree — npm's tree is not relocatable and symlinking
 * it across checkouts breaks native modules (electron, canvas). So a new
 * worktree needs its own `npm install`. That is the price, once per worktree,
 * and it buys back the entire class of cross-session corruption.
 *
 * `dist/`, `dist-electron/` and `packages/render-tests/.artifacts/` are also
 * per-worktree, which is what you want: two sessions blessing goldens into one
 * artifacts directory is the same hazard in a different file.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Run git in the repo, returning trimmed stdout. Throws on failure. */
function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', ...opts }).trim();
}

/** `feat/my-thing` → `feat-my-thing`, safe as a directory name. */
const slug = (branch) => branch.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

function list() {
  console.log(git(['worktree', 'list']));
}

function remove(branch) {
  const dir = path.resolve(repo, '..', `motion-editor-${slug(branch)}`);
  // Deliberately NOT `--force`. A worktree with uncommitted work is someone's
  // session; git refusing is the correct outcome, and the recovery is to look
  // at what is in there rather than to delete it harder.
  git(['worktree', 'remove', dir]);
  console.log(`removed ${dir}`);
  console.log('The branch itself is untouched — delete it separately if you meant to.');
}

function create(branch, from) {
  const dir = path.resolve(repo, '..', `motion-editor-${slug(branch)}`);
  if (existsSync(dir)) {
    console.error(`${dir} already exists. Use --remove first, or pick another name.`);
    process.exit(1);
  }
  // Fetch so `--from dev` means the real dev, not a stale local ref.
  try { git(['fetch', '--quiet', 'origin', from]); } catch { /* offline is fine */ }

  const exists = (() => {
    try { git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); return true; }
    catch { return false; }
  })();

  git(exists
    ? ['worktree', 'add', dir, branch]
    : ['worktree', 'add', '-b', branch, dir, from]);

  console.log(`\n  worktree  ${dir}`);
  console.log(`  branch    ${branch}${exists ? ' (existing)' : ` (new, off ${from})`}\n`);
  console.log('Next:');
  console.log(`  cd ${dir}`);
  console.log('  npm install          # per-worktree; npm trees are not relocatable');
  console.log('\nAnd give this session its own dev-server port — two worktrees on one');
  console.log('port is the same collision in a different resource.');
}

const argv = process.argv.slice(2);
if (argv.includes('--list')) {
  list();
} else if (argv.includes('--remove')) {
  const b = argv[argv.indexOf('--remove') + 1];
  if (!b) { console.error('--remove needs a branch name'); process.exit(1); }
  remove(b);
} else {
  const branch = argv.find((a) => !a.startsWith('--'));
  if (!branch) {
    console.error('usage: node scripts/worktree.mjs <branch> [--from dev] | --list | --remove <branch>');
    process.exit(1);
  }
  const fi = argv.indexOf('--from');
  create(branch, fi >= 0 ? argv[fi + 1] : 'dev');
}
