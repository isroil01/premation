/**
 * Shareable review links (spec §Collaboration V1). A review link encodes the
 * whole project — scene, animation, and comments — into the URL hash, so a
 * client can open it and see the exact composition with its timecoded notes.
 * No server required: the payload travels in the link itself.
 */

import { sceneProjectIO } from '@core/scene/sceneProjectIO';
import { defaultAnimation, type AnimSnapshot } from '@motion/animation';
import type { ProjectFile } from '@core/types';
import type { Comment } from '@stores/commentsStore';

export interface ReviewPayload {
  scene: ProjectFile;
  anim: AnimSnapshot;
  comments: Comment[];
  status: string;
  createdAt: number;
}

/** Base64-encode a UTF-8 JSON string (URL-safe enough for a hash). */
function encode(obj: unknown): string {
  const json = JSON.stringify(obj);
  const utf8 = encodeURIComponent(json).replace(/%([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return btoa(utf8);
}

function decode<T>(b64: string): T {
  const utf8 = atob(b64);
  const json = decodeURIComponent(Array.from(utf8).map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''));
  return JSON.parse(json) as T;
}

/** Build a shareable review link for the current project. */
export function buildReviewLink(comments: Comment[], status: string, at: number): string {
  const payload: ReviewPayload = {
    scene: sceneProjectIO.capture(),
    anim: defaultAnimation.snapshot(),
    comments,
    status,
    createdAt: at,
  };
  const base = `${location.origin}${location.pathname}`;
  return `${base}#review=${encode(payload)}`;
}

/** Read a review payload from the current URL hash, if present. */
export function readReviewFromUrl(): ReviewPayload | null {
  const m = /#review=([^&]+)/.exec(location.hash);
  if (!m) return null;
  try {
    return decode<ReviewPayload>(m[1]!);
  } catch {
    return null;
  }
}
