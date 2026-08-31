/**
 * Golden-frame render-tests runner (Phase 5: unified GPU engine).
 *
 * Pipeline:
 *   1. Build the harness bundle (Vite) that imports the app's real render path.
 *   2. Launch offscreen Electron (SwiftShader) — the pixel factory — which
 *      renders frames using the unified GPU engine (WebGL2).
 *   3. Compare / bless:
 *        - Compare the actual GPU (WebGL2) output against committed reference PNGs.
 *        - Scenes marked gpuParity: 'expect-pass' (or oracle: 'gpu') MUST match.
 *        - Scenes marked gpuParity: 'known-divergent' are allowed to differ.
 *
 * Usage:
 *   node scripts/run.mjs                 # render + compare (the gate)
 *   node scripts/run.mjs --update        # re-bless ALL references from the GPU engine
 *   node scripts/run.mjs --update solid-fill linear-gradient-fill   # bless some
 *   node scripts/run.mjs --scene solid-fill                          # one scene
 */

import { build } from 'vite';
import electronPath from 'electron';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareAgainstReference, readPng, compareFrames } from './comparator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(__dirname, '..');
const HARNESS_CONFIG = path.join(PKG, 'vite.harness.config.ts');
const HARNESS_HTML = path.join(PKG, 'dist-harness', 'harness', 'index.html');
const REFERENCES = path.join(PKG, 'references');
const ARTIFACTS = path.join(PKG, '.artifacts');
const ACTUAL = path.join(ARTIFACTS, 'actual');
const MANIFEST_OUT = path.join(ARTIFACTS, 'manifest.json');

/**
 * The backend the golden PNGs are blessed from and diffed against.
 *
 * ## Why this is WebGL2 when WebGPU is the product's backend
 *
 * NOT the reason that used to be written here. That reason — "WebGPU diverges
 * on 80 of 93 scenes, whole layers missing" — was never a fact about WebGPU.
 * The harness had no WebGPU adapter at all: `--use-angle=swiftshader`
 * suppresses Dawn, `requestAdapter()` returned null, MotionRendererBackend
 * stepped silently down to WebGL2, and the harness filed the result under
 * `actual/webgpu/` because `kind` reported the tier it ASKED for. Every WebGPU
 * parity figure this suite ever printed was measured on non-WebGPU pixels.
 * Given a real adapter (electron/main.cjs) the same suite reports 122/164 where
 * it used to report 18/164, with no renderer change.
 *
 * The actual blocker is narrower and is about DETERMINISM, not correctness:
 * golden-PNG diffing needs a software rasterizer so any machine reproduces the
 * bytes, and there is no software WebGPU here. Dawn's Vulkan-SwiftShader path
 * yields an adapter and a device, then kills the render process on first submit
 * ("Instance dropped in onSubmittedWorkDone") on Electron 32.3.3. Blessing from
 * the real adapter instead would pin every reference to one GPU.
 *
 * So the split is deliberate:
 *
 *   golden PIXELS   WebGL2 / ANGLE-SwiftShader — portable and byte-deterministic
 *   SEMANTICS       WebGPU — gated by scripts/verify-alpha.mjs, which asserts
 *                   SHAPES (linear vs quadratic in alpha) rather than bytes and
 *                   is therefore immune to the driver differences that stop the
 *                   pixel gate from moving
 *
 * That gives the product's real backend a gate that can fail, which is what was
 * missing, without pretending a hardware-blessed PNG is portable. Move the
 * pixel gate here to 'webgpu' when a software adapter works; the WebGL2 run
 * stays as the fallback's smoke check either way.
 */
const GATE_BACKEND = process.env.HARNESS_GATE_BACKEND || 'webgl2';

/** The backend whose SEMANTICS gate (verify-alpha) must pass. The product's. */
const SEMANTIC_GATE_BACKEND = 'webgpu';

/** Rendered every run. The gate backend is forced in regardless. */
const DEFAULT_BACKENDS = ['webgl2', 'webgpu'];

/** Where a backend's ratchet baseline lives. */
const RT_ROOT = PKG;

/**
 * How far a secondary backend may differ from the committed references on a
 * frame nobody has recorded a ceiling for.
 *
 * Not the per-scene reference tolerance (0.5%), which judges OUR renderer
 * against pixels we blessed. This judges one hardware rasterizer against
 * another, where edge antialiasing genuinely differs: the extrusion scenes
 * measure 0.16-0.27% of pixels between the two backends, all of it on edges.
 * 1% clears that with room and still catches anything structural.
 */
const BACKEND_TOLERANCE = 0.01;

/** Wobble allowed above a recorded ceiling before it counts as a regression. */
const BACKEND_RATCHET_SLACK = 0.002;

