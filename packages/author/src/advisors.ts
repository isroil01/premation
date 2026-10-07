/**
 * The caster's three linters, run over an authored composition as ADVICE.
 *
 * In the caster these drive automatic repairs, because there they measure
 * library parameters that a table can correct. Here they measure choices the
 * author made — a flat fill, a metronome stagger, a camera over a flat beat —
 * and the compiler is not allowed to make a different choice. So the findings
 * go to the critique and the revise call, attributed to the beat they came
 * from, and the author decides.
 *
 * The linters are unchanged; this file only builds their inputs from the
 * compiled calls (`sceneFromCalls`, the same reduction the caster uses) and
 * the script (grid, background, roles, beats).
 */

import { sceneFromCalls } from '@motion/caster';
import { grid as gridFor, lintDesign, type LintScene } from '@motion/design-system';
import { lintTiming } from '@motion/technique-library';
import { lintUiMotion } from '@motion/product-motion';
import type { CompiledScript, SceneScript } from './types';

export interface AdvisorFinding {
  source: 'design' | 'timing' | 'ui';
  rule: string;
  severity: 'error' | 'warn';
  message: string;
  nodeIds: string[];
  /** The beat the finding is about; -1 when it is about the whole piece. */
  beatIndex: number;
}

export interface Advice {
  findings: AdvisorFinding[];
  /** Findings per beat index (−1 = piece-wide). */
  byBeat: Map<number, AdvisorFinding[]>;
}

export interface AdviseOptions {
  width: number;
  height: number;
  fps: number;
}

/** The accent the design linter measures emphasis against: `$accent`, else the first swatch. */
function accentOf(script: SceneScript): string {
  return script.palette.accent ?? Object.values(script.palette)[0] ?? '#ffffff';
}

/** The beat a finding belongs to: the one most of its layers are in. */
function beatOf(nodeIds: readonly string[], compiled: CompiledScript): number {
  const counts = new Map<number, number>();
  for (const id of nodeIds) {
    const b = compiled.beatOfLayer.get(id);
    if (b !== undefined) counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  let best = -1;
  let n = 0;
  for (const [b, c] of counts) if (c > n || (c === n && b < best)) { best = b; n = c; }
  return best;
}

/** Kinds that draw nothing, so carry nothing across a cut. */
const INVISIBLE = new Set(['null', 'camera', 'light']);

/**
 * How many drawn layers are on screen on both sides of `t`: the globals that
 * span it, and beat layers whose bar the author extended across it.
 */
function survivorsAt(script: SceneScript, t: number): number {
  const eps = 1e-6;
  let n = 0;
  for (const g of script.globals) {
    if (INVISIBLE.has(g.kind)) continue;
    if ((g.inSec ?? 0) < t - eps && (g.outSec ?? script.durationSec) > t + eps) n++;
  }
  for (const b of script.beats) {
    for (const l of b.layers) {
      if (INVISIBLE.has(l.kind)) continue;
      const from = b.startSec + (l.inSec ?? 0);
      const to = b.startSec + (l.outSec ?? b.endSec - b.startSec);
      if (from < t - eps && to > t + eps) n++;
    }
  }
  return n;
}

/** Run all three linters over a compiled script. Pure. */
export function adviseScript(script: SceneScript, compiled: CompiledScript, o: AdviseOptions): Advice {
  const findings: AdvisorFinding[] = [];
  const push = (source: AdvisorFinding['source'], f: { rule: string; severity: 'error' | 'warn'; message: string; nodeIds: string[] }) => {
    findings.push({ source, rule: f.rule, severity: f.severity, message: f.message, nodeIds: f.nodeIds, beatIndex: beatOf(f.nodeIds, compiled) });
  };

  // Every beat is its own set of co-visible layers; globals are visible throughout.
  const groupOf = new Map<string, string>();
  for (const [id, b] of compiled.beatOfLayer) if (b >= 0) groupOf.set(id, `b${b}`);
  const ambient = new Set<string>();
  const roles = new Map<string, string>();
  for (const l of [...script.globals, ...script.beats.flatMap((b) => b.layers)]) {
    if (l.role) roles.set(l.id, l.role);
    if (l.role === 'ambient' || l.role === 'background') ambient.add(l.id);
  }

  // ── design ──
  // The script's own grid. A missing field falls back to the linter's frame
  // default — a measuring stick, not a layout: nothing is moved by it.
  const g = gridFor(o.width, o.height, {
    ...(script.grid.columns ? { columns: script.grid.columns } : {}),
    ...(script.grid.gutter ? { gutter: script.grid.gutter } : {}),
    ...(script.grid.margin ? { margin: script.grid.margin } : {}),
    ...(script.grid.baseline ? { baseline: script.grid.baseline } : {}),
  });
  const background = script.background.startsWith('$') ? script.palette[script.background.slice(1)] ?? '#000000' : script.background || '#000000';
  const scene: LintScene = {
    grid: g,
    background,
    accent: accentOf(script),
    layers: sceneFromCalls(compiled.calls, { width: o.width, height: o.height }, {}, ambient, groupOf),
  };
  for (const f of lintDesign(scene)) push('design', f);

  // ── timing ──
  const cameraBeats = script.beats
    .map((b, i) => (b.layers.some((l) => l.kind === 'camera') ? i : -1))
    .filter((i) => i >= 0);
  const staticZ = new Map<string, number>();
  for (const c of compiled.calls) {
    if (c.name === 'update_layer' && typeof c.args.z === 'number') staticZ.set(String(c.args.nodeId ?? ''), c.args.z);
  }
  const heroNodeIds = [...roles].filter(([, r]) => r === 'hero').map(([id]) => id);
  const uiNodeIds = [...roles].filter(([, r]) => r === 'ui').map(([id]) => id);
  for (const f of lintTiming({
    calls: compiled.calls,
    fps: o.fps,
    durationMs: Math.round(script.durationSec * 1000),
    heroNodeIds,
    uiNodeIds,
    beatOf: new Map([...groupOf].map(([id, gr]) => [id, Number(gr.slice(1))])),
    beatBoundaries: script.beats.slice(1).map((b) => ({ atMs: Math.round(b.startSec * 1000), survivors: survivorsAt(script, b.startSec) })),
    cameraBeats,
    staticZ,
  })) push('timing', f);

  // ── UI motion: only where the author marked product UI ──
  if (uiNodeIds.length) {
    for (const f of lintUiMotion({ calls: compiled.calls, fps: o.fps, uiNodeIds })) push('ui', f);
  }

  const byBeat = new Map<number, AdvisorFinding[]>();
  for (const f of findings) byBeat.set(f.beatIndex, [...(byBeat.get(f.beatIndex) ?? []), f]);
  return { findings, byBeat };
}

/** Findings as lines for a prompt, errors first. */
export function formatAdvice(findings: readonly AdvisorFinding[], max = 20): string {
  const sorted = [...findings].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  const lines = sorted.slice(0, max).map((f) => `- [${f.source}/${f.rule}${f.severity === 'warn' ? ', judgement call' : ''}] ${f.message}`);
  if (sorted.length > max) lines.push(`- …and ${sorted.length - max} more`);
  return lines.join('\n');
}
