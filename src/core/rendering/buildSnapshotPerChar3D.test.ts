import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { Matrix4Math } from '@motion/scene';
import { snapshotToFrameScene } from './snapshotToFrameScene';
import { depthEligible3D } from '@motion/renderer';

const COMP = { width: 800, height: 600, background: '#101014' };

/** A 3D text layer. `perChar3D` / `z` etc. ride the Transform props, matching
 *  how threeD.ts reads them. */
function text3D(id: string, text: string, props: Record<string, unknown> = {}): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`, type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'text', x: 400, y: 300, rotation: 0, width: 400, height: 80, z: 0, ...props },
      },
      { id: `${id}_x`, type: 'Text', props: { content: text, fontSize: 40, fontFamily: 'Inter', align: 'center' } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#ffffff' } },
    ],
  } as unknown as SceneNode;
}

function snap(graph: SceneGraph, anim = new AnimationEngine(), t = 0) {
  return buildSnapshot(graph, anim, t, undefined, undefined, undefined, undefined, COMP);
}

const glyphLayers = (s: ReturnType<typeof snap>, id: string) =>
  s.layers.filter((l) => l.id.startsWith(`${id}::ch`));

describe('buildSnapshot — per-character 3D text', () => {
  it('OFF (default): a 3D text layer stays ONE plane (regression)', () => {
    const g = new SceneGraph();
    g.addNode(text3D('t', 'ABC'));
    const s = snap(g);
    expect(glyphLayers(s, 't')).toHaveLength(0);
    expect(s.layers.filter((l) => l.id === 't')).toHaveLength(1);
  });

  it('a 2D text layer never splits, even with the flag on', () => {
    const g = new SceneGraph();
    g.addNode(text3D('t', 'ABC', { z: undefined, perChar3D: true }));
    const s = snap(g);
    const flat = s.layers.find((l) => l.id === 't')!;
    expect(flat.world3d).toBeUndefined();
    expect(glyphLayers(s, 't')).toHaveLength(0);
  });

  it('ON: emits one 3D plane per glyph instead of the string plane', () => {
    const g = new SceneGraph();
    g.addNode(text3D('t', 'ABC', { perChar3D: true }));
    const s = snap(g);
    const glyphs = glyphLayers(s, 't');
    expect(glyphs).toHaveLength(3);
    // The single whole-string plane is GONE — replaced, not duplicated.
    expect(s.layers.some((l) => l.id === 't')).toBe(false);
    // Each glyph carries its own text + world matrix.
    expect(glyphs.map((l) => l.text)).toEqual(['A', 'B', 'C']);
    for (const l of glyphs) {
      expect(l.world3d).toBeDefined();
      expect(l.matrix).toBeDefined();
    }
  });

  it('whitespace makes no plane (no empty draws)', () => {
    const g = new SceneGraph();
    g.addNode(text3D('t', 'A B', { perChar3D: true }));
    expect(glyphLayers(snap(g), 't').map((l) => l.text)).toEqual(['A', 'B']);
  });

  it('glyph planes are laid out left-to-right in world space', () => {
    const g = new SceneGraph();
    g.addNode(text3D('t', 'ABC', { perChar3D: true }));
    const xs = glyphLayers(snap(g), 't').map(
      (l) => Matrix4Math.transformPoint(l.world3d as import('@motion/scene').Matrix4, { x: 0, y: 0, z: 0 }).x,
    );
    expect(xs[0]!).toBeLessThan(xs[1]!);
    expect(xs[1]!).toBeLessThan(xs[2]!);
  });

  it('glyph planes share the parent depth so they group as ONE depth pass', () => {
    const g = new SceneGraph();
    g.addNode(text3D('t', 'ABC', { perChar3D: true }));
    const glyphs = glyphLayers(snap(g), 't');
    const depths = new Set(glyphs.map((l) => l.depth));
    expect(depths.size).toBe(1);
  });

  it('every glyph plane is depth-eligible (intersects + lights individually)', () => {
    const g = new SceneGraph();
    g.addNode(text3D('t', 'ABC', { perChar3D: true }));
    const scene = snapshotToFrameScene(snap(g));
    const glyphs = scene.renderables.filter((r) => r.id.startsWith('t::ch'));
    expect(glyphs).toHaveLength(3);
    for (const r of glyphs) {
      expect(r.threeD).toBeDefined();
      expect(depthEligible3D(r)).toBe(true);
    }
  });

  it('glyph ids are synthetic (never collide with real scene-graph ids)', () => {
    const g = new SceneGraph();
    g.addNode(text3D('t', 'AB', { perChar3D: true }));
    const ids = glyphLayers(snap(g), 't').map((l) => l.id);
    expect(ids).toEqual(['t::ch0', 't::ch1']);
    expect(g.getNode('t::ch0')).toBeFalsy();
  });

  it('a per-character 3D layer still extrudes each glyph when depth > 0', () => {
    const g = new SceneGraph();
    g.addNode(text3D('t', 'AB', { perChar3D: true, extrusionDepth: 60 }));
    const s = snap(g);
    // Glyph planes exist AND extrusion slices were synthesized for the layer.
    expect(glyphLayers(s, 't').length).toBe(2);
    expect(s.layers.some((l) => l.id.startsWith('t::ext-'))).toBe(true);
  });
});