/** How far under its ceiling a frame must fall before the run suggests
 *  tightening it. Larger than the slack, so a frame cannot be reported as both. */
const BACKEND_RATCHET_TIGHTEN = 0.01;

// ── args ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const updateMode = argv.includes('--update');
const sceneFilterFlag = argv.indexOf('--scene');
const sceneOnly = sceneFilterFlag >= 0 ? argv[sceneFilterFlag + 1] : null;
const updateTargets = updateMode
  ? argv.slice(argv.indexOf('--update') + 1).filter((a) => !a.startsWith('--'))
  : [];
/**
 * Rewrite the secondary backend's ratchet baseline from this run.
 *
 * Separate from `--update` on purpose: that blesses REFERENCE pixels, and if
 * one flag did both then re-blessing a reference would silently also forgive
 * every backend regression in the same run.
 */
const updateBackendBaselineMode = argv.includes('--update-backend-baseline');

const RESET = '\x1b[0m';
const c = (code, s) => `\x1b[${code}m${s}${RESET}`;
const green = (s) => c(32, s);
const red = (s) => c(31, s);
const yellow = (s) => c(33, s);
const dim = (s) => c(2, s);

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

async function buildHarness() {
  process.stdout.write(dim('· building harness bundle (vite)…\n'));
  await build({ configFile: HARNESS_CONFIG, logLevel: 'warn' });
}

