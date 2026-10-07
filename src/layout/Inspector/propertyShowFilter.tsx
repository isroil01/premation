/**
 * The Properties footer's Show filter — After Effects' U / UU for the
 * inspector (2026-10-07).
 *
 * "Animated" lists only the properties with keyframes or an expression (U);
 * "Modified" adds every property whose value is set away from its default
 * (UU). Each listed property is drawn with the same row the rest of the
 * inspector uses (`MultiPropertyRow` for a number), so editing, keyframing and
 * multi-selection work as they do in its own section.
 *
 * Read from the document mirror: one row per PROPERTY (a Position's X and Y
 * are one row), hidden (advanced) properties left out.
 */

import { useMemo } from 'react';
import { PropertyRow } from '@components/PropertyRow';
import { documentMirror } from '@stores/documentMirror';
import { useThrottledTime } from '@stores/playbackClockStore';
import { useMirrorLayersWatch } from '@hooks/useMirror';
import { mirrorPropertyMeta } from '@core/mirror/metaFacts';
import { readTrack } from '@core/mirror/selection';
import { numbersOfValue, trackRefIn, tracksIn } from '@core/mirror/trackIndex';
import type { Value } from '@motion/engine-api';
import { MultiPropertyRow } from './MultiPropertyRow';
import panels from '@layout/EditorLayout/panels.module.css';
import tStyles from './TransformSection.module.css';

export type PropertyShow = 'all' | 'animated' | 'modified';

/** Whether two values are the same, numbers within a rounding hair. */
function sameValue(a: Value, b: Value): boolean {
  const na = numbersOfValue(a);
  const nb = numbersOfValue(b);
  if (na.length > 0 && na.length === nb.length) return na.every((v, i) => Math.abs(v - nb[i]!) < 1e-6);
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface PropertyCounts {
  total: number;
  animated: number;
  modified: number;
}

/**
 * The layer's properties for a Show mode, one track name per property, in the
 * tree's order — plus the counts the footer prints.
 */
export function propertiesForShow(nodeId: string, show: Exclude<PropertyShow, 'all'>): string[] {
  return classify(nodeId)[show];
}

export function propertyCounts(nodeId: string): PropertyCounts {
  const c = classify(nodeId);
  return { total: c.total, animated: c.animated.length, modified: c.modified.length };
}

function classify(nodeId: string): { total: number; animated: string[]; modified: string[] } {
  const m = documentMirror();
  const tree = m.layer(nodeId) ? m.tree(nodeId) : undefined;
  const seen = new Set<string>();
  const animated: string[] = [];
  const modified: string[] = [];
  let total = 0;
  for (const track of tracksIn(tree)) {
    const r = trackRefIn(tree, track);
    if (!r || seen.has(r.path) || r.info.hidden) continue;
    seen.add(r.path);
    total += 1;
    const keyed = m.keyframes(nodeId, r.path).length > 0 || r.info.expression !== '';
    if (keyed) animated.push(track);
    const v = r.info.value;
    const d = r.info.defaultValue;
    if (keyed || (v !== undefined && d !== undefined && !sameValue(v, d))) modified.push(track);
  }
  return { total, animated, modified };
}

/** The rows a Show filter lists, drawn in place of the sections. */
export function FilteredPropertyList({ nodeId, show }: { nodeId: string; show: Exclude<PropertyShow, 'all'> }): JSX.Element | null {
  // The layer's header, tree and keyframes: a new key or a reset re-lists.
  const watchIds = useMemo(() => [nodeId], [nodeId]);
  useMirrorLayersWatch(watchIds);
  const time = useThrottledTime();
  const m = documentMirror();
  const layer = m.layer(nodeId);
  if (!layer) return null;
  const tracks = propertiesForShow(nodeId, show);
  if (tracks.length === 0) {
    return (
      <p className={panels.sectionNote}>
        {show === 'animated' ? 'No animated properties on this layer.' : 'Every property is at its default.'}
      </p>
    );
  }
  return (
    <div className={tStyles.inlineRows}>
      {tracks.map((track) => (readTrack(m, nodeId, track, time) !== undefined
        ? <MultiPropertyRow key={track} nodeId={nodeId} prop={track} />
        : (
          <PropertyRow
            key={track}
            label={mirrorPropertyMeta(track, layer, m.tree(nodeId)).label}
            compact
            layout="inspector"
          >
            <span className={panels.groupCount}>Edit in its own section</span>
          </PropertyRow>
        )))}
    </div>
  );
}
