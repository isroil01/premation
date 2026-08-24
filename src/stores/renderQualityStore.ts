/**
 * Preview render quality — two orthogonal levers, both trading fidelity for
 * playback speed:
 *
 *  - `draft`      skips the expensive motion-blur multi-sample pass.
 *  - `resolution` renders fewer pixels (Full/Half/Third/Quarter), the way
 *                 After Effects' viewer resolution does — the content canvas is
 *                 sized down by this divisor and the browser upscales it. This
 *                 is the lever users reach for when preview drops frames; it was
 *                 the one thing missing, so `draft` (motion blur only) was the
 *                 whole quality story.
 */

import { create } from 'zustand';

/** 1 = Full, 2 = Half, 3 = Third, 4 = Quarter. */
export type PreviewResolution = 1 | 2 | 3 | 4;

export const RESOLUTION_LABELS: Record<PreviewResolution, string> = {
  1: 'Full',
  2: 'Half',
  3: 'Third',
  4: 'Quarter',
};

/** The pixel fraction each resolution renders — shown next to the label so it's
 *  clear this is a quality/speed lever, not a size change. */
export const RESOLUTION_PERCENT: Record<PreviewResolution, string> = {
  1: '100%',
  2: '50%',
  3: '33%',
  4: '25%',
};

/**
 * Adaptive Resolution — AE's Fast Previews default.
 *
 * While the user is DRAGGING (a gizmo, the playhead, a value field) the
 * picture is a moving target nobody inspects closely; when they let go it is
 * the thing they look at. So the viewport renders at `adaptiveFloor` during a
 * drag and snaps back to `resolution` on release. A manual Half/Quarter still
 * wins when it is already coarser than the floor — the user asked for less,
 * and adapting must never give them more than they chose.
 *
 * `interacting` is set by the UI store's drag flag (see `bindAdaptiveResolution`)
 * rather than by every pointer handler individually, because the drag flag is
 * already set by all of them — one subscription, not thirty edits.
 */
export type AdaptiveFloor = 2 | 3 | 4;

interface RenderQualityStore {
  draft: boolean;
  resolution: PreviewResolution;
  /** Off → the viewport never changes resolution on its own. Default on. */
  adaptive: boolean;
  /** The resolution a drag drops to. Default Half. */
  adaptiveFloor: AdaptiveFloor;
  /** True while a drag is in flight. Driven, not user-set. */
  interacting: boolean;
  /**
   * True while PLAYBACK cannot keep up — the viewport's render loop reports
   * each frame's cost, and a run of frames over budget flips this on; a run
   * under budget (at the degraded size) or stopping playback flips it off.
   * The first pass over a heavy comp then plays at a lower resolution instead
   * of at a lower frame rate; the RAM preview fills from that pass, and the
   * second pass is a blit. Driven, not user-set.
   */
  slowPlayback: boolean;
  setDraft: (v: boolean) => void;
  toggle: () => void;
  setResolution: (r: PreviewResolution) => void;
  setAdaptive: (v: boolean) => void;
  setAdaptiveFloor: (f: AdaptiveFloor) => void;
  setInteracting: (v: boolean) => void;
  setSlowPlayback: (v: boolean) => void;
  /**
   * Report one rendered frame's cost while playing. `ms` is the render time,
   * `budgetMs` the frame period. Returns nothing; updates `slowPlayback` by
   * hysteresis so a single hitch neither drops quality nor restores it.
   */
  reportPlaybackFrame: (ms: number, budgetMs: number) => void;
  /**
   * What the viewport should render at RIGHT NOW — the one value renderers
   * read. `resolution` is what the user chose; this is that, degraded while a
   * drag is in flight.
   */
  effectiveResolution: () => PreviewResolution;
  /** Stable string that changes when quality changes (render key). */
  key: () => string;
}

export function effectiveResolutionOf(s: {
  resolution: PreviewResolution; adaptive: boolean; adaptiveFloor: AdaptiveFloor; interacting: boolean; slowPlayback?: boolean;
}): PreviewResolution {
  if (!s.adaptive || !(s.interacting || s.slowPlayback)) return s.resolution;
  return Math.max(s.resolution, s.adaptiveFloor) as PreviewResolution;
}

/** Frames over budget before degrading, and under budget before restoring. */
const SLOW_FRAMES_TO_DEGRADE = 3;
const FAST_FRAMES_TO_RESTORE = 45;
let overBudget = 0;
let underBudget = 0;

export const useRenderQualityStore = create<RenderQualityStore>((set, get) => ({
  draft: false,
  resolution: 1,
  adaptive: true,
  adaptiveFloor: 2,
  interacting: false,
  slowPlayback: false,
  setDraft: (v) => set({ draft: v }),
  toggle: () => set((s) => ({ draft: !s.draft })),
  setResolution: (r) => set({ resolution: r }),
  setAdaptive: (v) => set({ adaptive: v }),
  setAdaptiveFloor: (f) => set({ adaptiveFloor: f }),
  setInteracting: (v) => set((s) => (s.interacting === v ? s : { interacting: v })),
  setSlowPlayback: (v) => {
    overBudget = 0;
    underBudget = 0;
    set((s) => (s.slowPlayback === v ? s : { slowPlayback: v }));
  },
  reportPlaybackFrame: (ms, budgetMs) => {
    const s = get();
    if (!s.adaptive) return;
    // A frame is "slow" when it alone eats more than the whole frame period —
    // at that point playback is already dropping frames, and a lower
    // resolution that holds the rate is the better picture.
    if (ms > budgetMs) { overBudget++; underBudget = 0; }
    else { underBudget++; overBudget = 0; }
    if (!s.slowPlayback && overBudget >= SLOW_FRAMES_TO_DEGRADE) {
      overBudget = 0;
      set({ slowPlayback: true });
    } else if (s.slowPlayback && underBudget >= FAST_FRAMES_TO_RESTORE) {
      // Restoring is conservative: at the degraded size frames are cheap, so
      // "under budget" here says little about full-res cost. Once restored,
      // three slow frames bring it straight back down — the cycle settles on
      // whatever the comp can actually sustain.
      underBudget = 0;
      set({ slowPlayback: false });
    }
  },
  effectiveResolution: () => effectiveResolutionOf(get()),
  key: () => `${get().draft ? 'd' : 'f'}${effectiveResolutionOf(get())}`,
}));

/**
 * Hook the drag flag up. Called once at boot. Returns the unsubscribe.
 *
 * The release is DEBOUNCED by one frame: a drag that ends and a new one that
 * begins within the same tick (a quick re-grab) should not cause a full-res
 * render in between, which on a heavy comp is the stall users feel as "the
 * gizmo sticks". The degrade is immediate — there is nothing to wait for.
 */
export function bindAdaptiveResolution(
  subscribeDrag: (cb: (dragging: boolean) => void) => () => void,
): () => void {
  let release: ReturnType<typeof setTimeout> | null = null;
  const unsub = subscribeDrag((dragging) => {
    if (dragging) {
      if (release) { clearTimeout(release); release = null; }
      useRenderQualityStore.getState().setInteracting(true);
    } else {
      if (release) clearTimeout(release);
      release = setTimeout(() => {
        release = null;
        useRenderQualityStore.getState().setInteracting(false);
      }, 32);
    }
  });
  return () => {
    if (release) clearTimeout(release);
    unsub();
  };
}