function runElectron(backends) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      HARNESS_OUT: ACTUAL,
      HARNESS_MANIFEST_OUT: MANIFEST_OUT,
      HARNESS_BACKENDS: backends.join(','),
      HARNESS_HTML: HARNESS_HTML,
      // 180000 was one scene away from flaking, and not on the fast backend.
      // The two backends are wildly asymmetric on SwiftShader: measured on this
      // machine the webgpu pass renders 349 pairs in 45-52s, while webgl2 takes
      // 137-175s for the same set (`ext-dof-wall` alone is ~3s). At 175.3s
      // against a 180s ceiling the suite had five seconds of headroom, so the
      // very next scene anyone added timed out the run and reported "no pixels
      // produced" — a failure that reads like a renderer fault and is not one.
      // The ceiling exists to stop a WEDGED renderer hanging CI forever, and it
      // does that job just as well an order of magnitude higher.
      HARNESS_TIMEOUT_MS: process.env.HARNESS_TIMEOUT_MS || '900000',
    };
    // `--no-sandbox` is passed on the ACTUAL command line, not only via
    // app.commandLine.appendSwitch in main.cjs, because Chromium reads the
    // sandbox configuration during early browser startup — a switch appended
    // from the main script is not guaranteed to be seen in time. Belt and
    // braces: main.cjs sets it too, and either alone is enough on most builds.
    //
    // Without it, CI aborts before producing a single pixel — a Linux runner
    // installs node_modules as a non-root user, so chrome-sandbox can never be
    // the root-owned mode-4755 binary the SUID helper insists on. See the long
    // note in electron/main.cjs for why this is unconditional rather than
    // CI-only.
    const child = spawn(electronPath, ['--no-sandbox', path.join(PKG, 'electron', 'main.cjs')], {
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/**
 * Render each backend in its OWN Electron process.
 *
 * Never batch them into one run. WebGPU's Vulkan/SwiftShader adapter and the
 * ANGLE/SwiftShader GL context poison each other inside a single page: measured
 * on this suite, `HARNESS_BACKENDS=webgpu,webgl2` reported 52 failures where
 * webgl2 alone reported 3, with scenes like paint-strokes and
 * hires-4x-stroke-text flipping pass↔fail purely on whether WebGPU had run
 * first. Process isolation is what makes a per-backend comparison mean anything.
 */
async function renderBackendsIsolated(backends) {
  const skipped = [];
  for (const backend of backends) {
    process.stdout.write(dim(`· rendering [${backend}] in its own offscreen Electron…\n`));
    const code = await runElectron([backend]);
    if (code === 0) continue;

    // A NON-GATING backend that cannot run on this machine is a skip, not a
    // failure.
    //
    // `GATE_BACKEND` (webgl2 over ANGLE/SwiftShader) is the oracle: it needs no
    // GPU, it is what references are blessed from, and if it fails the suite is
    // meaningless — so that stays fatal. WebGPU is explicitly "measured, NOT
    // gated" (see the parity dashboard below), and on a box with no WebGPU
    // adapter `renderEntry`'s resolvedKind assertion fires by design, to stop
    // WebGL2 pixels being filed under `webgpu/`. That assertion is correct;
    // treating it as a build failure was not — it made the whole suite
    // unrunnable anywhere without a real adapter, which is every hosted CI
    // runner. The downstream semantic gate already degrades the same way
    // ("gate SKIPPED, webgpu rendered no frames on this machine").
    //
    // The cost, stated: on a machine with no adapter this also downgrades a
    // genuine WebGPU regression to a warning. The gate that protects output is
    // GATE_BACKEND, and it is unaffected; a WebGPU regression still fails
    // loudly on any developer machine that HAS an adapter, which is where the
    // WebGPU path is actually developed.
    if (backend === GATE_BACKEND) return { ok: false, backend, code };
    /*
      In CI, a missing adapter is a FAILURE, not a skip.

      The reasoning above is right about developer machines and wrong about the
      place it matters most. WebGPU is the product's primary backend; a hosted
      runner that quietly renders none of it turns every WebGPU gate below --
      the alpha semantics, the 3D styles, the plugin effects, the extrusion
      reach, and now the pixel ratchet -- into a no-op that reports success.
      "Nobody has a WebGPU adapter in CI" is a statement about how the runner is
      provisioned, and the honest response is to fail until it is, rather than
      to keep printing green.

      Overridable both ways so it can be set by policy rather than by accident:
      HARNESS_REQUIRE_WEBGPU=1 demands it anywhere, =0 waives it in CI.
    */
    const requireSecondary = process.env.HARNESS_REQUIRE_WEBGPU !== undefined
      ? process.env.HARNESS_REQUIRE_WEBGPU !== '0'
      : !!process.env.CI;
    if (requireSecondary) {
      process.stdout.write(
        red(
          `  x [${backend}] exited ${code} and this run REQUIRES it. `
          + `No adapter means every ${backend} gate silently passes. `
          + `Provision one, or set HARNESS_REQUIRE_WEBGPU=0 to state that you accept the hole.
`,
        ),
      );
      return { ok: false, backend, code };
    }
    process.stdout.write(
      yellow(
        `  ! [${backend}] exited ${code} — SKIPPED, not gated. ` +
          `Usually means this machine has no ${backend} adapter; ` +
          `the ${GATE_BACKEND} oracle still gates.\n`,
      ),
    );
    skipped.push(backend);
  }
  return { ok: true, skipped };
}

async function loadManifest() {
  const raw = await fs.readFile(MANIFEST_OUT, 'utf8');
  let scenes = JSON.parse(raw);
  if (sceneOnly) {
    // A scene's fidelity twin comes with it — filtering it out would report the
    // oracle as "missing" rather than running the gate the flag exists to run.
    const picked = scenes.filter((s) => s.id === sceneOnly);
    const twins = new Set(picked.map((s) => s.fidelityTwin).filter(Boolean));
    scenes = scenes.filter((s) => s.id === sceneOnly || twins.has(s.id));
  }
  return scenes;
}

async function bless(scenes) {
  // Oracle-only scenes are never blessed — they ARE the oracle.
  const blessable = scenes.filter((s) => !s.fidelityOnly);
  const targets =
    updateTargets.length > 0 ? blessable.filter((s) => updateTargets.includes(s.id)) : blessable;
  for (const s of targets) {
    const oracleBackend = GATE_BACKEND;
    for (const frame of s.frames) {
      const from = path.join(ACTUAL, oracleBackend, s.id, `${frame}.png`);
      const toDir = path.join(REFERENCES, s.id);
      await fs.mkdir(toDir, { recursive: true });
      await fs.copyFile(from, path.join(toDir, `${frame}.png`));
    }
    process.stdout.write(green(`  blessed `) + `${s.id} (${s.frames.length} frame(s), oracle=${oracleBackend})\n`);
  }
  process.stdout.write(
    '\n' +
      yellow('⚠  References were re-blessed from the GPU (WebGL2) engine.\n') +
      yellow('   A HUMAN must eyeball references/<scene>/*.png before committing.\n'),
  );
}

/**
 * PIXEL parity gate for the secondary backend — a RATCHET, not a pass/fail line.
 *
 * ── What was here, and why measuring was not enough ─────────────────────────
 *
 * This printed a number and never failed. 250 scenes rendered on WebGPU — the
 * PRIMARY backend of the shipped product — and not one pixel of it was gated,
 * on the reasoning that byte equality against PNGs blessed on a different
 * rasterizer is not something a hardware adapter can be expected to reproduce.
 * That reasoning is sound and is why this is a ratchet rather than a threshold.
 *
 * What it did not cover is REGRESSION. While the number was merely printed,
 * `effect-compound-blur` sat at 87.8% divergence because its WGSL failed to
 * compile — "textureSample must only be called from uniform control flow" —
 * so Compound Blur drew NOTHING on the primary backend. The harness printed
 * the validation error every run, and the number went in the dashboard beside
 * scenes that differ by antialiasing.
 *
 * ── The ratchet ────────────────────────────────────────────────────────────
 *
 * A frame with no baseline entry must be within {@link BACKEND_TOLERANCE}. A
 * frame WITH one must not exceed its recorded ceiling. Either way a change that
 * makes WebGPU worse fails the build, which is the property that was missing.
 *
 * The baseline is a list of debts, not of blessings — every entry is a
 * WebGPU-vs-WebGL2 disagreement nobody has diagnosed yet. It is deliberately
 * NOT the `divergence` mechanism used for known Canvas2D gaps, which requires a
 * stated mechanism per scene: demanding 42 diagnoses before any gate could
 * exist is how the suite ended up with no gate at all. Entries are meant to be
 * removed, and the report names the ones that have improved enough to tighten.
 */
async function gateSecondaryBackend(scenes, backend) {
  let compared = 0;
  let matched = 0;
  let missing = 0;
  const worst = [];
  for (const s of scenes) {
    if (s.fidelityOnly) continue; // no reference by design
    for (const frame of s.frames) {
      const actual = await readPngSafe(path.join(ACTUAL, backend, s.id, `${frame}.png`));
      const reference = await readPngSafe(path.join(REFERENCES, s.id, `${frame}.png`));
      if (!actual || !reference) {
        missing++;
        continue;
      }
      compared++;
      const { pass, ratio } = compareFrames(actual, reference, { tolerance: s.tolerance });
      if (pass) matched++;
      else worst.push({ id: `${s.id}#${frame}`, ratio });
    }
  }
  if (compared === 0 && missing === 0) return 0;
  worst.sort((a, b) => b.ratio - a.ratio);

  const baseline = await readBackendBaseline(backend);
  const regressed = [];
  const unlisted = [];
  const improved = [];
  for (const w of worst) {
    const ceiling = baseline[w.id];
    if (ceiling === undefined) {
      if (w.ratio > BACKEND_TOLERANCE) unlisted.push(w);
      continue;
    }
    // A little slack over the recorded ceiling: these are hardware rasterizers
    // and a frame can wobble in its last pixel row between driver versions.
    // Large enough to absorb that, far too small to hide a real change.
    if (w.ratio > ceiling + BACKEND_RATCHET_SLACK) regressed.push({ ...w, ceiling });
    else if (w.ratio < ceiling - BACKEND_RATCHET_TIGHTEN) improved.push({ ...w, ceiling });
  }

  process.stdout.write('\n' + dim(`  ${backend} pixel parity (RATCHET - a frame may not get worse):\n`));
  process.stdout.write(dim(`  - ${matched}/${compared} frame(s) match the committed reference`));
  process.stdout.write(missing > 0 ? dim(` - ${missing} not rendered\n`) : '\n');
  process.stdout.write(dim(`  - ${Object.keys(baseline).length} known divergence(s) held at their ceiling\n`));

  for (const w of regressed) {
    process.stdout.write(red(`  x ${w.id} ${pct(w.ratio)} - WORSE than its ${pct(w.ceiling)} ceiling\n`));
  }
  for (const w of unlisted) {
    process.stdout.write(red(`  x ${w.id} ${pct(w.ratio)} - newly divergent, over the ${pct(BACKEND_TOLERANCE)} tolerance\n`));
  }
  // Printed, never failed. An improvement left unrecorded quietly restores the
  // headroom the ratchet exists to remove.
  for (const w of improved.slice(0, 5)) {
    process.stdout.write(green(`  v ${w.id} ${pct(w.ratio)} - better than its ${pct(w.ceiling)} ceiling; tighten it\n`));
  }
  if (improved.length > 5) process.stdout.write(green(`  v ...and ${improved.length - 5} more improved\n`));

  const failures = regressed.length + unlisted.length;
  if (failures > 0) {
    process.stdout.write(dim(`    re-run with --update-backend-baseline once each is understood\n`));
  }
  return failures;
}

/**
 * Recorded ceilings for `backend`, or `{}` when none has been committed.
 *
 * Absent file = every frame is judged against BACKEND_TOLERANCE alone, which is
 * the correct behaviour for a backend nobody has triaged: strict, and noisy
 * until someone records what they accept.
 */
async function readBackendBaseline(backend) {
  try {
    const raw = await fs.readFile(backendBaselinePath(backend), 'utf8');
    return JSON.parse(raw).frames ?? {};
  } catch {
    return {};
  }
}

function backendBaselinePath(backend) {
  return path.join(RT_ROOT, `${backend}-baseline.json`);
}

/**
 * Rewrite the baseline from what just rendered.
 *
 * Deliberately a separate flag from `--update`, which blesses REFERENCE pixels.
 * Conflating the two would mean any reference re-bless silently also forgave
 * every backend regression in the same run.
 */
async function updateBackendBaseline(scenes, backend) {
  const frames = {};
  for (const s of scenes) {
    if (s.fidelityOnly) continue;
    for (const frame of s.frames) {
      const actual = await readPngSafe(path.join(ACTUAL, backend, s.id, `${frame}.png`));
      const reference = await readPngSafe(path.join(REFERENCES, s.id, `${frame}.png`));
      if (!actual || !reference) continue;
      const { ratio } = compareFrames(actual, reference, { tolerance: s.tolerance });
      if (ratio > BACKEND_TOLERANCE) frames[`${s.id}#${frame}`] = Number(ratio.toFixed(5));
    }
  }
  const body = {
    _comment:
      'Ceilings for how far this backend may differ from the committed (WebGL2-blessed) references. '
      + 'A LIST OF DEBTS, not of blessings: every entry is an undiagnosed WebGPU-vs-WebGL2 disagreement. '
      + 'The gate fails when a frame exceeds its ceiling, or when an unlisted frame exceeds the tolerance. '
      + 'Entries are meant to be removed; run.mjs names the ones that have improved enough to tighten.',
    tolerance: BACKEND_TOLERANCE,
    frames,
  };
  await fs.writeFile(backendBaselinePath(backend), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  process.stdout.write(green(`  baseline written: ${Object.keys(frames).length} divergence(s) for ${backend}\n`));
}

/**
 * Fidelity gate: a scene against its `fidelityTwin`, not against a blessed PNG.
 *
 * References are blessed from our own output, so they can only ever prove "the
 * pixels did not change since someone approved them". A twin renders the same
 * content by an INDEPENDENT route — for SVG layers, the untouched source file
 * beside the sanitized, id-scoped copy we store — so the diff proves the
 * pipeline itself is lossless, on the first run, with nothing to eyeball.
 *
 * Gated at 1% by default (§10). A per-scene `fidelityTolerance` is an explicit
 * statement that we change that file's pixels on purpose, so its
 * `fidelityException` is printed every run rather than buried in a config.
 */
async function gateFidelityTwins(scenes) {
  const byId = new Map(scenes.map((s) => [s.id, s]));
  const pairs = scenes.filter((s) => s.fidelityTwin);
  if (pairs.length === 0) return { fidelityFail: 0, fidelityChecked: 0 };

  let fidelityFail = 0;
  let fidelityChecked = 0;
  const failures = [];
  const exceptions = [];

  for (const s of pairs) {
    const twin = byId.get(s.fidelityTwin);
    if (!twin) {
      failures.push({ id: s.id, ratio: 1, reason: `twin "${s.fidelityTwin}" not in manifest` });
      fidelityFail++;
      continue;
    }
    for (const frame of s.frames) {
      const actual = await readPngSafe(path.join(ACTUAL, GATE_BACKEND, s.id, `${frame}.png`));
      const oracle = await readPngSafe(path.join(ACTUAL, GATE_BACKEND, twin.id, `${frame}.png`));
      if (!actual || !oracle) {
        failures.push({ id: `${s.id}#${frame}`, ratio: 1, reason: 'frame not rendered' });
        fidelityFail++;
        continue;
      }
      fidelityChecked++;
      // A twin comparison passes trivially if BOTH sides drew nothing — a
      // corpus file that silently fails to render would look like perfect
      // fidelity. Require the oracle to actually contain content.
      if (isUniform(oracle)) {
        fidelityFail++;
        failures.push({ id: `${s.id}#${frame}`, ratio: 0, reason: 'oracle frame is blank — the corpus file rendered nothing' });
        continue;
      }
      const tolerance = s.fidelityTolerance ?? 0.01;
      const { pass, ratio } = compareFrames(actual, oracle, { tolerance });
      if (!pass) {
        fidelityFail++;
        failures.push({ id: `${s.id}#${frame}`, ratio, reason: `differs from untouched source` });
      } else if (s.fidelityException) {
        exceptions.push({ id: s.id, tolerance, why: s.fidelityException });
      }
    }
  }

  process.stdout.write('\n' + dim(`  fidelity gate (stored document vs untouched source):\n`));
  process.stdout.write(
    (fidelityFail === 0 ? green : red)(`  · ${fidelityChecked - failures.length}/${fidelityChecked} scene(s) render identically to their source\n`),
  );
  for (const f of failures) {
    process.stdout.write(red(`  · ${f.id} ${pct(f.ratio)} — ${f.reason}\n`));
  }
  for (const e of exceptions) {
    process.stdout.write(dim(`  · ${e.id} passes at a raised ${pct(e.tolerance)}: ${e.why}\n`));
  }
  return { fidelityFail, fidelityChecked };
}

/**
 * Animation gate: a scene's own frames must DIFFER from one another.
 *
 * Every other gate here asks "do these pixels match something?". This one asks
 * the opposite, and it is the assertion that was missing across the whole
 * keyframe system: a scene declares two frames with two clearly different
 * keyframed values, and the render must actually change between them.
 *
 * Why it has to be pixels. "Keyframes on style properties do not animate" was
 * reported against a chain in which the stopwatch wrote the right prop path, the
 * sampler read it, the emit gate honoured it and the renderable carried the
 * sampled value — every intermediate check passes in every version of that bug,
 * including the versions where the compositor serves a cached texture from the
 * first frame forever. Only the frame-to-frame diff separates "the value was
 * computed" from "the value was drawn".
 *
 * Compared against the scene's own output, so these scenes need no blessed
 * reference PNG (`fidelityOnly`) and nothing to eyeball.
 */
async function gateAnimatedFrames(scenes) {
  const animated = scenes.filter((s) => s.animates);
  if (animated.length === 0) return { animFail: 0, animChecked: 0 };

  let animFail = 0;
  let animChecked = 0;
  const failures = [];

  for (const s of animated) {
    if (s.frames.length < 2) {
      animFail++;
      failures.push({ id: s.id, reason: 'declares `animates` but renders a single frame' });
      continue;
    }
    const minChange = s.animatesMinChange ?? 0.002;
    for (let i = 1; i < s.frames.length; i++) {
      const label = `${s.id}#${s.frames[i - 1]}→${s.frames[i]}`;
      const a = await readPngSafe(path.join(ACTUAL, GATE_BACKEND, s.id, `${s.frames[i - 1]}.png`));
      const b = await readPngSafe(path.join(ACTUAL, GATE_BACKEND, s.id, `${s.frames[i]}.png`));
      if (!a || !b) {
        animFail++;
        failures.push({ id: label, reason: 'frame not rendered' });
        continue;
      }
      // Two BLANK frames differ from nothing, and would sail through a naive
      // "not identical" test the moment the subject stopped rendering at all.
      if (isUniform(a) && isUniform(b)) {
        animFail++;
        failures.push({ id: label, reason: 'both frames are blank — the subject rendered nothing' });
        continue;
      }
      animChecked++;
      // `compareFrames` reports the fraction of pixels that DIFFER; here that
      // fraction is the thing required to be large, not small.
      const { ratio } = compareFrames(a, b, { tolerance: 0 });
      if (ratio < minChange) {
        animFail++;
        failures.push({
          id: label,
          reason: `only ${pct(ratio)} of pixels changed (need ${pct(minChange)}) — the keyframes did not reach the render`,
        });
      }
    }
  }

  process.stdout.write('\n' + dim('  animation gate (a keyframe must change the pixels):\n'));
  process.stdout.write(
    (animFail === 0 ? green : red)(`  · ${animChecked - failures.length}/${animChecked} frame-pair(s) actually animate\n`),
  );
  for (const f of failures) process.stdout.write(red(`  · ${f.id} — ${f.reason}\n`));
  return { animFail, animChecked };
}

/**
 * The semantics gate for the PRODUCT's backend.
 *
 * Runs verify-alpha against the WebGPU actuals. This is the gate that can fail
 * on WebGPU, and the reason the pixel gate staying on WebGL2 is a determinism
 * decision rather than a coverage hole: the alpha invariant and the footage
 * interpretation are asserted as SHAPES (linear vs quadratic in alpha), which
 * hold on any conforming driver, so they gate the backend users actually run.
 *
 * Skipped, loudly, if WebGPU produced no frames — a machine with no adapter
 * must not silently lose the gate, but must not fail the build for it either.
 */
async function gateSemantics(scenes, backends, script, probeScene, label) {
  if (!backends.includes(SEMANTIC_GATE_BACKEND)) return 0;
  const probe = await readPngSafe(path.join(ACTUAL, SEMANTIC_GATE_BACKEND, probeScene, '0.png'));
  if (!probe) {
    process.stdout.write(
      '\n' + yellow(`  ${label} — gate SKIPPED, ${SEMANTIC_GATE_BACKEND} rendered no frames on this machine.\n`),
    );
    return 0;
  }
  process.stdout.write('\n' + dim(`  semantics gate (${SEMANTIC_GATE_BACKEND}) — ${label}:\n`));
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, script), SEMANTIC_GATE_BACKEND], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', (c) => resolve(c ?? 1));
  });
  return code === 0 ? 0 : 1;
}

