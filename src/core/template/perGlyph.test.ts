/**
 * Per-glyph kinetic typography — end-to-end through the REAL snapshot pipeline:
 * a text node carrying a native text-animator, with the selector `ta.0.start`
 * keyframed, must yield per-glyph offsets on the snapshot's text layer. This is
 * what makes the "Cascade Rise / Type Fade" presets animate each
 * character — verified without a canvas (the offsets are computed pre-raster).
 */

import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import { animatorPropPath } from '@core/text/textAnimators';
import { addRoot, addText } from './templates/builders';

function textWithAnimator(): { graph: SceneGraph; anim: AnimationEngine } {
  const graph = new SceneGraph();
  addRoot(graph, 'tpl_root', 'x');
  addText(graph, 'el', 'tpl_root', 'ABCDE', 240, 135, 96, 800, '#ffffff');
  // Reveal animator: covered glyphs sit 100px down and invisible.
  graph.writeProp('el', 'el_c', '__animators', [{
    id: 'a0', basedOn: 'characters', shape: 'square',
    start: 0, end: 100, offset: 0,
    x: 0, y: 100, scale: 100, rotation: 0, opacity: 0, tracking: 0, skew: 0, mode: 'range', wiggleFreq: 2,
  }]);
  const anim = new AnimationEngine();
  return { graph, anim };
}

function snap(graph: SceneGraph, anim: AnimationEngine, t: number) {
  return buildSnapshot(
    graph, anim, t, undefined, undefined,
    { scale: 1, offsetX: 0, offsetY: 0 }, undefined,
    { rootId: 'tpl_root', width: 480, height: 270, background: 'rgba(0,0,0,0)' },
  );
}

describe('per-glyph kinetic typography', () => {
  it('produces one glyph transform per character', () => {
    const { graph, anim } = textWithAnimator();
    anim.setKeyframe('el', animatorPropPath(0, 'start'), 0, 0);
    const text = snap(graph, anim, 0).layers.find((l) => l.kind === 'text');
    expect(text?.glyphs).toBeTruthy();
    expect(text!.glyphs!.length).toBe(5);
  });

  it('with the selector covering all (start=0), every glyph carries the offset', () => {
    const { graph, anim } = textWithAnimator();
    anim.setKeyframe('el', animatorPropPath(0, 'start'), 0, 0); // covers all
    const text = snap(graph, anim, 0).layers.find((l) => l.kind === 'text');
    // dy == the animator's y (100) and opacity multiplier 0 → hidden.
    expect(text!.glyphs!.every((g) => g.dy === 100)).toBe(true);
    expect(text!.glyphs!.every((g) => g.opacity === 0)).toBe(true);
  });

  it('sweeping the selector (start→100) reveals glyphs left-to-right', () => {
    const { graph, anim } = textWithAnimator();
    // Mid-sweep: start=50 uncovers the left half (dy back to 0), right half still down.
    anim.setKeyframe('el', animatorPropPath(0, 'start'), 0, 50);
    const glyphs = snap(graph, anim, 0).layers.find((l) => l.kind === 'text')!.glyphs!;
    expect(glyphs[0]!.dy).toBe(0);   // 'A' revealed
    expect(glyphs[4]!.dy).toBe(100); // 'E' still hidden
  });
});
