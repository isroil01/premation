/**
 * When the RAM preview may be SERVED, and when it may be FILLED.
 *
 * Extracted for the reason `idleCacheSpan` was: the decision lives in the
 * middle of the viewport's render loop, where a condition that is subtly too
 * wide shows up as wrong pixels on screen and a condition that is subtly too
 * narrow shows up as nothing at all — and neither is visible from in there.
 *
 * ## What was wrong
 *
 * Both halves used to be `if (playing)`. Scrubbing back over a fully green
 * region therefore re-rendered every frame from scratch: not a cache that
 * missed, a cache nobody asked. And the only paused WRITER was the idle pump,
 * which needs 1.5s of quiet — an active scrub re-arms that timer on every move,
 * so a scrub could never leave anything behind either.
 *
 * ## Why the gate existed, and what it should actually have said
 *
 * The hazard is real and narrower than the gate was. An interactive repaint can
 * happen MID-GESTURE without bumping any revision, so the invalidation key does
 * not move while the picture does. Filling then stores a half-dragged frame to
 * be blitted back later; serving then paints the pre-gesture frame over a live
 * drag. `interacting` is exactly that condition, and the render-quality store
 * already tracks it — so a SETTLED playhead, which is the whole of scrubbing
 * between gestures, is as cacheable as playback ever was.
 *
 * Three further conditions, each of which cost a real bug when reasoned about
 * in situ rather than written down:
 *
 * **Onion skins.** A paused-only feature that renders its ghosts INTO the
 * content canvas. Serving a blit skips the painter entirely, so the ghosts
 * silently vanish wherever the cache happens to be warm — which looks exactly
 * like the feature being broken, and only on some frames.
 *
 * **The frame grid.** Cache keys are frame indices, but a paused render draws
 * `time`, and `setTime` stores whatever it is given — its callers round the
 * FRAME they pass alongside and are free to leave the time between two of them.
 * Playback never has this problem, because it renders `f / fps` exactly, which
 * is why nothing checked. Serving frame 31 to a playhead at 1.017s, or filing
 * that render under 31, is a sub-frame lie that surfaces as footage one frame
 * out from everything else.
 *
 * **Media exactness.** A frame holding stand-in video pixels (an element
 * mid-seek, a decode still warming) must never enter the cache, or it replays
 * its stale footage at that timecode on every later pass. This one was already
 * enforced on the playback path; it is stated here so both paths share one
 * definition instead of two copies that can drift.
 */

/** How close to a frame boundary still counts as being on it. Three orders of
 *  magnitude under a frame at any sane rate, and far above float noise from
 *  `frame / fps` round trips. */
const GRID_EPSILON = 1e-3;

export interface PreviewCacheState {
  /** Transport state. Playback always renders on the grid and never mid-gesture. */
  playing: boolean;
  /** A drag/scrub gesture is in flight (render-quality store). */
  interacting: boolean;
  /** Onion skins are on — they paint into the content canvas. */
  onionSkins: boolean;
  /** Playhead, in seconds, as the render will draw it. */
  timeSec: number;
  fps: number;
  /** The integer frame the cache key uses for this playhead. */
  frame: number;
}

/**
 * Is `timeSec` actually the frame the key names?
 *
 * Exported because it is the condition most likely to be got wrong somewhere
 * else, and a test of it reads better than a test of the whole gate.
 */
export function isOnFrameGrid(timeSec: number, fps: number, frame: number): boolean {
  if (!(fps > 0) || !Number.isFinite(timeSec) || !Number.isFinite(frame)) return false;
  return Math.abs(timeSec * fps - frame) < GRID_EPSILON;
}

/** May a cached frame be blitted instead of rendering this one? */
export function mayServeCachedFrame(s: PreviewCacheState): boolean {
  if (s.playing) return true;
  if (s.interacting) return false;
  if (s.onionSkins) return false;
  return isOnFrameGrid(s.timeSec, s.fps, s.frame);
}

/**
 * Cached frames a PLAYBACK blit must have ahead of it before it is worth
 * taking.
 *
 * ## The toggle storm this exists to stop
 *
 * Serving a cache hit during playback is not free: the blit path bypasses
 * `renderFrame` entirely, so it also has to PARK the playback `<video>`
 * elements (at the end of the cached run) to keep their decoders tracking the
 * playhead. The live path, one frame later, needs those same elements AT the
 * playhead. Alternate between the two paths every frame and the element is
 * park-seeked and then immediately demanded back — a hard mid-GOP seek, which
 * freezes; while its decode is in flight the exact tier deliberately serves
 * the nearest ALREADY-DECODED neighbour (an old frame, `exact: false`) and
 * repaints as the real ones land, which fast-passes.
 *
 * Freeze → old frames → rapid catch-up: the "old disk" playback report, and it
 * is the SHAPE of the cache that causes it, not its contents. At 4K on a
 * hi-dpi display RAM holds ~16 frames, so the cached set is fragmented — an
 * isolated hit, a gap, another hit — and every fragment boundary is one of
 * these toggles. An isolated one-frame hit saves one render and costs a seek:
 * strictly worse than rendering it live.
 *
 * So a playback blit requires a RUN: this many cached frames ahead of the one
 * being served. Runs exist precisely when the cache is genuinely useful (a
 * warmed second pass, disk promotion keeping ahead of the playhead) and do not
 * exist in the fragmented case that causes the storm. Near the end of a real
 * run this renders a few frames live that were technically cached — a small
 * waste, paid to never enter the blit path for a fragment. Paused serving is
 * unaffected: with no playhead advancing there is no next-frame toggle, so a
 * single paused hit is pure win.
 *
 * Three frames (~100ms at 30fps) is one video-element seek's worth of runway —
 * enough that parking the element at the run's end is a real instruction
 * rather than "seek to now" issued sixty times a second.
 */
export const MIN_PLAYBACK_BLIT_RUN = 3;

/**
 * Is this playback hit worth blitting, given where its cached run ends?
 *
 * `contiguousEnd` is `FrameCache.contiguousEnd(frame)`: the last frame of the
 * unbroken cached run containing `frame` (or `frame` itself when isolated).
 */
export function playbackBlitWorthwhile(frame: number, contiguousEnd: number): boolean {
  return contiguousEnd - frame >= MIN_PLAYBACK_BLIT_RUN;
}

/**
 * May the frame just rendered by a PAUSED pass be stored?
 *
 * `mediaExact` is `lastFrameMediaExact() !== false` — false only when the
 * renderer knows it drew stand-in footage.
 */
export function mayFillFromPausedRender(
  s: Omit<PreviewCacheState, 'playing' | 'onionSkins'> & { mediaExact: boolean },
): boolean {
  if (s.interacting) return false;
  if (!s.mediaExact) return false;
  return isOnFrameGrid(s.timeSec, s.fps, s.frame);
}