async function gateAlphaSemantics(scenes, backends) {
  return gateSemantics(
    scenes, backends, 'verify-alpha.mjs', 'alpha-control-straight-src',
    'the alpha invariant and footage interpretation (shapes not bytes)',
  );
}

async function compareAll(scenes) {
  let parityFail = 0;
  let parityKnownGap = 0;
  let parityResolved = 0;
  const rows = [];

  for (const s of scenes) {
    // Oracle-only scenes exist to be some other scene's twin; they have no
    // reference of their own by design.
    if (s.fidelityOnly) continue;
    // An accepted gap must carry a MECHANISM and an exit condition. A bare
    // label is indistinguishable from "nobody looked", which is exactly how
    // effect-gradient-ramp sat in this bucket while rendering solid black.
    // Suppression that costs nothing gets used for anything; making it fail
    // closed means the only way to widen the gap is to write down a cause,
    // and a false mechanical cause is far harder to produce than a flag.
    const d = s.divergence;
    const undocumented =
      (s.gpuParity === 'known-divergent') &&
      !(d && typeof d.why === 'string' && d.why.trim().length > 0
          && typeof d.wouldMatchWhen === 'string' && d.wouldMatchWhen.trim().length > 0);
    const isExpectPass = s.oracle === 'gpu' || (s.gpuParity ?? 'expect-pass') === 'expect-pass' || undocumented;
    for (const frame of s.frames) {
      const ref = path.join(REFERENCES, s.id, `${frame}.png`);
      const actual = await readPngSafe(path.join(ACTUAL, GATE_BACKEND, s.id, `${frame}.png`));

      let result;
      if (!actual) {
        result = { pass: false, ratio: 1, mismatchReason: `${GATE_BACKEND} actual missing` };
      } else {
        result = await compareAgainstReference({
          actual,
          referenceFile: ref,
          artifactDir: path.join(ARTIFACTS, 'diff'),
          sceneId: s.id,
          frame,
          tolerance: s.tolerance,
        });
      }

      // A scene that produced NO IMAGE is never an accepted gap.
      //
      // `known-divergent` + a stated cause means "these pixels differ for a
      // reason we wrote down". It cannot mean "there are no pixels": a stated
      // cause describes a comparison, and no comparison happened. Routing a
      // missing frame through the gap bucket is exactly how
      // `shape-path-op-zigzag` stayed green while its `build` threw for months
      // — the divergence prose added to PREVENT silent suppression was the
      // thing doing the suppressing.
      const noImage = !actual;
      if (isExpectPass || noImage) {
        if (!result.pass) {
          parityFail++;
        }
      } else {
        if (!result.pass) {
          parityKnownGap++;
        } else {
          parityResolved++;
        }
      }

      rows.push({
        scene: s.id,
        frame,
        pass: result.pass,
        ratio: result.ratio,
        gpuParity: undocumented ? 'expect-pass' : (s.gpuParity ?? 'expect-pass'),
        divergence: s.divergence,
        undocumented,
        mismatchReason: undocumented
          ? 'known-divergent without a stated cause — add `divergence: { why, wouldMatchWhen }`'
          : result.mismatchReason,
        isGpuOracle: s.oracle === 'gpu',
      });
    }
  }

  printReport(rows);
  return { parityFail, parityKnownGap, parityResolved };
}

