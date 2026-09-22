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

import { Icon } from '@components/Icon';
import { PropertyRow } from '@components/PropertyRow';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { resolvePropertyMeta } from '@core/inspector/propertyMeta';
import { pinnedEntriesFor, setPinnedProp, type PinnedEntry } from '@core/inspector/pinnedProps';
import { useNodeRevision } from '@hooks/useNodeRevision';
import { readPropertyValue } from '@core/inspector/multiSelection';
import { useThrottledTime } from '@stores/playbackClockStore';
import { MultiPropertyRow } from './MultiPropertyRow';
import styles from '@layout/EditorLayout/panels.module.css';
import tStyles from './TransformSection.module.css';
import rowStyles from './MultiPropertyRow.module.css';

function UnpinButton({ nodeId, prop }: { nodeId: string; prop: string }): JSX.Element {
  return (
    <button
      type="button"
      className={rowStyles.exprToggle}
      aria-label={`Unpin ${resolvePropertyMeta(prop, nodeId).label}`}
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
  const numeric = readPropertyValue(nodeId, entry.prop, time) !== undefined;
  const meta = resolvePropertyMeta(entry.prop, nodeId);
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
      label={meta.label}
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
  useNodeRevision(nodeId);
  const time = useThrottledTime();
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const entries = pinnedEntriesFor(nodeId);
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
