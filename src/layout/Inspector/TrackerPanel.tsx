import { useMemo, useState } from 'react';
import { useSelectionStore } from '@stores/selectionStore';
import { useMirrorLayer } from '@hooks/useMirror';
import { useActiveCompLayers } from '@hooks/useMirrorFields';
import { uiKindOf } from '@core/mirror/layerKinds';
import { TrackMotionSection } from './TrackMotionSection';
import styles from './CharacterPanel.module.css';

const isFootageKind = (kind: string | null): boolean => kind === 'video' || kind === 'image';

export function TrackerPanel(): JSX.Element {
  const selected = useSelectionStore((s) => s.ids);
  // Every layer of the active composition (the mirror, B4): re-renders when
  // the comp's stack or a listed layer's header changes.
  const compLayers = useActiveCompLayers();

  // Find all video layers in the current composition to offer as Motion Source
  const videoLayers = useMemo(
    () => compLayers.filter((l) => isFootageKind(uiKindOf(l))).map((l) => ({ id: l.id, name: l.name || l.id })),
    [compLayers],
  );

  const [chosenSourceId, setChosenSourceId] = useState<string | null>(null);

  // Determine active source layer: selected layer if video, or chosenSourceId, or first available video layer
  const primarySelected = selected[0] ?? null;
  const primaryLayer = useMirrorLayer(primarySelected);
  const isPrimaryVideo = isFootageKind(uiKindOf(primaryLayer));

  const activeSourceId = isPrimaryVideo ? primarySelected : (chosenSourceId ?? videoLayers[0]?.id ?? null);

  if (!activeSourceId) {
    return (
      <div className={styles.root}>
        <div className={styles.emptyHint}>
          No video or footage layer found in composition. Import a video footage file to use Motion Tracking, Camera Tracking, or Warp Stabilization.
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.col} style={{ marginBottom: 'var(--space-2)' }}>
        <span className={styles.sectionTitle}>Motion Source</span>
        <select
          value={activeSourceId}
          onChange={(e) => setChosenSourceId(e.target.value)}
          className={styles.fontSelect}
        >
          {videoLayers.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} {l.id === primarySelected ? '(Selected)' : ''}
            </option>
          ))}
        </select>
      </div>

      <TrackMotionSection nodeId={activeSourceId} />
    </div>
  );
}
