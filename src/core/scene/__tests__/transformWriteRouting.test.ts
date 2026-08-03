/**
 * No feature module may write an ANIMATABLE transform property directly.
 *
 * WHY. `SceneGraph.writeProp` sets the static value. The renderer reads animated
 * values first (`av.get(prop) ?? transform.prop`), so on a layer whose property
 * carries a track, that write is silently discarded — the store updates, the
 * screen does not, and the feature looks broken for reasons nothing explains.
 *
 * Three shipped features had exactly this, all found from one user report about
 * the anchor point:
 *
 *   anchor.ts        pan-behind compensated x/y with raw writes, so on a layer
 *                    with animated Position the compensation was dropped and the
 *                    layer JUMPED — the precise error pan-behind prevents.
 *                    Reproduced: anchorX 1 → 11 left Position X at 961, not 971.
 *   alignNodes.ts    aligning an animated layer did nothing visible.
 *   fitCommands.ts   Fit to Comp / Fill / Native Size, same.
 *
 * The correct idiom already existed in `workspace/ports` for canvas drags — but
 * `hasAnyTrack` was private there, so nothing else could reuse it. It now lives
 * in `core/scene/transformWrite`. This test stops the class from returning.
 *
 * ALLOWED to write directly (each for a stated reason, not by exemption):
 *   • transformWrite.ts   — it IS the router.
 *   • workspace/ports.ts  — the original implementation, drag/gizmo hot path,
 *                           already correct and batches its own history.
 *   • ai/*, plugins/*     — automation writing to nodes it is building; these
 *                           carry the F11 lint disables and are audited there.
 *
 * IF THIS FAILS: call `writeTransformProps` instead of `writeProp`.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';

const SRC = resolve(__dirname, '../../..');

/** Properties the animation engine can own — a raw write to these can vanish. */
const ANIMATABLE = [
  'x', 'y', 'z',
  'rotation', 'rotationX', 'rotationY',
  'scaleX', 'scaleY', 'scale',
  'anchorX', 'anchorY', 'anchorZ',
  'opacity', 'width', 'height',
];

/** Files permitted to write these directly. Paths are repo-relative to src/. */
const ALLOWED = [
  'core/scene/transformWrite.ts',
  'core/workspace/ports.ts',
  // Automation surfaces: they construct nodes and are covered by the F11 audit.
  'core/ai/',
  'core/plugins/',
  'core/inspector/InspectorAPI.ts',
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...sourceFiles(p));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const rel = (abs: string): string => abs.slice(SRC.length + 1).replace(/\\/g, '/');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('animatable transform props are written through one router', () => {
  const files = sourceFiles(SRC).filter((f) => !ALLOWED.some((a) => rel(f).startsWith(a)));

  it('scans a plausible number of source files', () => {
    // Guards the guard: an empty scan passes vacuously.
    expect(files.length).toBeGreaterThan(200);
  });

  it('no module outside the router writes an animatable transform prop directly', () => {
    const offenders: string[] = [];
    const propAlt = ANIMATABLE.join('|');
    // writeProp(nodeId, <component>.id, '<prop>', …) — capture BOTH the
    // component identifier and the prop.
    //
    // The component matters, not just the prop name: several of these names
    // also exist on other components, where the animation engine does not own
    // them and a direct write is correct. `stylePresets` writes `opacity` on
    // the STYLE component — a different property that merely shares a name.
    const re = new RegExp(
      `writeProp\\s*\\([^,]+,\\s*([A-Za-z_$][\\w$]*)\\.id\\s*,\\s*['"\`](${propAlt})['"\`]`,
      'g',
    );
    /** Identifiers this codebase uses for the Transform component. */
    const TRANSFORM_IDENT = /^(t|tc|trans|transform|transformComp|transformComponent|tComp)$/i;

    for (const f of files) {
      const code = stripComments(readFileSync(f, 'utf8'));
      for (const m of code.matchAll(re)) {
        if (TRANSFORM_IDENT.test(m[1]!)) offenders.push(`${rel(f)} → ${m[2]}`);
      }
    }
    expect([...new Set(offenders)].sort()).toEqual([]);
  });

  it('the three previously-broken modules import the router', () => {
    // Pins the fix itself, not just the absence of the old pattern — deleting
    // the import and the writes together would otherwise pass silently.
    for (const f of ['core/scene/anchor.ts', 'core/scene/alignNodes.ts', 'core/source/fitCommands.ts']) {
      expect(readFileSync(join(SRC, f), 'utf8')).toMatch(/writeTransformProps/);
    }
  });
});
