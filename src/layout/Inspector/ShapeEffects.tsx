/**
 * ShapeEffects — audio-waveform generate on a shape layer.
 *
 * Path operators (Trim Paths, Zig-Zag, Repeater, …) live in the Effects &
 * Presets panel, next to the rest of the effect stack, so they are not a
 * second "add effect" home in the inspector.
 */

import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { readNodeAudioWaveform, setAudioWaveform, defaultAudioWaveform } from '@core/audio/audioWaveformGen';
import { AudioWaveformSection } from './AudioWaveformSection';
import styles from './TextAnimatorControls.module.css';

export function ShapeEffects({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || readNodeKind(node) !== 'shape') return null;

  const hasAudioWave = !!readNodeAudioWaveform(node);

  const items: DropdownItem[] = [
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
            <button type="button" className={styles.add} aria-label="Add audio waveform">
              <Icon name="plus" size="sm" />
              <span>Add</span>
            </button>
          }
          items={items}
        />
      </div>
      {!hasAudioWave && (
        <div className={styles.empty}>Draw an audio waveform from a soundtrack on this shape.</div>
      )}
      <AudioWaveformSection nodeId={nodeId} />
    </div>
  );
}

export default ShapeEffects;
