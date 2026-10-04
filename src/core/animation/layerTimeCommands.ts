/**
 * Layer ▸ Time — the footage verbs as COMMANDS: Time-Reverse Layer, Freeze
 * Frame at playhead, Freeze On Last Frame, Time Stretch…, Enable/Remove Time
 * Remapping, and the frame-blend modes.
 *
 * Every one of these already existed as a switch somewhere — the Compositing
 * section's Time group, the viewport's right-click Video submenu — but the
 * application menu's Time entry listed two speed ramps and nothing else, so
 * the menu (and the command palette that reads it) said the editor could not
 * reverse or freeze footage. After Effects keeps all of these under
 * Layer ▸ Time; so does this. The writes go through the same
 * `updateNodeLayerTime` / time-remap track the switches use, so the two
 * surfaces cannot disagree.
 *
 * ── TIME STRETCH AND THE CLIP BAR ──────────────────────────────────────────
 * Stretch used to change the playback rate and nothing else: the bar kept its
 * length, so a 200 % layer ran out of bar half-way through its footage, and
 * there was no way to say WHICH moment should stay put. AE's dialog asks for
 * a Hold in Place point (in-point, current frame, out-point); the bar scales
 * about that frame and the source frame showing there is unchanged. See
 * `stretchClipGeometry` for the derivation — clip bars are FRAMES, the stretch
 * is applied on top of the clip map in SOURCE seconds, anchored at the
 * keyframe span start, exactly as `compToKeyframeTime` composes them.
 */

// The Time Stretch maths moved to ./timeStretch (the engine's timeStretchLayers
// runs it too); every name stays importable from here.
export {
  clampStretch,
  clampSignedStretch,
  holdFrameFor,
  stretchClipGeometry,
  bakeStretchGeometry,
  retimeKeys,
  
  
  type ClipGeometry,
  type StretchBake,
  type StretchHold,
} from './timeStretch';

// ── Freeze On Last Frame ────────────────────────────────────────────────────

/**
 * AE's Freeze On Last Frame, as keyframe times: identity from the layer's
 * in-point to its last frame, then a HOLD on that frame. `span` is in frames,
 * end exclusive, so the last visible frame is `end − 1`.
 */
export function lastFrameHoldKeys(span: { start: number; end: number }, fps: number): { inSec: number; lastSec: number } {
  const lastFrame = Math.max(span.start, span.end - 1);
  return { inSec: span.start / fps, lastSec: lastFrame / fps };
}
