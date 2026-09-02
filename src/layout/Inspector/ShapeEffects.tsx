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
import { InspectorSection } from './InspectorSection';
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
    // The Add menu sits in the shared actions slot rather than in a `.head`
    // strip of its own. It is the same control, in the same corner, as the
    // path operators' move/remove and the layer styles' kebab — one place a
    // section's menu lives, so it can be aimed at without reading the section
    // first. The accordion already names this section, so no title here.
    <InspectorSection
      actions={
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
      }
    >
      {!hasAudioWave && (
        <div className={styles.empty}>Draw an audio waveform from a soundtrack on this shape.</div>
      )}
      <AudioWaveformSection nodeId={nodeId} />
    </InspectorSection>
  );
}

export default ShapeEffects;
