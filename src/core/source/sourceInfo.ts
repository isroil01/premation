/**
 * Sources — the one abstraction behind "a layer that shows something authored
 * elsewhere".
 *
 * A composition placed as a layer and a piece of imported footage are the same
 * shape of thing: both have an **intrinsic size** and an **intrinsic time** of
 * their own, both are placed into a host comp that may disagree with either, and
 * both need the host to decide how to reconcile the two. The composition
 * boundary already learned this for comps (`compSizeOf`, the recursive
 * `buildSnapshot` for a sealed instance). Footage arrived without it, which is
 * why a 4K clip lands at native size overflowing a 1080 frame and why a 24fps
 * source is bracketed on the comp's rate.
 *
 * So there is ONE `SourceInfo` and one resolver, not a footage path beside a
 * comp path. Everything that needs to reason about "what is this layer actually
 * showing, and at what size and rate" asks here.
 *
 * **Interpretation is stored on the ASSET, not the layer.** Re-interpreting
 * footage (its real frame rate, its alpha, its pixel aspect) is a statement
 * about the file, so changing it updates every layer using that footage at
 * once — which is what After Effects' Interpret Footage does, and what makes it
 * safe to fix a mis-tagged import after you have already cut with it. Per-layer
 * overrides are deliberately absent: two layers of one file disagreeing about
 * what the file *is* has no correct rendering.
 */

import type { SceneNode } from '@core/types';
import { readNodeKind } from '@core/scene/sceneDerive';
import { useAssetStore } from '@stores/assetStore';
import { readCompRef } from '@core/scene/compInstance';

/**
 * Per-FILE reinterpretation. Every field is optional: absent means "believe
 * the file", which is what every existing project implicitly says.
 *
 * Alpha interpretation lives here too, as `alpha`. It is READ by the renderer
 * (premultiplied sources take a dedicated shader variant that divides the
 * premultiplication back out before grading), so it is a real setting rather
 * than a stored-and-ignored one. Matte colour is black-only — see §21.
 */
export interface FootageInterpretation {
  /**
   * Play the source as if it were shot at this rate. Distinct from the probed
   * rate: probing tells us what the file says, conform overrides it (24 → 25
   * PAL pulldown, 30 → 24 for a slow-mo look).
   */
  conformFps?: number;
  /** Pixel aspect ratio. >1 = stored pixels are wider than tall (anamorphic,
   *  DV). Applied to WIDTH to get square-pixel display size. */
  par?: number;
  /** How many times the source plays before it ends. 1 = once (default);
   *  0 = forever. This is where the dead Media-panel `loop` prop belongs. */
  loopCount?: number;
  /**
   * How the source's RGB relates to its alpha (After Effects' Interpret Footage
   * ▸ Alpha).
   *
   * `straight` (default) = RGB is the unmatted colour; the compositor multiplies
   * by alpha on the way to the screen. `premultiplied` = RGB has ALREADY been
   * multiplied by alpha against a black matte, so it must be divided back out
   * first or it gets multiplied twice and soft edges darken into a fringe.
   *
   * ## Why this cannot be detected, and therefore defaults to straight
   *
   * Nothing in the file records it. Probed against real files: a VP9/WebM alpha
   * clip reports `pix_fmt: yuv420p` (its alpha is a container tag), ProRes 4444
   * reports `yuva444p12le`, PNG `rgba`, TGA `bgra` — and not one of them, in
   * `pix_fmt`, stream tags or side-data, says whether RGB was premultiplied. It
   * is a convention carried out of band.
   *
   * Straight is the right default: it is what PNG mandates, what Apple's ProRes
   * 4444 spec says, and what VP9/WebM alpha is — and it is the existing
   * behaviour, so no project changes when this lands. Premultiplied is
   * characteristic of RENDERED elements (After Effects' own "Premultiplied"
   * output setting, TGA, some TIFF/EXR), which is exactly the material that
   * carries no marker. Hence a user-set override rather than a guess.
   *
   * Only a BLACK matte is supported; see §21.
   */
  alpha?: AlphaInterpretation;
  /**
   * Interlaced footage's field order (After Effects' Interpret Footage ▸
   * Separate Fields). Absent = progressive, which is every modern file and the
   * pre-existing behaviour. Like `alpha`, this is a user-stated fact: files do
   * not reliably record their field order, and DV/tape-era formats disagree
   * about which field leads. The renderer removes combing by rebuilding the
   * other field from the kept one (see `rendering/deinterlace.ts` for exactly
   * what is and is not implemented).
   */
  fields?: 'upper' | 'lower';
}

/** Interpret Footage ▸ Alpha. Ignore and Invert Alpha are not implemented —
 *  see §21 for why they are filed rather than stubbed. */
export type AlphaInterpretation = 'straight' | 'premultiplied';

/** What a layer is showing, normalized across footage, stills and comps. */
export interface SourceInfo {
  kind: 'footage' | 'image' | 'comp';
  /** Identity of the underlying source (asset id, or comp root id). */
  id: string;
  /** Display size in SQUARE pixels — stored size with PAR applied. This is the
   *  size fit commands and auto-fit reason about, because it is what the user
   *  sees. */
  width: number;
  height: number;
  /** Size as stored in the file, before PAR. */
  storedWidth: number;
  storedHeight: number;
  /** Intrinsic length in seconds, or null when the source is generative /
   *  unbounded (a still, or a comp whose record we could not resolve). */
  durationSec: number | null;
  /** Effective rate after conform, or null when genuinely unknown — the browser
   *  cannot report a `<video>`'s frame rate, so this stays null until the
   *  desktop ffmpeg probe fills it in. Callers must handle null rather than
   *  substituting the comp's rate silently. */
  fps: number | null;
  par: number;
  loopCount: number;
  /** How RGB relates to alpha. See FootageInterpretation.alpha — nothing in a
   *  file records this, so it is always the user's setting or the default. */
  alpha: AlphaInterpretation;
  /** Field order for interlaced footage; absent = progressive. Like `alpha`,
   *  always the user's setting. See FootageInterpretation.fields. */
  fields?: 'upper' | 'lower';
}

