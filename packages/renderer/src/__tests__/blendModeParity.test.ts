/**
 * BLEND_COMBINE must implement the same mode set in WGSL and GLSL.
 *
 * THE FAILURE THIS EXISTS FOR: a branch added to one dialect and missed in the
 * other passes on a WebGPU dev machine and renders wrong only on WebGL2 — and
 * "wrong" is `return cs`, the fallthrough, which looks like Normal rather than
 * like a crash. Nobody notices until a user on older hardware reports that one
 * blend mode "does nothing".
 *
 * The render-test gate cannot catch this either: it runs one backend per
 * invocation, and the WebGL2 pass compares against references blessed from
 * whichever backend was available.
 *
 * So the invariant is asserted on the SOURCE: every integer mode id that
 * `advancedBlendId` can emit must be handled in both dialects, and neither
 * dialect may handle an id the other does not.
 */

import { BUILTIN_SHADERS } from '../shaders/builtin';

const blend = BUILTIN_SHADERS.find((s) => s.name === 'blend-combine');

/** Mode ids `advancedBlendId()` emits (src/core/rendering/snapshotToFrameScene.ts).
 *  Duplicated deliberately: this file lives in the renderer package and must not
 *  import from the app, and a copy that drifts is exactly what the count test
 *  below catches. */
const EXPECTED_IDS = Array.from({ length: 30 }, (_, i) => i + 1);

/** Ids the dialect branches on, from `mode == N` / `mode >= N` comparisons. */
function handledIds(source: string): Set<number> {
  const ids = new Set<number>();
  for (const m of source.matchAll(/mode\s*==\s*(\d+)/g)) ids.add(Number(m[1]));
  // Range guards (`mode >= 12 && mode <= 15`) cover their span.
  for (const m of source.matchAll(/mode\s*>=\s*(\d+)\s*&&\s*mode\s*<=\s*(\d+)/g)) {
    for (let i = Number(m[1]); i <= Number(m[2]); i++) ids.add(i);
  }
  return ids;
}

describe('BLEND_COMBINE dialect parity', () => {
  it('the shader exists and carries both dialects', () => {
    expect(blend).toBeDefined();
    expect(blend!.wgsl).toBeTruthy();
    expect(blend!.glsl?.fragment).toBeTruthy();
  });

  it('handles every id advancedBlendId can emit, in WGSL', () => {
    const got = handledIds(blend!.wgsl!);
    expect(EXPECTED_IDS.filter((i) => !got.has(i))).toEqual([]);
  });

  it('handles every id advancedBlendId can emit, in GLSL', () => {
    const got = handledIds(blend!.glsl!.fragment);
    expect(EXPECTED_IDS.filter((i) => !got.has(i))).toEqual([]);
  });

  it('the two dialects handle exactly the same ids', () => {
    const w = handledIds(blend!.wgsl!);
    const g = handledIds(blend!.glsl!.fragment);
    const onlyWgsl = [...w].filter((i) => !g.has(i)).sort((a, b) => a - b);
    const onlyGlsl = [...g].filter((i) => !w.has(i)).sort((a, b) => a - b);
    expect({ onlyWgsl, onlyGlsl }).toEqual({ onlyWgsl: [], onlyGlsl: [] });
  });

  it('dispatches the non-separable family by RANGE, not by a >= threshold', () => {
    // The separable ids are non-contiguous (1-11 and 16-26). A bare `mode >= 12`
    // would route every M1 mode into the HSL branch and silently render them as
    // the wrong family — which is what the original code did before 16-26 were
    // appended. Both dialects must bound the range.
    expect(blend!.wgsl).toMatch(/mode\s*>=\s*12\s*&&\s*mode\s*<=\s*15/);
    expect(blend!.glsl!.fragment).toMatch(/mode\s*>=\s*12\s*&&\s*mode\s*<=\s*15/);
  });

  it('handles the alpha-writing utility modes past the composite line', () => {
    // 29/30 do not contribute a blended COLOUR — they change the Porter-Duff
    // line itself (Alpha Add rewrites ao; Luminescent Premul rewrites co). A
    // bChan branch for either would be silently wrong: it would produce a
    // plausible colour and leave alpha alone, which is the whole point of them.
    for (const src of [blend!.wgsl!, blend!.glsl!.fragment]) {
      expect(src).toMatch(/mode\s*==\s*29/);
      expect(src).toMatch(/mode\s*==\s*30/);
    }
  });

  it('routes the whole-colour compare modes outside the separable helper', () => {
    // 27/28 pick one colour outright by luminance; running them per channel
    // would mix channels and produce a colour that is in neither input.
    for (const src of [blend!.wgsl!, blend!.glsl!.fragment]) {
      expect(src).toMatch(/mode\s*==\s*27/);
      expect(src).toMatch(/mode\s*==\s*28/);
    }
  });
});
