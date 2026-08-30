/**
 * `premation render`, against a real main process.
 *
 * Everything about the command line is unit-tested in `electron/cliArgs.test.ts`
 * — 60 cases, none of which can tell you that the process actually starts, finds
 * a GPU, opens a project, writes a file and exits with the right code. That
 * claim needs the whole thing running, which is what this suite is for.
 *
 * It spawns the compiled main directly rather than driving it through
 * Playwright's Electron helper: a CLI run has no window to attach to and exits
 * on its own, so what matters is stdout and the exit code.
 *
 * NEEDS A BUILD. The CLI loads the packaged renderer from `dist/`, so
 * `npm run build:local && npm run electron:compile` must have run. Absent, the
 * suite skips with that message rather than failing — a missing build is a
 * setup fact, not a defect in the thing under test.
 */

import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = join(__dirname, '..');
const MAIN = join(REPO, 'dist-electron', 'main.js');
const RENDERER = join(REPO, 'dist', 'index.html');

/** The Electron binary, as the npm package reports it. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ELECTRON: string = require('electron') as unknown as string;

let workDir: string;

test.beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'premation-cli-'));
});

test.afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

test.beforeEach(() => {
  test.skip(
    !existsSync(MAIN) || !existsSync(RENDERER),
    'Run `npm run build:local && npm run electron:compile` first — the CLI loads the packaged renderer.',
  );
});

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the CLI once and collect everything it said. */
function runCli(args: string[], timeoutMs = 120_000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(ELECTRON, [MAIN, ...args], {
      env: { ...process.env, MOTION_EDITION: 'local' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI did not exit within ${timeoutMs}ms: ${stdout}\n${stderr}`));
    }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/**
 * A minimal project: one composition, no layers, a distinctive background.
 *
 * A single-file `.json` rather than a `.motion` bundle deliberately — this
 * suite is about the CLI, and hand-writing a bundle would put the bundle
 * codec's correctness inside a test that is not about it.
 */
function writeFixture(name: string): string {
  const path = join(workDir, name);
  writeFileSync(
    path,
    JSON.stringify({
      version: '1.1.0',
      scene: { version: '1.0.0', nodes: [] },
      comps: {
        comp_cli: {
          id: 'comp_cli',
          name: 'CLI Fixture',
          width: 320,
          height: 180,
          fps: 24,
          durationSeconds: 0.25,
          background: '#2266ff',
          transparent: false,
          startFrame: 0,
        },
      },
    }),
  );
  return path;
}

test('--help answers without booting a window', async () => {
  const run = await runCli(['--help'], 30_000);
  expect(run.code).toBe(0);
  expect(run.stdout).toContain('premation render');
});

test('a malformed command line exits 2, before any GPU work', async () => {
  // 2, not 1: a pipeline should be able to tell "you typed it wrong" from
  // "the render failed".
  const run = await runCli(['render', 'nothing.motion', '--nope'], 30_000);
  expect(run.code).toBe(2);
});

test('a missing project exits 1 and names the path', async () => {
  const run = await runCli(['render', join(workDir, 'absent.motion')], 60_000);
  expect(run.code).toBe(1);
  expect(`${run.stdout}${run.stderr}`).toContain('absent.motion');
});

test('comps lists what is in a project', async () => {
  const project = writeFixture('list.json');
  const run = await runCli(['comps', project]);

  expect(run.code).toBe(0);
  expect(run.stdout).toContain('CLI Fixture');
  expect(run.stdout).toContain('320×180');
});

test('render writes a real file and reports it', async () => {
  const project = writeFixture('still.json');
  const out = join(workDir, 'frame.png');
  const run = await runCli(['render', project, '--format', 'png', '--out', out]);

  expect(run.code).toBe(0);
  expect(existsSync(out)).toBe(true);
  // A PNG, not an empty file or an error page written under the right name.
  expect(readFileSync(out).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(run.stdout).toContain('Wrote');
});

test('--json reports a machine-readable result', async () => {
  const project = writeFixture('json.json');
  const out = join(workDir, 'json-frame.png');
  const run = await runCli(['render', project, '--format', 'png', '--out', out, '--json', '--quiet']);

  expect(run.code).toBe(0);
  const done = run.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as { event?: string; outPath?: string })
    .find((event) => event.event === 'done');

  expect(done).toBeDefined();
  // Separators normalised on both sides: the claim is "it reports the file it
  // wrote", and the path keeps whatever separator the invocation used — a
  // backslash from a Windows shell, a forward slash from a POSIX-style one.
  const same = (value: string): string => value.split('\\').join('/');
  expect(done?.outPath && same(done.outPath)).toBe(same(out));
});

test('--range renders exactly the frames asked for', async () => {
  // The inclusive/exclusive boundary is the one place a CLI can be quietly
  // wrong: nobody counts the frames in a delivered file.
  const project = writeFixture('range.json');
  const out = join(workDir, 'range.png');
  const run = await runCli(['render', project, '--format', 'png', '--out', out, '--range', '2-2', '--json']);

  expect(run.code).toBe(0);
  const done = run.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as { event?: string; frames?: number })
    .find((e) => e.event === 'done');
  expect(done?.frames).toBe(1);
});
