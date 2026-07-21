/**
 * Image-sequence footage — a numbered set of stills (frame_001.png, frame_002…)
 * played as one footage layer. The frame shown at any time is a pure function of
 * the layer's source time, so scrubbing is deterministic. Detection + frame
 * selection are pure and unit-tested; the render layer just swaps its `src` to
 * the resolved frame URL each frame.
 */

import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';

export interface ImageSequence {
  /** Frame source URLs in play order. */
  frames: string[];
  /** Playback frame rate of the sequence. */
  fps: number;
  /** Footage interpretation: loop the sequence instead of holding the last
   *  frame past the end (AE's Interpret Footage ▸ Loop). Default false. */
  loop?: boolean;
}

export interface DetectedSequence {
  /** Input names ordered by frame number. */
  frames: string[];
  /** A human label (the shared prefix). */
  base: string;
}

/**
 * Order a set of filenames as an image sequence by their trailing frame number.
 * Returns null unless at least two files carry a trailing number (before any
 * extension) — a single file, or unnumbered files, are not a sequence.
 */
export function detectImageSequence(names: readonly string[]): DetectedSequence | null {
  const parsed = names.map((name) => {
    const m = /^(.*?)(\d+)(\.[^.]+)?$/.exec(name);
    return m ? { name, num: Number(m[2]), prefix: m[1]! } : null;
  });
  if (parsed.length < 2 || parsed.some((p) => p === null)) return null;
  const items = parsed as { name: string; num: number; prefix: string }[];
  items.sort((a, b) => a.num - b.num);
  const base = items[0]!.prefix.replace(/[_.\-\s]+$/, '') || 'Sequence';
  return { frames: items.map((i) => i.name), base };
}

/**
 * The frame index to show at `sourceSec`. By default holds the last frame past
 * the end and clamps below zero; with `loop` it wraps modulo the frame count.
 * `count` is the number of frames.
 */
export function sequenceFrameAt(sourceSec: number, fps: number, count: number, loop = false): number {
  if (count <= 0) return 0;
  const i = Math.floor(Math.max(0, sourceSec) * fps);
  if (loop) return ((i % count) + count) % count;
  return i >= count ? count - 1 : i;
}

/** Read a node's image-sequence config off its `fx` component, or null. */
export function readNodeSequence(node: SceneNode): ImageSequence | null {
  const fx = node.components.find((c) => c.type === 'fx');
  const raw = fx?.props.sequence as Partial<ImageSequence> | undefined;
  if (!raw || !Array.isArray(raw.frames) || raw.frames.length === 0) return null;
  return {
    frames: raw.frames as string[],
    fps: typeof raw.fps === 'number' && raw.fps > 0 ? raw.fps : 30,
    loop: raw.loop === true,
  };
}

/** The source URL for a sequence at `sourceSec` (honours the loop flag). */
export function sequenceSrcAt(seq: ImageSequence, sourceSec: number): string {
  return seq.frames[sequenceFrameAt(sourceSec, seq.fps, seq.frames.length, seq.loop)]!;
}

/** Whether a node is an image-sequence footage layer. */
export function getNodeHasSequence(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  return !!node && readNodeSequence(node) !== null;
}

/** Current loop interpretation of a node's sequence (false when none). */
export function getNodeSequenceLoop(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  return (node && readNodeSequence(node)?.loop) === true;
}

/** Toggle the loop interpretation on a node's sequence. */
export function setSequenceLoop(nodeId: string, loop: boolean): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const seq = node && readNodeSequence(node);
  if (!seq) return;
  defaultSceneGraph.setImageSequence(nodeId, { ...seq, loop });
  bumpScene();
}
