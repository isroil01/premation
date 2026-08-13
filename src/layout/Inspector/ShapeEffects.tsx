/**
 * ShapeEffects — one consolidated inspector section for a shape layer's
 * procedural effects (Repeater, Path Operators incl. Trim). A SINGLE "+ Add"
 * menu is the one visible entry point (no three stacked per-effect "Add"
 * buttons); each effect's controls appear inline once added, and each self-
 * hides when absent. Keeps one home per action — no duplication.
 */

import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import {
  addPathOp, readPathOps, readTrimOp, readRepeaterOp, defaultTrimOp, defaultRepeaterOp,
} from '@core/scene/pathOps';
import { readNodeAudioWaveform, setAudioWaveform, defaultAudioWaveform } from '@core/audio/audioWaveformGen';
import { PathOpControls } from './PathOpControls';
import { AudioWaveformSection } from './AudioWaveformSection';
import styles from './TextAnimatorControls.module.css';

export function ShapeEffects({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || readNodeKind(node) !== 'shape') return null;

  const hasRepeater = !!readRepeaterOp(node);
  const hasTrim = !!readTrimOp(node);
  const hasAudioWave = !!readNodeAudioWaveform(node);

  const items: DropdownItem[] = [
    {
      type: 'item',
      id: 'add-pathop',
      label: 'Path Operator',
      icon: 'pen',
      // Deliberately NOT disabled once one exists. Operators chain, so adding a
      // second is the feature — this was `disabled: hasPathOp` when `fx.pathOp`
      // was a single slot, and leaving it would have kept the ceiling in the UI
      // after the model lost it.
      onSelect: () => addPathOp(nodeId),
    },
    {
      type: 'item',
      id: 'add-trim',
      label: 'Trim Paths',
      icon: 'shape',
      // One trim per layer, as in AE. It joins the SAME ordered chain as the
      // deformers rather than sitting in a fixed slot after them — which is why
      // it no longer has an inspector section of its own.
      disabled: hasTrim,
      onSelect: () => addPathOp(nodeId, defaultTrimOp()),
    },
    {
      type: 'item',
      id: 'add-repeater',
      label: 'Repeater',
      icon: 'layers',
      // One repeater per layer, as in AE. It joins the SAME ordered chain as
      // the deformers rather than sitting in a fixed slot after them — which is
      // why it no longer has an inspector section of its own (document 1.5.0).
      disabled: hasRepeater,
      onSelect: () => addPathOp(nodeId, defaultRepeaterOp()),
    },
    {
      type: 'item',
      id: 'add-audiowave',
      label: 'Audio Waveform',
      icon: 'audio',
      disabled: hasAudioWave,
      onSelect: () => setAudioWaveform(nodeId, defaultAudioWaveform()),
    },
  ];

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <Dropdown
          placement="left-start"
          trigger={
            <button type="button" className={styles.add} aria-label="Add shape effect">
              <Icon name="plus" size="sm" />
              <span>Add</span>
            </button>
          }
          items={items}
        />
      </div>
      {/* Neither `hasTrim` nor `hasRepeater` is tested separately any more —
          both ARE path ops, so `readPathOps(node).length` already counts them. */}
      {readPathOps(node).length === 0 && !hasAudioWave && (
        <div className={styles.empty}>Fan into copies, deform, trim the outline, or draw an audio waveform.</div>
      )}
      <PathOpControls nodeId={nodeId} />
      <AudioWaveformSection nodeId={nodeId} />
    </div>
  );
}

export default ShapeEffects;
