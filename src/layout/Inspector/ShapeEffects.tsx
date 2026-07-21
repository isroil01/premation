/**
 * ShapeEffects — one consolidated inspector section for a shape layer's
 * procedural effects (Repeater, Path Operator, Trim Paths). A SINGLE "+ Add"
 * menu is the one visible entry point (no three stacked per-effect "Add"
 * buttons); each effect's controls appear inline once added, and each self-
 * hides when absent. Keeps one home per action — no duplication.
 */

import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { readRepeaterConfig, setRepeater, defaultRepeater } from '@core/scene/repeater';
import { readPathOpConfig, setPathOp, defaultPathOp } from '@core/scene/pathOps';
import { readTrimConfig, setTrim, defaultTrim } from '@core/scene/trimPath';
import { readNodeAudioWaveform, setAudioWaveform, defaultAudioWaveform } from '@core/audio/audioWaveformGen';
import { RepeaterControls } from './RepeaterControls';
import { PathOpControls } from './PathOpControls';
import { TrimPathControls } from './TrimPathControls';
import { AudioWaveformSection } from './AudioWaveformSection';
import styles from './TextAnimatorControls.module.css';

export function ShapeEffects({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || readNodeKind(node) !== 'shape') return null;

  const hasRepeater = !!readRepeaterConfig(node);
  const hasPathOp = !!readPathOpConfig(node);
  const hasTrim = !!readTrimConfig(node);
  const hasAudioWave = !!readNodeAudioWaveform(node);

  const items: DropdownItem[] = [
    {
      type: 'item',
      id: 'add-pathop',
      label: 'Path Operator',
      icon: 'pen',
      disabled: hasPathOp,
      onSelect: () => setPathOp(nodeId, defaultPathOp()),
    },
    {
      type: 'item',
      id: 'add-trim',
      label: 'Trim Paths',
      icon: 'shape',
      disabled: hasTrim,
      onSelect: () => setTrim(nodeId, defaultTrim()),
    },
    {
      type: 'item',
      id: 'add-repeater',
      label: 'Repeater',
      icon: 'layers',
      disabled: hasRepeater,
      onSelect: () => setRepeater(nodeId, defaultRepeater()),
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
        <span className={styles.title}>Shape Effects</span>
        <Dropdown
          placement="left-start"
          trigger={
            <button type="button" className={styles.add} aria-label="Add shape effect">
              <Icon name="plus" size={12} />
              <span>Add</span>
            </button>
          }
          items={items}
        />
      </div>
      {!hasRepeater && !hasPathOp && !hasTrim && !hasAudioWave && (
        <div className={styles.empty}>Fan into copies, deform, trim the outline, or draw an audio waveform.</div>
      )}
      <PathOpControls nodeId={nodeId} />
      <TrimPathControls nodeId={nodeId} />
      <RepeaterControls nodeId={nodeId} />
      <AudioWaveformSection nodeId={nodeId} />
    </div>
  );
}

export default ShapeEffects;
