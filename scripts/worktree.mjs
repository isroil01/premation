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
 *   node scripts/worktree.mjs feat/my-thing          # branch off dev, deps copied
 *   node scripts/worktree.mjs feat/my-thing --from main
 *   node scripts/worktree.mjs feat/my-thing --install   # npm install instead
 *   node scripts/worktree.mjs --list
 *   node scripts/worktree.mjs --remove feat/my-thing
 *
 * The checkout lands beside the repo as `../motion-editor-<slug>`, so it is
 * never nested inside the main one (a nested worktree is picked up by jest,
 * eslint and vite as duplicate sources).
 *
 * ## Dependencies: COPIED, not installed
 *
 * `node_modules` is per-worktree — npm's tree is not relocatable and symlinking
 * it across checkouts breaks native modules (electron, canvas). It is 760M, so
 * budget ~1G per worktree; keep two or three, not a dozen.
 *
 * This script COPIES the tree from the main checkout rather than telling you to
 * run `npm install`, because the earlier advice to run `npm install` did not
 * work. `better-sqlite3` builds from source, and on a machine without MSVC or
 * python the build fails — and npm aborts the WHOLE install, leaving
 * `node_modules` empty. So the documented setup produced a worktree with no
 * dependencies at all and an error most people would read as "the repo is
 * broken". Two fixes, both applied:
 *
 *   1. `better-sqlite3` moved to `optionalDependencies` (package.json), which
 *      is what it always was in fact — `electron/localIndexDb.ts` loads it
 *      behind a guarded require and falls back to an in-memory index. npm now
 *      tolerates the build failing, so `npm install` completes either way.
 *   2. This script copies instead, which is also just faster: seconds against
 *      minutes, and it reuses the native modules the main tree already built.
 *
 * Pass `--install` to run `npm install` in the new worktree instead of copying.
 * Copying is the default and the recommendation; the install path exists for a
 * worktree that needs a genuinely independent tree (a dependency bump, say).
 *
 * `dist/`, `dist-electron/` and `packages/render-tests/.artifacts/` are NOT
 * copied, which is what you want: two sessions blessing goldens into one
 * artifacts directory is the same hazard in a different file.
 *
 * ## Removal
 *
 * `--remove` can fail on Windows with EPERM while a file under `node_modules`
 * is held open (an editor, a watcher, a dev server). That is git protecting
 * you, not a bug: close what is holding it and retry. If git has already
 * detached the worktree and only the directory is left, `git worktree prune`
 * tidies the admin data and the directory can be deleted by hand.
 */

import { execFileSync, spawnSync } from 'node:child_process';
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

/**
 * Copy the main checkout's `node_modules` into `dir`.
 *
 * Uses the platform's own bulk copier — `robocopy` on Windows, `cp -a`
 * elsewhere — because a JS recursive copy of ~90k small files is minutes
 * slower and gains nothing.
 *
 * robocopy's exit codes are NOT unix-like: 0-7 are success (1 = "files were
 * copied"), 8+ are failures. Treating nonzero as failure here would report a
 * perfectly good copy as broken, which is the trap the first version of this
 * fell into.
 */
function copyDeps(dir) {
  const src = path.join(repo, 'node_modules');
  if (!existsSync(src)) {
    console.log('  (main checkout has no node_modules to copy — run npm install there first)');
    return false;
  }
  const dest = path.join(dir, 'node_modules');
  process.stdout.write('  copying node_modules (~760M, this takes a moment)… ');
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('robocopy', [src, dest, '/E', '/MT:16', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'],
        { stdio: 'ignore' });
      if ((r.status ?? 16) >= 8) throw new Error(`robocopy exit ${r.status}`);
    } else {
      const r = spawnSync('cp', ['-a', src, dest], { stdio: 'ignore' });
      if (r.status !== 0) throw new Error(`cp exit ${r.status}`);
    }
  } catch (e) {
    console.log('failed.');
    console.log(`  ${e.message} — run \`npm install\` in the worktree instead.`);
    return false;
  }
  console.log('done.');
  return true;
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

  let ready = false;
  if (wantsInstall) {
    console.log('  running npm install…');
    const r = spawnSync('npm', ['install'], { cwd: dir, stdio: 'inherit', shell: true });
    ready = r.status === 0;
    if (!ready) console.log('  npm install failed — see above.');
  } else {
    ready = copyDeps(dir);
  }

  console.log('\nNext:');
  console.log(`  cd ${dir}`);
  if (!ready) console.log('  npm install          # dependencies are NOT in place yet');
  console.log('\nAnd give this session its own dev-server port — two worktrees on one');
  console.log('port is the same collision in a different resource.');
}

const argv = process.argv.slice(2);
const wantsInstall = argv.includes('--install');
if (argv.includes('--list')) {
  list();
} else if (argv.includes('--remove')) {
  const b = argv[argv.indexOf('--remove') + 1];
  if (!b) { console.error('--remove needs a branch name'); process.exit(1); }
  remove(b);
} else {
  const branch = argv.find((a) => !a.startsWith('--'));
  if (!branch) {
    console.error('usage: node scripts/worktree.mjs <branch> [--from dev] [--install] | --list | --remove <branch>');
    process.exit(1);
  }
  const fi = argv.indexOf('--from');
  create(branch, fi >= 0 ? argv[fi + 1] : 'dev');
}
