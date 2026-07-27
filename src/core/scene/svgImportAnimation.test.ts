/**
 * The imported-SVG path end to end: markup → scene layers → keyframe tracks on
 * the animation engine.
 *
 * `svgCss.test.ts` and `svgAnimation.test.ts` stop at `parseSvgToShapes`, which
 * is one step short of the thing the user reports. An SVG that "does not
 * animate in the scene" can fail at either end — the tracks were never read, or
 * they were read and never written — so this asserts the layer really carries
 * them.
 */

import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from './DefaultSceneGraph';
import { insertSvgShapeGroup } from './sceneInsert';

const wrap = (inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">${inner}</svg>`;

/** Every animated property on the group's parts. */
function trackedProps(groupId: string): Set<string> {
  const out = new Set<string>();
  const group = defaultSceneGraph.getNode(groupId);
  for (const childId of group?.children ?? []) {
    for (const track of defaultAnimation.tracksFor(childId)) {
      if (track.keyframes.length > 0) out.add(track.prop);
    }
  }
  return out;
}

describe('SVG import writes real keyframes onto the inserted layers', () => {
  it('carries a CSS @keyframes spin onto the shape', () => {
    const id = insertSvgShapeGroup(wrap(`
      <style>
        @keyframes spin { to { transform: rotate(360deg) } }
        .r { animation: spin 2s linear infinite; transform-box: fill-box; transform-origin: center }
      </style>
      <rect class="r" x="40" y="40" width="20" height="20" fill="#f00"/>`), 'spinner.svg');
    expect(id).not.toBeNull();
    expect(trackedProps(id!)).toContain('rotation');
  });

  it('carries a SMIL translate onto the shape', () => {
    const id = insertSvgShapeGroup(wrap(`
      <rect x="0" y="0" width="10" height="10" fill="#0f0">
        <animateTransform attributeName="transform" type="translate"
          from="0 0" to="40 0" dur="1s" repeatCount="indefinite"/>
      </rect>`), 'slide.svg');
    expect(id).not.toBeNull();
    expect(trackedProps(id!)).toContain('x');
  });

  it('animates even when a gradient makes the file "not simple"', () => {
    // The routing gate used to send anything with a gradient to the rasterizer,
    // which froze the animation on frame 0. Vector wins when motion converts.
    const id = insertSvgShapeGroup(wrap(`
      <defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>
      <style>
        @keyframes fade { from { opacity: 0 } to { opacity: 1 } }
        .c { animation: fade 1s linear infinite alternate }
      </style>
      <circle class="c" cx="50" cy="50" r="20" fill="url(#g)"/>`), 'gradient.svg');
    expect(id).not.toBeNull();
    expect(trackedProps(id!)).toContain('opacity');
  });

  it('leaves a static SVG with no keyframes at all', () => {
    const id = insertSvgShapeGroup(wrap('<rect x="10" y="10" width="20" height="20" fill="#333"/>'), 'static.svg');
    expect(id).not.toBeNull();
    expect(trackedProps(id!).size).toBe(0);
  });
});
