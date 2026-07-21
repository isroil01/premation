import { useMemo } from 'react';
import { ValueField } from '@components/ValueField';
import { InspectorRow } from '@components/Inspector';
import { Switch } from '@components/Switch';
import { useSceneRevision } from '@stores/sceneStore';
import { useAssetStore } from '@stores/assetStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import { getNodeHasSequence, getNodeSequenceLoop, setSequenceLoop } from '@core/scene/imageSequence';
import { TimeRemapRow } from './PrecompControl';
import { customPrompt } from '@components/Modal';
import styles from './TransformSection.module.css';

export function MediaSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);

  if (!node) return null;

  const tComp = useMemo(() => node.components.find((c) => c.type === 'Transform'), [node]);
  const isVideo = node.components.some((c) => c.type === 'video' || c.id.startsWith('video') || (tComp && tComp.props.__kind === 'video'));

  // Media Source and Fit Props on Transform component
  const [src, setSrc] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'src');
  const [fitMode, setFitMode] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'fitMode');
  // The renderer resolves assetId ahead of src (buildSnapshot), and the timeline
  // bounds media clips by the asset's duration — so a replace has to re-point
  // both or the layer keeps resolving the old asset.
  const [, setAssetId] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'assetId');
  const [, setAudioAssetId] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, '__assetId');

  // Crop offsets
  const [cropTop, setCropTop] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'cropTop');
  const [cropRight, setCropRight] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'cropRight');
  const [cropBottom, setCropBottom] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'cropBottom');
  const [cropLeft, setCropLeft] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'cropLeft');

  // Video specific playback properties
  const [speed, setSpeed] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'speed');
  const [startOffset, setStartOffset] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'startOffset');
  const [loop, setLoop] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'loop');
  const [muted, setMuted] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'muted');

  if (!tComp) return null;

  /** Point the layer at `path`, keeping its keyframes, effects and masks. */
  const applyReplace = (path: string) => {
    setSrc(path);
    // Re-point to the matching library asset when the new source is one, and
    // clear the id otherwise so src wins instead of the stale asset.
    const match = useAssetStore.getState().assets.find((a) => a.src === path);
    setAssetId(match?.id);
    setAudioAssetId(match?.id);
  };

  const handleReplace = async () => {
    // Check if Electron is available, else request standard import/replace or mock
    if (window.electronAPI?.project?.open) {
      try {
        const file = await window.electronAPI.project.open();
        if (file) {
          applyReplace(file.path);
        }
      } catch (err) {
        console.error('Failed to open Electron file dialog:', err);
      }
    } else {
      // Browser fallback: trigger a prompt/alert
      const path = await customPrompt('Replace Media Source', 'Enter image/video URL or file path:', String(src ?? ''));
      if (path !== null) {
        applyReplace(path);
      }
    }
  };

  const getFileName = (pathStr: string) => {
    if (!pathStr) return 'No file selected';
    return pathStr.split(/[\\/]/).pop() ?? pathStr;
  };

  return (
    <div className={styles.section}>
      <h4 className={styles.title}>{isVideo ? 'Video Source' : 'Image Source'}</h4>
      
      <div className={styles.mediaSrcRow}>
        <span className={styles.mediaFileName} title={String(src ?? '')}>
          {getFileName(String(src ?? ''))}
        </span>
        <button type="button" onClick={handleReplace} className={styles.presetChip}>
          Replace
        </button>
      </div>

      <InspectorRow label="Fit Mode" align="center">
        <select
          value={String(fitMode ?? 'fill')}
          onChange={(e) => setFitMode(e.target.value)}
          className={styles.select}
        >
          <option value="fill">Fill</option>
          <option value="fit">Fit</option>
          <option value="stretch">Stretch</option>
          <option value="none">None</option>
        </select>
      </InspectorRow>

      {getNodeHasSequence(nodeId) && (
        <InspectorRow label="Loop Sequence" align="center">
          <Switch
            checked={getNodeSequenceLoop(nodeId)}
            onChange={(e) => setSequenceLoop(nodeId, e.currentTarget.checked)}
            aria-label="Loop image sequence"
          />
        </InspectorRow>
      )}

      <h4 className={styles.title} style={{ marginTop: 12 }}>Crop</h4>
      <InspectorRow label="Crop Top" align="center">
        <ValueField value={Number(cropTop ?? 0)} unit="px" onChange={(v) => setCropTop(v)} />
      </InspectorRow>
      <InspectorRow label="Crop Right" align="center">
        <ValueField value={Number(cropRight ?? 0)} unit="px" onChange={(v) => setCropRight(v)} />
      </InspectorRow>
      <InspectorRow label="Crop Bottom" align="center">
        <ValueField value={Number(cropBottom ?? 0)} unit="px" onChange={(v) => setCropBottom(v)} />
      </InspectorRow>
      <InspectorRow label="Crop Left" align="center">
        <ValueField value={Number(cropLeft ?? 0)} unit="px" onChange={(v) => setCropLeft(v)} />
      </InspectorRow>

      {isVideo && (
        <>
          <h4 className={styles.title} style={{ marginTop: 12 }}>Playback</h4>
          <TimeRemapRow nodeId={nodeId} />
          <InspectorRow label="Speed" align="center">
            <ValueField value={Number(speed ?? 1)} unit="x" onChange={(v) => setSpeed(v)} />
          </InspectorRow>
          <InspectorRow label="Start Offset" align="center">
            <ValueField value={Number(startOffset ?? 0)} unit="s" onChange={(v) => setStartOffset(v)} />
          </InspectorRow>
          <InspectorRow label="Loop" align="center">
            <Switch checked={!!loop} onChange={(e) => setLoop(e.currentTarget.checked)} aria-label="Loop video" />
          </InspectorRow>
          <InspectorRow label="Muted" align="center">
            <Switch checked={!!muted} onChange={(e) => setMuted(e.currentTarget.checked)} aria-label="Mute video" />
          </InspectorRow>
        </>
      )}
    </div>
  );
}

export default MediaSection;
