/**
 * Content-Aware Fill, editor side (AE parity 3.7): the engine job's request
 * and summary. The fill itself runs in premation-engine
 * (native/engine/src/jobs/kind_content_aware.cpp, content_aware_fill.cpp);
 * the panel (`layout/ContentAwareFill`) only builds the request.
 */

import { secondsToFlicks, type ContentAwareFillMode, type ContentAwareLighting, type JobSpec } from '@motion/engine-api';
import { requireEngineJob, startEngineJob, type EngineJobHandle } from '@core/engine/engineJobs';
import { t } from '@core/i18n';

export type { ContentAwareFillMode, ContentAwareLighting };

export interface ContentAwareReference {
  /** Composition seconds of the frame the plate was painted for. */
  time: number;
  /** A PNG of the whole frame, the footage's size. */
  src: string;
}

export interface ContentAwareFillRequest {
  layer: string;
  /** Composition seconds; `end` is exclusive. */
  start: number;
  end: number;
  fps: number;
  mode: ContentAwareFillMode;
  lighting: ContentAwareLighting;
  /** Grow (+) or shrink (−) the hole, in footage pixels. */
  expansion: number;
  references: readonly ContentAwareReference[];
  /** Fill the frame at `start` only, write it for painting, change nothing. */
  createReference?: boolean;
  /** Empty: next to the project, `Content-Aware Fill/`. */
  outputFolder?: string;
  /** The hole is this subject's matte (what a Separated subject left), not the masks; `expansion` 0 = the engine's default margin. */
  subject?: string;
}

export interface ContentAwareFillSummary {
  frames: number;
  filledPixels: number;
  synthesized: number;
  propagated: number;
  blended: number;
  fromReference: number;
  /** createReference: the written plate. */
  files: string[];
}

export const FILL_MODES: ReadonlyArray<{ value: ContentAwareFillMode; label: string; hint: string }> = [
  {
    value: 'object',
    get label() { return t('core.contentAwareFill.modeObject', 'Object'); },
    get hint() { return t('core.contentAwareFill.modeObjectHint', 'Removes an object: synthesises the hole from the frame and carries it through time.'); },
  },
  {
    value: 'surface',
    get label() { return t('core.contentAwareFill.modeSurface', 'Surface'); },
    get hint() { return t('core.contentAwareFill.modeSurfaceHint', 'For a surface (a wall, a road): carries the background through time, no synthesis.'); },
  },
  {
    value: 'edgeBlend',
    get label() { return t('core.contentAwareFill.modeEdgeBlend', 'Edge Blend'); },
    get hint() { return t('core.contentAwareFill.modeEdgeBlendHint', 'Blends the hole’s edge inward on every frame. Fast; for flat, untextured areas.'); },
  },
];

export const LIGHTING: ReadonlyArray<{ value: ContentAwareLighting; label: string }> = [
  { value: 'off', get label() { return t('core.contentAwareFill.lightingOff', 'Off'); } },
  { value: 'subtle', get label() { return t('core.contentAwareFill.lightingSubtle', 'Subtle'); } },
  { value: 'moderate', get label() { return t('core.contentAwareFill.lightingModerate', 'Moderate'); } },
  { value: 'strong', get label() { return t('core.contentAwareFill.lightingStrong', 'Strong'); } },
];

/** The engine job for a request. Pure. */
export function contentAwareFillJob(req: ContentAwareFillRequest): JobSpec {
  const frame = 1 / Math.max(1, req.fps);
  const end = req.createReference ? req.start + frame : Math.max(req.start + frame, req.end);
  return {
    kind: 'contentAwareFill',
    value: {
      layer: req.layer,
      range: { start: secondsToFlicks(req.start), duration: secondsToFlicks(end - req.start) },
      outputFolder: req.outputFolder ?? '',
      mode: req.mode,
      lighting: req.lighting,
      references: req.references.map((r) => ({ time: secondsToFlicks(r.time), src: r.src })),
      expansion: Number.isFinite(req.expansion) ? req.expansion : 0,
      createReference: req.createReference ?? false,
      ...(req.subject ? { subject: req.subject } : {}),
    },
  };
}

/** One line for the status area. */
export function contentAwareFillSummaryText(r: Partial<ContentAwareFillSummary> | null | undefined, reference: boolean): string {
  if (reference) {
    const file = r?.files?.[0];
    return file
      ? t('core.contentAwareFill.referenceWritten', 'Reference frame written to {file}. Paint the hole in an image editor, then add it as a reference.', { file })
      : t('core.contentAwareFill.noReference', 'No reference frame: the layer has no mask at the playhead.');
  }
  const frames = r?.frames ?? 0;
  if (frames === 0) return t('core.contentAwareFill.nothingToFill', 'Nothing to fill: draw a mask around what to remove first.');
  const parts = [
    r?.fromReference ? t('core.contentAwareFill.pxFromReferences', '{n} px from references', { n: r.fromReference }) : '',
    r?.propagated ? t('core.contentAwareFill.pxPropagated', '{n} px carried through time', { n: r.propagated }) : '',
    r?.synthesized ? t('core.contentAwareFill.pxSynthesized', '{n} px synthesised', { n: r.synthesized }) : '',
    r?.blended ? t('core.contentAwareFill.pxBlended', '{n} px blended', { n: r.blended }) : '',
  ].filter(Boolean);
  if (parts.length === 0) {
    return frames === 1
      ? t('core.contentAwareFill.filledOne', 'Filled {n} frame.', { n: frames })
      : t('core.contentAwareFill.filledOther', 'Filled {n} frames.', { n: frames });
  }
  const details = parts.join(', ');
  return frames === 1
    ? t('core.contentAwareFill.filledOneDetails', 'Filled {n} frame ({details}).', { n: frames, details })
    : t('core.contentAwareFill.filledOtherDetails', 'Filled {n} frames ({details}).', { n: frames, details });
}

/** Start the job. The fill is attached as one undo entry when it finishes (not for a reference). */
export async function startContentAwareFill(
  req: ContentAwareFillRequest,
  onProgress?: (fraction: number, message: string) => void,
): Promise<EngineJobHandle<ContentAwareFillSummary>> {
  return requireEngineJob(
    await startEngineJob<ContentAwareFillSummary>(contentAwareFillJob(req), { apply: !req.createReference, onProgress }),
    t('core.contentAwareFill.feature', 'Content-Aware Fill'),
  );
}
