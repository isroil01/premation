/**
 * PinnedSection — the layer's own shortlist, on the Pinned sub-tab.
 *
 * Two sources, one list: properties the user pinned from a row's menu
 * (`__pinnedProps`, stored in the document) and properties promoted as
 * Essential Properties on the layer's composition root. Both are facts about
 * the PROJECT — a collaborator opening the file sees the same tab — which is
 * why neither lives in preferences.
 *
 * Numeric properties are drawn as full rows (stopwatch, navigator, expression
 * toggle, lane, multi-selection editing) through `MultiPropertyRow`; a pinned
 * property the value seam cannot read as a number is listed by name with a
 * note, so a pin is never silently dropped from the tab it was pinned to.
 */

import { useMemo } from 'react';
import { Icon } from '@components/Icon';
import { PropertyRow } from '@components/PropertyRow';
import { essentialPropsOf, setPinnedProp, type PinnedEntry } from '@core/inspector/pinnedProps';
import { useThrottledTime } from '@stores/playbackClockStore';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorLayersWatch } from '@hooks/useMirror';
import { mirrorPropertyMeta } from '@core/mirror/metaFacts';
import { readTrack } from '@core/mirror/selection';
import { MultiPropertyRow } from './MultiPropertyRow';
import styles from '@layout/EditorLayout/panels.module.css';
import tStyles from './TransformSection.module.css';
import rowStyles from './MultiPropertyRow.module.css';

/** A track's label on this layer (the registry, fed mirror facts). */
function labelOf(nodeId: string, prop: string): string {
  const m = documentMirror();
  const layer = m.layer(nodeId);
  return mirrorPropertyMeta(prop, layer, layer ? m.tree(nodeId) : undefined).label;
}

/**
 * The tab's rows: the layer's own pins (`LayerInfo.pinned`, in pin order), then
 * the Essential Properties promoted from it that are not also pinned (the twin
 * of `pinnedEntriesFor`).
 */
export function pinnedEntriesOf(nodeId: string): PinnedEntry[] {
  const pins = documentMirror().layer(nodeId)?.pinned ?? [];
  // B4-gap: the Essential Properties published on the composition (`__essentialProps` on its root) — no API datum
  // (a `CompInfo.essentialProps` would close it; CompOverridesSection has the same gap).
  const essentials = new Set(essentialPropsOf(nodeId));
  const out: PinnedEntry[] = pins.map((prop) => ({ prop, pinned: true, essential: essentials.has(prop) }));
  for (const prop of essentials) {
    if (!pins.includes(prop)) out.push({ prop, pinned: false, essential: true });
  }
  return out;
}

/** The tab exists only when it would list something (the registry's `appliesTo`). */
export function hasPinnedSection(nodeId: string): boolean {
  return pinnedEntriesOf(nodeId).length > 0;
}

function UnpinButton({ nodeId, prop }: { nodeId: string; prop: string }): JSX.Element {
  return (
    <button
      type="button"
      className={rowStyles.exprToggle}
      aria-label={`Unpin ${labelOf(nodeId, prop)}`}
      title="Unpin"
      onClick={(e) => {
        e.stopPropagation();
        setPinnedProp(nodeId, prop, false);
      }}
    >
      <Icon name="close" size="sm" />
    </button>
  );
}

function PinnedRow({ nodeId, entry, time }: { nodeId: string; entry: PinnedEntry; time: number }): JSX.Element {
  const numeric = readTrack(documentMirror(), nodeId, entry.prop, time) !== undefined;
  const label = labelOf(nodeId, entry.prop);
  const hint = entry.essential ? 'Essential' : undefined;
  if (numeric) {
    return (
      <MultiPropertyRow
        nodeId={nodeId}
        prop={entry.prop}
        hint={hint}
        extraTrailing={entry.pinned ? <UnpinButton nodeId={nodeId} prop={entry.prop} /> : undefined}
      />
    );
  }
  return (
    <PropertyRow
      label={label}
      hint={hint}
      pinned={entry.pinned}
      compact
      // Same grid as the numeric rows beside it (MultiPropertyRow picks the
      // inspector layout from its host); without this the name column of a
      // non-numeric pin sat 20px off every other row in the section.
      layout="inspector"
      trailing={entry.pinned ? <UnpinButton nodeId={nodeId} prop={entry.prop} /> : undefined}
    >
      <span className={styles.groupCount}>Edit in its own section</span>
    </PropertyRow>
  );
}

export function PinnedSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  // B4: the layer's header (its pins), property tree and keyframes.
  const watchIds = useMemo(() => [nodeId], [nodeId]);
  useMirrorLayersWatch(watchIds);
  const time = useThrottledTime();
  if (!documentMirror().layer(nodeId)) return null;
  const entries = pinnedEntriesOf(nodeId);
  if (entries.length === 0) {
    return <p className={styles.sectionNote}>Nothing pinned. Right-click any property and choose “Pin to Pinned tab”.</p>;
  }
  return (
    <div className={tStyles.inlineRows}>
      {entries.map((e) => (
        <PinnedRow key={e.prop} nodeId={nodeId} entry={e} time={time} />
      ))}
    </div>
  );
}

export default PinnedSection;