/** The comp facts `sourceOf` needs. Injected, because the renderer must not
 *  import the project store (see `compSizes`). */
export interface CompSourceLookup {
  (compRootId: string): { width: number; height: number; fps: number; durationSeconds: number } | undefined;
}

/** The asset id a media layer points at — scanned across every component, last
 *  write wins, exactly like the renderer's own `readBase`. Audio and picture
 *  resolving to different files is the one failure this must never allow. */
export function assetIdOf(node: SceneNode): string | null {
  let id: string | null = null;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    if (typeof p.assetId === 'string' && p.assetId) id = p.assetId;
    if (typeof p.__assetId === 'string' && p.__assetId) id = p.__assetId;
  }
  return id;
}

/** Stored interpretation for a file, with defaults filled in. */
export function interpretationOf(assetId: string): Required<Omit<FootageInterpretation, 'conformFps' | 'fields'>> & { conformFps?: number; fields?: 'upper' | 'lower' } {
  const asset = useAssetStore.getState().assets.find((a) => a.id === assetId);
  const i = asset?.interpret ?? {};
  return {
    ...(i.conformFps !== undefined ? { conformFps: i.conformFps } : {}),
    par: i.par ?? 1,
    loopCount: i.loopCount ?? 1,
    // Straight is both the AE default and the EXISTING behaviour, so nothing
    // renders differently until someone sets this deliberately.
    alpha: i.alpha ?? 'straight',
    // Validated rather than passed through: a stored value that is neither
    // field order must read as progressive, not as a truthy mystery string.
    ...(i.fields === 'upper' || i.fields === 'lower' ? { fields: i.fields } : {}),
  };
}

/** Source facts for a footage or still layer, or null when it has no asset. */
export function footageSourceOf(node: SceneNode): SourceInfo | null {
  const assetId = assetIdOf(node);
  if (!assetId) return null;
  const asset = useAssetStore.getState().assets.find((a) => a.id === assetId);
  if (!asset) return null;

  const i = interpretationOf(assetId);
  const storedWidth = asset.metadata?.width ?? 0;
  const storedHeight = asset.metadata?.height ?? 0;
  const duration = asset.metadata?.duration;
  // Conform wins over the probed rate — that is the entire point of conform.
  const fps = i.conformFps ?? asset.metadata?.fps ?? null;

  return {
    kind: asset.type === 'image' ? 'image' : 'footage',
    id: assetId,
    // PAR stretches horizontally: a 720×576 DV frame at PAR 1.42 displays 1024
    // wide. Height is never touched, which is the convention every NLE uses.
    width: Math.round(storedWidth * i.par),
    height: storedHeight,
    storedWidth,
    storedHeight,
    durationSec: typeof duration === 'number' && duration > 0 ? duration : null,
    fps: fps !== null && fps > 0 ? fps : null,
    par: i.par,
    loopCount: i.loopCount,
    alpha: i.alpha,
    ...(i.fields ? { fields: i.fields } : {}),
  };
}

/**
 * Source facts for ANY layer that shows something authored elsewhere —
 * composition instance, footage or still. Null for generative layers (shapes,
 * text, nulls), which have no source and no intrinsic size.
 *
 * `compLookup` is required to resolve comp sources; without it a comp instance
 * returns null rather than guessing, which is what keeps a caller that has no
 * project store from silently reporting a comp as the host's size.
 */
export function sourceOf(node: SceneNode, compLookup?: CompSourceLookup): SourceInfo | null {
  const kind = readNodeKind(node);

  if (kind === 'comp') {
    const ref = readCompRef(node);
    if (!ref || !compLookup) return null;
    const c = compLookup(ref);
    if (!c) return null;
    return {
      kind: 'comp',
      id: ref,
      width: c.width,
      height: c.height,
      storedWidth: c.width,
      storedHeight: c.height,
      // A composition's intrinsic time is its own duration — the fact that made
      // comps unbounded on the timeline while footage was bounded.
      durationSec: c.durationSeconds > 0 ? c.durationSeconds : null,
      fps: c.fps > 0 ? c.fps : null,
      par: 1,
      loopCount: 1,
      // A composition is rendered by us, into a straight-alpha target. There is
      // no file convention to reinterpret, so it is straight by construction.
      alpha: 'straight',
    };
  }

  if (kind === 'video' || kind === 'image' || kind === 'svg') return footageSourceOf(node);
  return null;
}

/**
 * Map a time in SOURCE seconds through the source's loop count.
 *
 * `loopCount` 1 passes straight through (and past the end stays past the end,
 * so the clip simply runs out). 0 loops forever. Anything else wraps until the
 * count is exhausted and then holds at the final frame rather than snapping
 * back to black, which is what makes a looped background usable as a backdrop.
 */
export function applyLoop(sourceSec: number, durationSec: number | null, loopCount: number): number {
  if (!durationSec || durationSec <= 0 || loopCount === 1 || sourceSec < durationSec) return sourceSec;
  const pass = Math.floor(sourceSec / durationSec);
  if (loopCount !== 0 && pass >= loopCount) {
    // Exhausted: hold the last frame.
    return durationSec - 1e-6;
  }
  return sourceSec - pass * durationSec;
}
