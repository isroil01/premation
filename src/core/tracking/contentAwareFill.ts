/**
 * Content-Aware Fill, editor side (AE parity 3.7): the engine job's request
 * and summary. The fill itself runs in premation-engine
 * (native/engine/src/jobs/kind_content_aware.cpp, content_aware_fill.cpp);
 * the panel (`layout/ContentAwareFill`) only builds the request.
 */

import { secondsToFlicks, type ContentAwareFillMode, type ContentAwareLighting, type JobSpec } from '@motion/engine-api';
import { requireEngineJob, startEngineJob, type EngineJobHandle } from '@core/engine/engineJobs';

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
  { value: 'object', label: 'Object', hint: 'Removes an object: synthesises the hole from the frame and carries it through time.' },
  { value: 'surface', label: 'Surface', hint: 'For a surface (a wall, a road): carries the background through time, no synthesis.' },
  { value: 'edgeBlend', label: 'Edge Blend', hint: 'Blends the hole’s edge inward on every frame. Fast; for flat, untextured areas.' },
];

export const LIGHTING: ReadonlyArray<{ value: ContentAwareLighting; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'subtle', label: 'Subtle' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'strong', label: 'Strong' },
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
    },
  };
}

/** One line for the status area. */
export function contentAwareFillSummaryText(r: Partial<ContentAwareFillSummary> | null | undefined, reference: boolean): string {
  if (reference) {
    const file = r?.files?.[0];
    return file
      ? `Reference frame written to ${file}. Paint the hole in an image editor, then add it as a reference.`
      : 'No reference frame: the layer has no mask at the playhead.';
  }
  const frames = r?.frames ?? 0;
  if (frames === 0) return 'Nothing to fill: draw a mask around what to remove first.';
  const parts = [
    r?.fromReference ? `${r.fromReference} px from references` : '',
    r?.propagated ? `${r.propagated} px carried through time` : '',
    r?.synthesized ? `${r.synthesized} px synthesised` : '',
    r?.blended ? `${r.blended} px blended` : '',
  ].filter(Boolean);
  return `Filled ${frames} frame${frames === 1 ? '' : 's'}${parts.length ? ` (${parts.join(', ')})` : ''}.`;
}

/** Start the job. The fill is attached as one undo entry when it finishes (not for a reference). */
export async function startContentAwareFill(
  req: ContentAwareFillRequest,
  onProgress?: (fraction: number, message: string) => void,
): Promise<EngineJobHandle<ContentAwareFillSummary>> {
  return requireEngineJob(
    await startEngineJob<ContentAwareFillSummary>(contentAwareFillJob(req), { apply: !req.createReference, onProgress }),
    'Content-Aware Fill',
  );
}
