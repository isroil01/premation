/**
 * A layer's stored member keyframe lists (the engine's `getMemberKeyframes`,
 * src/stores/memberTracks.ts), re-read when the layer's keys, tree or header
 * change in the mirror and when the answer lands. Undefined before the first
 * answer.
 */

import { useSyncExternalStore } from 'react';
import { memberTracksNow, memberTracksVersion, subscribeMemberTracks, type MemberKeys } from '@stores/memberTracks';
import { useMirrorKeys } from './useMirror';

export function useMemberTracks(layer: string | null | undefined): readonly MemberKeys[] | undefined {
  useMirrorKeys(layer ? [`keys:${layer}`, `tree:${layer}`, `layer:${layer}`] : []);
  useSyncExternalStore(subscribeMemberTracks, memberTracksVersion, memberTracksVersion);
  return layer ? memberTracksNow(layer) : undefined;
}
