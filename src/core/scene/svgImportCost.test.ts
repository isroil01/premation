/**
 * Guards the COST of importing an animated SVG.
 *
 * This exists because the feature shipped once in a state that froze the whole
 * desktop app. Nothing about the output looked wrong — the tracks were correct,
 * there were just hundreds of thousands of them. A 200-path spinner produced
 * 216,000 keyframes, each one an O(n) insert into a re-sorted array plus a
 * change notification, and the app stopped responding for as long as that took.
 *
 * Correctness tests cannot catch that, so these assert the shape of the cost:
 *
 *  - a looping animation is baked ONCE and repeated by a `loopOut` expression,
 *    so its size does not grow with the composition's length;
 *  - straight-line sampling is simplified away, so a constant spin is a couple
 *    of keyframes and not one per sampled angle;
 *  - the whole import stays under a total ceiling no matter what it is fed.
 *
 * The thresholds are deliberately loose — they are here to catch a return to
 * six-figure keyframe counts, not to pin an exact number.
 */

import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from './DefaultSceneGraph';
import { insertSvgShapeGroup } from './sceneInsert';
import { parseSvgToShapes, MAX_IMPORT_KEYFRAMES } from '../../utils/svgParser';

/** A CSS spinner with `paths` independently animated parts. */
function cssSpinner(paths: number): string {
  let inner = '<style>@keyframes spin { to { transform: rotate(360deg) } }\n';
  for (let i = 0; i < paths; i++) {
    inner += `.p${i} { animation: spin 1s linear infinite; transform-box: fill-box; transform-origin: center }\n`;
  }
  inner += '</style>';
  for (let i = 0; i < paths; i++) {
    const a = (i / paths) * Math.PI * 2;
    const x = 50 + Math.cos(a) * 30;
    const y = 50 + Math.sin(a) * 30;
    inner += `<path class="p${i}" d="M${x} ${y} L${x + 6} ${y} L${x + 6} ${y + 6} L${x} ${y + 6} Z" fill="#f00"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${inner}</svg>`;
}

/** SMIL rotation about a distant point — every part ORBITS, the costly case. */
function smilOrbit(paths: number): string {
  let inner = '';
  for (let i = 0; i < paths; i++) {
    inner += `<rect x="${i % 50}" y="${Math.floor(i / 50)}" width="5" height="5" fill="#0f0">
      <animateTransform attributeName="transform" type="rotate"
        from="0 50 50" to="360 50 50" dur="1.5s" repeatCount="indefinite"/>
    </rect>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${inner}</svg>`;
}

function totalKeyframes(svg: string, maxDurationSeconds = 10): number {
  const shapes = parseSvgToShapes(svg, { maxDurationSeconds });
  return shapes.reduce((sum, s) => {
    const a = s.animation;
    if (!a) return sum;
    return sum + (a.x?.length ?? 0) + (a.y?.length ?? 0) + (a.rotation?.length ?? 0)
      + (a.scaleX?.length ?? 0) + (a.scaleY?.length ?? 0) + (a.opacity?.length ?? 0);
  }, 0);
}

describe('animated SVG import cost', () => {
  it('keeps a constant spin to a handful of keyframes per shape', () => {
    // Was 540 per track: one per 45° of sixty seconds of unrolled spinning.
    expect(totalKeyframes(cssSpinner(1))).toBeLessThanOrEqual(6);
    expect(totalKeyframes(cssSpinner(200))).toBeLessThanOrEqual(1200);
  });

  it('does not grow with the composition duration', () => {
    // The point of baking one cycle: a ten-minute comp costs what a two-second
    // one costs. Unrolled, this ratio was 300×.
    const short = totalKeyframes(cssSpinner(20), 2);
    const long = totalKeyframes(cssSpinner(20), 600);
    expect(long).toBe(short);
  });

  it('stays under the ceiling on artwork that orbits every part', () => {
    const kf = totalKeyframes(smilOrbit(200));
    expect(kf).toBeLessThan(MAX_IMPORT_KEYFRAMES);
    // Was 216,000.
    expect(kf).toBeLessThan(20000);
  });

  it('writes the tracks onto the layers in bulk, not keyframe by keyframe', () => {
    const svg = cssSpinner(100);
    const shapes = parseSvgToShapes(svg, { maxDurationSeconds: 10 });
    const started = Date.now();
    const id = insertSvgShapeGroup(svg, 'spinner.svg', { shapes });
    const elapsed = Date.now() - started;
    expect(id).not.toBeNull();

    const children = defaultSceneGraph.getNode(id!)?.children ?? [];
    expect(children.length).toBe(100);
    const animated = children.filter((c) => defaultAnimation.tracksFor(c).length > 0);
    expect(animated.length).toBe(100);

    // Generous — a machine under load is still nowhere near the multi-second
    // stall this replaced.
    expect(elapsed).toBeLessThan(2000);
  });

  it('marks an endless import as looping so playback does not need the copies', () => {
    const shapes = parseSvgToShapes(cssSpinner(3), { maxDurationSeconds: 10 });
    for (const s of shapes) expect(s.animation!.loop).toBe('cycle');
  });
});
