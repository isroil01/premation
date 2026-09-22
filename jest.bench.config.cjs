/**
 * `npm run bench` — the timed benchmark suites (`*.bench.test.ts`).
 *
 * Same transforms, aliases and setup as the unit suite (jest.config.cjs), but
 * only the root project, only bench files, and never in the default `jest`
 * run, which ignores them. Results print to the console and are written as
 * JSON under `.artifacts/bench/` (gitignored) so a later change can be
 * compared against an earlier run on the same machine.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const base = { ...require('./jest.config.cjs') };
// The root project only — the workspace packages hold no benches.
delete base.projects;

// The effect-bake sweep times ~170 effects at up to 2.5 s each — about 15
// minutes on a laptop, longer on a CI runner. It is a ranking tool, not one of
// the T0 ratchet metrics (docs/NATIVE_CORE_PLAN.md §4), so the default
// `npm run bench` skips it; `npm run bench:all` (BENCH_FULL=1) includes it.
const full = process.env.BENCH_FULL === '1';

module.exports = {
  ...base,
  testMatch: ['**/?(*.)+(bench.test).[jt]s?(x)'],
  testPathIgnorePatterns: [
    ...base.testPathIgnorePatterns.filter((p) => !p.includes('bench')),
    ...(full ? [] : ['effectBake\\.bench\\.test\\.ts$']),
  ],
  // Benchmarks are slow by nature; one scenario can take tens of seconds
  // under jsdom + ts-jest.
  testTimeout: 300000,
};
