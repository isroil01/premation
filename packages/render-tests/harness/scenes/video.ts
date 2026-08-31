/**
 * Video footage — the one scene in this suite whose pixels come out of a
 * DECODER.
 *
 * ## Why the suite needed this
 *
 * Every other scene draws shapes, text or rasters. Nothing exercised
 * `exactVideoFrames` → `AppTextureProvider.setFrame` → `writeTexture`, so the
 * golden gate had a hole exactly where the video pipeline lives: the cached
 * frame representation, the upload source kind and the premultiply branch each
 * backend takes for it could all change with no committed pixel to disagree.
 *
 * That hole is why this scene was added before touching the frame cache's
 * storage type, and it is the coverage the composited-frame-cache work depends
 * on too — a cache whose correctness argument is "the golden images are
 * byte-identical" needs a golden image that contains footage.
 *
 * ## The fixture
 *
 * `fixtures/videoClip.mp4` — 24 frames, 640x360, H.264 yuv420p, GOP 8 (keys at
 * 0, 8, 16), no audio, no B-frames, 4 KB. Content is a hard-edged orange bar
 * translating 24px per frame over a flat blue field, with a green band across
 * the bottom: every frame is unmistakably different from its neighbours, the
 * edges are vertical so a half-pixel sampling error is visible, and the flat
 * regions make a colour-space or premultiply change obvious rather than subtle.
 *
 * Inlined as a `data:` URL (`?inline`) rather than emitted as a file. The
 * harness page loads over `file://`, and Chromium refuses `fetch()` on a
 * `file:` URL — which is the call `exactVideoFrames`' loader makes. A file
 * asset would therefore push the source to sticky `unavailable` and quietly
 * test the `<video>` element fallback instead of the decoder this scene exists
 * to cover.
 *
 * ## The frames chosen
 *
 * 5 and 13 are both MID-GOP, so serving them requires decoding a real GOP
 * prefix from the preceding keyframe rather than handing back a keyframe.
 * `animates` asserts they differ, which is what proves the presentation index
 * actually reached the compositor — a decoder stuck on one frame passes every
 * "did it render something" check ever written.
 */

import { defineScene, node } from '../sceneKit';
import clipUrl from '../fixtures/videoClip.mp4?inline';

const W = 640;
const H = 360;

/** Frame 5 and frame 13 — both mid-GOP (keyframes are at 0, 8 and 16). */
const MID_GOP_FRAMES = [5, 13];

function videoLayer() {
  return node('clip', {
    kind: 'video',
    position: { x: W / 2, y: H / 2 },
    transform: { src: clipUrl, width: W, height: H },
    style: { opacity: 100 },
  });
}

export const videoScenes = [
  defineScene({
    id: 'video-decoded-frame',
    description:
      'One decoded H.264 frame (mid-GOP) uploaded and composited — the video decode → texture path.',
    size: { w: W, h: H },
    // Magenta: nothing in the clip is anywhere near it, so a frame that failed
    // to decode reads as a full-frame miss instead of a plausible picture.
    comp: { width: W, height: H, background: '#ff00ff' },
    fps: 24,
    frames: MID_GOP_FRAMES,
    // No Canvas2D oracle exists for footage — the reference is blessed from the
    // GPU output and must be eyeballed once, like every other 'gpu' scene.
    oracle: 'gpu',
    // WebGL2 IS the oracle here and matches the reference exactly, so this stays
    // a gating scene.
    //
    // WebGPU is 1.274% off the same reference, and that is recorded as a debt in
    // `webgpu-baseline.json` rather than suppressed here, because it is not this
    // scene's subject. Measured mechanism: the final 8-bit encode differs by at
    // most 7 levels, always in the darkest channel of a flat region — the blue
    // field reads rgb(15,33,63) on WebGL2 and rgb(15,33,65) on WebGPU, the
    // orange bar rgb(255,135,33) against rgb(255,134,26), the green band
    // rgb(36,175,128) against rgb(36,175,127). Uniform across each flat region
    // rather than concentrated at edges, so it is an encode difference and not a
    // sampling one; independent of alpha (every frame here is opaque, the exact
    // loader refusing alpha WebM outright), so not a premultiply one either.
    // Same linear-vs-display-referred rounding as the additive-family
    // divergences this suite already carries.
    //
    // This scene is built of large flat fields with hard vertical edges, which
    // is the worst possible shape for a pixel-COUNT metric: a one-level shift
    // covers most of the frame while being invisible. That is the right shape
    // for catching a decode or upload regression, which is what it is for.
    gpuParity: 'expect-pass',
    // The two frames are 8 source frames apart and the bar moves 24px per
    // frame, so a correct render differs across most of the width.
    animates: true,
    animatesMinChange: 0.05,
    build(graph) {
      graph.addNode(videoLayer());
    },
  }),
];