/** True when every pixel in an RGBA frame is identical (blank / flat fill). */
function isUniform({ data }) {
  for (let i = 4; i < data.length; i += 4) {
    if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2] || data[i + 3] !== data[3]) {
      return false;
    }
  }
  return true;
}

async function readPngSafe(file) {
  try {
    return await readPng(file);
  } catch {
    return null;
  }
}

function pct(r) {
  return `${(r * 100).toFixed(3)}%`;
}

function printReport(rows) {
  process.stdout.write('\n' + dim('scene / frame                      result\n'));
  for (const r of rows) {
    const name = `${r.scene}#${r.frame}`.padEnd(34);
    let p;
    if (r.isGpuOracle) {
      p = r.pass ? green('gpu-oracle ✓') : red('gpu-oracle FAIL ' + pct(r.ratio ?? 1));
    } else if (r.gpuParity === 'known-divergent') {
      p = r.pass
        ? green('parity ✓')
        : dim(`known-gap ${pct(r.ratio ?? 1)}`);
    } else {
      p = r.pass ? green('PASS') : red('FAIL ' + pct(r.ratio ?? 1));
    }
    process.stdout.write(`${name} ${p}\n`);
    if (r.mismatchReason) process.stdout.write(dim(`    ${r.mismatchReason}\n`));
  }
}

