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
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { useAssetStore } from '@stores/assetStore';
import { assetIdOf, interpretationOf, type AlphaInterpretation } from '@core/source/sourceInfo';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import { getNodeHasSequence, getNodeSequenceLoop, setSequenceLoop } from '@core/scene/imageSequence';
import { audioEngine } from '@core/audio/AudioEngine';
import { readVideoAudioVoices, videoHasAudioTrack, VIDEO_AUDIO_LEVEL_PROP, VIDEO_AUDIO_MUTED_PROP } from '@core/audio/audioScene';
import { AUDIO_LEVEL_DB_PROP, MIN_LEVEL_DB, MAX_LEVEL_DB, percentToDb } from '@core/audio/audioParams';
import { KeyframeRow } from './KeyframeRow';
import { readNodeLayerTime } from '@core/scene/layerTime';
import { defaultAnimation } from '@motion/animation';
import { TimeRemapRow } from './PrecompControl';
import { customPrompt } from '@components/Modal';
import styles from './TransformSection.module.css';

export function MediaSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  // Alpha interpretation is per-FILE, so it keys off the asset, not the layer.
  const assetsRev = useAssetStore((st) => st.assets);
  const alphaNode = defaultSceneGraph.getNode(nodeId);
  const alphaAssetId = alphaNode ? assetIdOf(alphaNode) : null;
  const alphaMode: AlphaInterpretation = alphaAssetId
    ? interpretationOf(alphaAssetId).alpha
    : 'straight';
  // Only offered for footage that actually HAS an alpha channel. On opaque
  // footage the setting changes nothing, and a control that does nothing on
  // most of a project's media is the same noise as one nothing reads.
  // Undefined (browser build, or a still whose probe never ran) is treated as
  // "unknown" and the control is shown, because refusing to offer it would
  // leave a user with fringing and no recourse.
  const alphaAsset = alphaAssetId
    ? useAssetStore.getState().assets.find((a) => a.id === alphaAssetId)
    : undefined;
  const showAlpha = !!alphaAssetId && alphaAsset?.metadata?.hasAlpha !== false;
  void assetsRev; // subscription only — the value is read through interpretationOf
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
  const [audioLevelDb, setAudioLevelDb] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, AUDIO_LEVEL_DB_PROP);
  const [legacyPercent] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, VIDEO_AUDIO_LEVEL_PROP);
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
  // Real stream data when the import probe read the container; otherwise the
  // decode outcome, which is all a web import can offer. `probedAudio === false`
  // is the only case that justifies hiding the section outright — an unprobed
  // file that has simply not finished decoding must not look like a silent one.
  const probedAudio = isVideo && node ? videoHasAudioTrack(node) : null;
  const decodeState = audioAssetId ? audioEngine.decodeState(audioAssetId) : 'pending';
  const silent = probedAudio === false || (probedAudio === null && decodeState === 'silent');

  // Speed changes retime the PICTURE only — the audio path resamples nothing,
  // so a stretched, reversed or time-remapped clip would drift steadily out of
  // sync with no indication. Detected here and surfaced; the voice is muted in
  // `readVideoAudioVoices` so the two can never disagree about whether the
  // clip is audible.
  const layerTime = node ? readNodeLayerTime(node) : undefined;
  const remapped = node ? defaultAnimation.tracksFor(node.id).some((t) => t.prop === 'timeRemap' && t.keyframes.length > 0) : false;
  const speedAltered =
    (layerTime?.stretch !== undefined && Math.abs(layerTime.stretch - 100) > 0.01) ||
    layerTime?.reverse === true ||
    remapped;

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

      {/*
        Interpret Footage ▸ Alpha. The FIRST piece of interpretation UI — conform
        fps, pixel aspect and loop count are all read by the renderer but have
        never been settable, so this is where that starts rather than a fourth
        orphan.

        It has to be a manual control: nothing in a file records whether RGB was
        premultiplied. Probed against real files, a VP9/WebM alpha clip reports
        `pix_fmt: yuv420p`, ProRes 4444 `yuva444p12le`, PNG `rgba` — and not one
        of them says which convention the colour follows. So the default is
        Straight (correct for PNG, ProRes 4444 and WebM by their specs, and the
        existing behaviour) and this is the escape hatch for rendered elements,
        which is the material that carries no marker and is exactly what fringes.

        Written to the ASSET, so correcting a mis-tagged import fixes every layer
        using that file at once — including layers in other compositions.
      */}
      {showAlpha && alphaAssetId && (
        <InspectorRow label="Alpha">
          <select
            className={styles.presetChip}
            value={alphaMode}
            onChange={(e) => {
              useAssetStore.getState().setInterpretation(alphaAssetId, {
                alpha: e.currentTarget.value as AlphaInterpretation,
              });
              bumpScene();
            }}
            aria-label="How this footage's colour relates to its alpha"
            title="Premultiplied = the file's colour is already multiplied by its alpha (rendered elements, TGA). Straight = it is not (PNG, ProRes 4444, WebM)."
          >
            <option value="straight">Straight (Unmatted)</option>
            <option value="premultiplied">Premultiplied (Matted With Black)</option>
          </select>
        </InspectorRow>
      )}

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

          {!silent && (
            <>
              <h4 className={styles.title} style={{ marginTop: 12 }}>Audio</h4>
              {speedAltered ? (
                <p style={{ margin: '2px 0 6px', fontSize: 10, color: 'var(--color-warning, #d08a3a)', lineHeight: 1.5 }}>
                  Audio is muted because this layer&rsquo;s speed is changed. Time stretch, reverse and
                  time remap retime the picture only &mdash; nothing resamples the sound, so it would
                  drift out of sync. Trim the clip bar instead of changing speed to keep its audio.
                </p>
              ) : (
                <>
                  <KeyframeRow
                    nodeId={nodeId}
                    prop={AUDIO_LEVEL_DB_PROP}
                    label="Level"
                    value={Number(
                      audioLevelDb ?? (typeof legacyPercent === 'number' ? percentToDb(legacyPercent) : 0),
                    )}
                    unit="dB"
                    min={MIN_LEVEL_DB}
                    max={MAX_LEVEL_DB}
                    precision={1}
                    onStatic={(v) => setAudioLevelDb(v)}
                  />
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
                      : "Plays and exports with the layer's timeline bar — keyframe Level to duck under a voiceover."}
                  </p>
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

export default MediaSection;
