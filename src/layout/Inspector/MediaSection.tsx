/**
 * Media Source — the file a picture layer points at, plus the playback controls
 * that actually reach the renderer.
 *
 * Deliberately small. This section used to also offer Fit Mode, four Crop
 * fields, Speed, Start Offset, Loop and Muted. Not one of them was read by
 * anything: the renderer never looked up `fitMode` or the crop props, and the
 * video element sets `loop`/`muted` unconditionally in `AppTextureProvider`
 * rather than from the node. They were removed rather than wired because the
 * editor already does each job properly somewhere else — Time Remap (below) for
 * speed and start offset, a mask for cropping, and layer size for fit. Wiring a
 * second, weaker path to each would have been the worse of the two fixes.
 */

import { useEffect, useMemo, useState } from 'react';
import { InspectorRow } from '@components/Inspector';
import { Switch } from '@components/Switch';
import { Slider } from '@components/Slider';
import { useSceneRevision } from '@stores/sceneStore';
import { useAssetStore } from '@stores/assetStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import { getNodeHasSequence, getNodeSequenceLoop, setSequenceLoop } from '@core/scene/imageSequence';
import { audioEngine } from '@core/audio/AudioEngine';
import { readVideoAudioVoices, VIDEO_AUDIO_LEVEL_PROP, VIDEO_AUDIO_MUTED_PROP } from '@core/audio/audioScene';
import { TimeRemapRow } from './PrecompControl';
import { customPrompt } from '@components/Modal';
import styles from './TransformSection.module.css';

export function MediaSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);

  // No early return above this line: every hook below has to run on every
  // render, including the ones for a node that has just been deleted.
  const tComp = useMemo(() => node?.components.find((c) => c.type === 'Transform'), [node]);
  const isVideo = !!node?.components.some(
    (c) => c.type === 'video' || c.id.startsWith('video') || (tComp && tComp.props.__kind === 'video'),
  );

  const [src, setSrc] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'src');
  // The renderer resolves assetId ahead of src (buildSnapshot), and the timeline
  // bounds media clips by the asset's duration — so a replace has to re-point
  // both or the layer keeps resolving the old asset.
  const [, setAssetId] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'assetId');
  const [, setAudioAssetId] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, '__assetId');

  // A video layer's own audio track. Level/mute live on the same component; the
  // sound itself is scheduled by the AudioEngine off the layer's clip bar (see
  // audioScene.readVideoAudioVoices).
  const [audioLevel, setAudioLevel] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, VIDEO_AUDIO_LEVEL_PROP);
  const [audioMuted, setAudioMuted] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, VIDEO_AUDIO_MUTED_PROP);

  // Kick the decode so the section can report whether this file has sound at
  // all, and re-render when the engine settles.
  const [, setDecodeTick] = useState(0);
  useEffect(() => audioEngine.onChange(() => setDecodeTick((n) => n + 1)), []);
  const audioVoice = isVideo && node ? readVideoAudioVoices(node)[0] : undefined;
  const audioAssetId = audioVoice?.assetId;
  const audioSrc = audioVoice?.src;
  useEffect(() => {
    if (audioAssetId && audioSrc) void audioEngine.load(audioAssetId, audioSrc);
  }, [audioAssetId, audioSrc]);
  const decodeState = audioAssetId ? audioEngine.decodeState(audioAssetId) : 'pending';

  if (!node || !tComp) return null;

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

      {getNodeHasSequence(nodeId) && (
        <InspectorRow label="Loop Sequence" align="center">
          <Switch
            checked={getNodeSequenceLoop(nodeId)}
            onChange={(e) => setSequenceLoop(nodeId, e.currentTarget.checked)}
            aria-label="Loop image sequence"
          />
        </InspectorRow>
      )}

      {isVideo && (
        <>
          <h4 className={styles.title} style={{ marginTop: 12 }}>Playback</h4>
          <TimeRemapRow nodeId={nodeId} />

          <h4 className={styles.title} style={{ marginTop: 12 }}>Audio</h4>
          {decodeState === 'silent' ? (
            <p style={{ margin: '2px 0 6px', fontSize: 10, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
              This file has no audio track the player can decode, so the layer is silent.
            </p>
          ) : (
            <>
              <InspectorRow label="Level" align="center">
                <Slider
                  value={Number(audioLevel ?? 100)}
                  min={0}
                  max={200}
                  step={1}
                  showValue
                  onChange={(v) => setAudioLevel(v)}
                />
              </InspectorRow>
              <InspectorRow label="Mute" align="center">
                <Switch
                  checked={audioMuted === true}
                  onChange={(e) => setAudioMuted(e.currentTarget.checked || undefined)}
                  aria-label="Mute this video's audio track"
                />
              </InspectorRow>
              <p style={{ margin: '2px 0 6px', fontSize: 10, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
                {decodeState === 'pending'
                  ? 'Decoding the audio track…'
                  : "Plays and exports with the layer's timeline bar — trim or split the bar to trim the sound."}
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

export default MediaSection;