async function main() {
  await rmrf(ACTUAL);
  await fs.mkdir(ARTIFACTS, { recursive: true });

  await buildHarness();

  // Every backend renders in its own process (see renderBackendsIsolated).
  // GATE_BACKEND is the one whose output must match the references; any others
  // are measured and printed but never fail the build.
  const backends = (process.env.HARNESS_BACKENDS || DEFAULT_BACKENDS.join(','))
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!backends.includes(GATE_BACKEND)) backends.unshift(GATE_BACKEND);
  const run = await renderBackendsIsolated(backends);
  if (!run.ok) {
    process.stdout.write(red(`\n✗ render harness exited ${run.code} on [${run.backend}] — no pixels produced.\n`));
    process.exit(1);
  }

  const scenes = await loadManifest();
  if (scenes.length === 0) {
    process.stdout.write(red('✗ no scenes in manifest.\n'));
    process.exit(1);
  }

  if (updateMode) {
    await bless(scenes);
    process.exit(0);
  }

  const { parityFail, parityKnownGap, parityResolved } = await compareAll(scenes);
  const { fidelityFail } = await gateFidelityTwins(scenes);
  const { animFail } = await gateAnimatedFrames(scenes);
  const alphaFail = await gateAlphaSemantics(scenes, backends);
  const stylesFail = await gateSemantics(
    scenes, backends, 'verify-3d-styles.mjs', 'three-d-drop-shadow',
    'layer styles + depth of field on 3D layers (direction and extent, not presence)',
  );
  /*
    Plugin effects, and the reason they need a SEMANTIC gate of their own.

    The golden pixels come from WebGL2, where a plugin effect is a deliberate
    passthrough — so `plugin-visible`'s reference is, correctly, a picture in
    which the shader changed nothing. That reference gates the failure this
    scene family was written for (a plugin effect ERASING the layer, which it
    did on both tiers) and cannot gate the other one: an effect that silently
    does not run looks exactly like the golden.

    Only the WebGPU verifier can tell those apart, by comparing against a
    control rendered in the same run. Without this line it existed and nothing
    called it, which is the same shape of hole as the effect itself had.
  */
  const pluginFail = await gateSemantics(
    scenes, backends, 'verify-plugin-render.mjs', 'plugin-control',
    'a plugin effect runs, and runs correctly (against a live control, not a golden)',
  );
  /*
    Extrusion effect REACH, and why a reference cannot hold it.

    Every synthesized face of an extrusion carried `effects: undefined`, so a
    layer's whole stack applied to the front face alone. The references for
    these scenes are blessed from our own output, so blessing them while that
    was true would have certified front-face-only forever — and every symptom
    reads as success from a single frame, because the front face is most of
    what a solid shows. Only a comparison against the scene's own control says
    which FACES the effect reached.
  */
  const extrusionFail = await gateSemantics(
    scenes, backends, 'verify-extrusion.mjs', 'ext-fx-invert',
    'an effect reaches every face of an extruded solid, not just the front',
  );

  process.stdout.write('\n');
  process.stdout.write(dim('  GPU-parity dashboard (unified engine comparison against committed reference):\n'));
  if (parityResolved > 0) {
    process.stdout.write(green(`  · ${parityResolved} scene(s) previously divergent now match exactly!\n`));
  }
  if (parityFail > 0) {
    process.stdout.write(red(`  · ${parityFail} scene(s) failed the target visual expectations.\n`));
  }
  if (parityKnownGap > 0) {
    process.stdout.write(dim(`  · ${parityKnownGap} scene(s) have accepted visual gaps against baseline Canvas2D.\n`));
  }

  // Every non-gating backend that rendered gets a measured parity line, so the
  // primary engine's standing is visible on every run instead of unknown.
  let backendFail = 0;
  for (const backend of backends) {
    if (backend === GATE_BACKEND) continue;
    if (updateBackendBaselineMode) await updateBackendBaseline(scenes, backend);
    else backendFail += await gateSecondaryBackend(scenes, backend);
  }

  if (parityFail === 0 && fidelityFail === 0 && animFail === 0 && alphaFail === 0 && stylesFail === 0
    && pluginFail === 0 && extrusionFail === 0 && backendFail === 0) {
    process.stdout.write(green(`\n✓ gate green — unified engine output matches golden expectations.\n`));
    process.exit(0);
  }
  process.stdout.write(
    red(`\n✗ gate failed — visual regressions: ${parityFail}, fidelity losses: ${fidelityFail}, ` +
      `properties that stopped animating: ${animFail}, ` +
      `alpha semantics: ${alphaFail}, 3D-style semantics: ${stylesFail}, ` +
      `plugin effects: ${pluginFail}, extrusion face reach: ${extrusionFail}, ` +
      `webgpu pixel ratchet: ${backendFail}.\n`) +
      dim(`  artifacts: ${path.join(ARTIFACTS, 'diff')}\n`),
  );
  process.exit(1);
}

// Exposed for the comparator self-test.
export { compareFrames };

main().catch((err) => {
  process.stderr.write(red(`\nrunner crashed: ${err?.stack ?? err}\n`));
  process.exit(1);
});
