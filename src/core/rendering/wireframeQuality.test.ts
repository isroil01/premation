/**
 * Quality = WIREFRAME is viewport-only.
 *
 * Pinned like the proxy invariant (`proxyExport.test.ts`): behaviourally through
 * `buildSnapshot` (an export-shaped call — no `wireframeLayers` — renders the
 * layer; only the explicit opt-in hides it), and statically (the two viewport
 * hosts opt in; no output path mentions the flag).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildSnapshot, type SnapshotComp } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

const COMP: SnapshotComp = { width: 1920, height: 1080, background: '#000' };

function shapeNode(quality?: string): SceneNode {
  return {
    id: 'box', name: 'box', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 960, y: 540 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: 'box_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 960, y: 540, width: 200, height: 100 } },
      { id: 'box_s', type: 'Style', props: { opacity: 100, fill: '#ff0000' } },
      ...(quality ? [{ id: 'box_fx', type: 'fx', props: { quality } }] : []),
    ],
  } as unknown as SceneNode;
}

function layerAt(comp: SnapshotComp, quality?: string) {
  const g = new SceneGraph();
  g.addNode(shapeNode(quality));
  const snap = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, comp);
  return snap.layers.find((l) => l.id === 'box');
}

describe('Quality = Wireframe gating', () => {
  it('an export-shaped build ignores wireframe: the layer renders as Best', () => {
    const l = layerAt(COMP, 'wireframe');
    expect(l?.visible).toBe(true);
    expect(l?.quality).toBeUndefined();
  });

  it('the viewport opt-in hides a wireframe layer (the overlay draws its box)', () => {
    expect(layerAt({ ...COMP, wireframeLayers: true }, 'wireframe')?.visible).toBe(false);
  });

  it('the opt-in leaves Best and Draft layers alone, and is strict about `true`', () => {
    expect(layerAt({ ...COMP, wireframeLayers: true })?.visible).toBe(true);
    expect(layerAt({ ...COMP, wireframeLayers: true }, 'draft')?.visible).toBe(true);
    expect(layerAt({ ...COMP, wireframeLayers: 'true' as unknown as boolean }, 'wireframe')?.visible).toBe(true);
  });
});

describe('only the interactive viewport opts in', () => {
  const ROOT = join(__dirname, '..', '..', '..');
  const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
  const walk = (rel: string): string[] => {
    const abs = join(ROOT, rel);
    const out: string[] = [];
    for (const f of readdirSync(abs)) {
      const child = `${rel}/${f}`;
      if (statSync(join(abs, f)).isDirectory()) out.push(...walk(child));
      else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(child);
    }
    return out;
  };

  it('the page viewport host passes wireframeLayers: true (the panes, the Layer panel and presentation mode are engine surfaces)', () => {
    for (const h of ['src/layout/Workspace/useWorkspace.ts']) {
      expect(read(h)).toContain('wireframeLayers: true');
    }
  });

  it('no export / CLI / render-queue source mentions the flag', () => {
    const outputs = ['src/core/export', 'src/layout/Export', 'src/layout/RenderQueue'].flatMap(walk);
    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs.filter((f) => read(f).includes('wireframeLayers'))).toEqual([]);
  });
});
