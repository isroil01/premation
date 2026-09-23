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
import { useSceneRevision } from '@stores/sceneStore';
import { useAssetStore } from '@stores/assetStore';
import { assetIdOf, interpretationOf, type AlphaInterpretation } from '@core/source/sourceInfo';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useComponentProp } from './useComponentProp';
import { edit, reportEngineError } from '@core/engine/uiEdits';
import { isLayer } from '@core/engine/doc';
import { getNodeHasSequence, getNodeSequenceLoop } from '@core/scene/imageSequence';
import { values } from '@core/engine/propRefs';
import { engine } from '@core/engine/engineInstance';
import { audioEngine } from '@core/audio/AudioEngine';
import { readVideoAudioVoices, videoHasAudioTrack, speedAltersAudio, VIDEO_AUDIO_LEVEL_PROP, VIDEO_AUDIO_MUTED_PROP } from '@core/audio/audioScene';
import {
  AUDIO_LEVEL_DB_PROP, MIN_LEVEL_DB, MAX_LEVEL_DB, percentToDb,
  AUDIO_PAN_PROP, MIN_PAN, MAX_PAN,
} from '@core/audio/audioParams';
import { KeyframeRow } from './KeyframeRow';
import { RetimeSection } from './RetimeSection';
import { ProxyRow } from './ProxyRow';
import { customPrompt } from '@components/Modal';
import styles from './TransformSection.module.css';

/**
 * AE's Replace Footage with a FILE: re-point the layer at the matching library
 * item, or import the file first (`importFiles` by path) and re-point at the new
 * item — one engine gesture, one undo entry ("Replace Footage"): the second
 * command needs the item id the first one returns. Keeps keyframes, effects,
 * masks and size (`keepSize`).
 */
export async function replaceFootageFromPath(nodeId: string, path: string): Promise<boolean> {
  const label = 'Replace Footage';
  const match = useAssetStore.getState().assets.find((a) => a.src === path);
  if (match) {
    const res = await edit(label, { type: 'replaceLayerSource', layer: nodeId, source: match.id, keepSize: true });
    return res.ok;
  }
  const client = engine();
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    reportEngineError(label, opened.error);
    return false;
  }
  let ok = false;
  const imported = await client.execute({ type: 'importFiles', files: [{ path, asSequence: false, createComposition: false }] });
  const item = imported.ok ? (imported.value as { items?: string[] }).items?.[0] : undefined;
  if (!imported.ok) reportEngineError(label, imported.error);
  if (item) {
    const res = await client.execute({ type: 'replaceLayerSource', layer: nodeId, source: item, keepSize: true });
    if (res.ok) ok = true;
    else reportEngineError(label, res.error);
  }
  const closed = await client.endGesture(opened.value.gesture, ok);
  if (!closed.ok) reportEngineError(label, closed.error);
  return ok;
}

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

  const [src] = useComponentProp(nodeId, tComp?.id, 'src');

  // A video layer's own audio track. Level/mute live on the same component; the
  // sound itself is scheduled by the AudioEngine off the layer's clip bar (see
  // audioScene.readVideoAudioVoices).
  const [audioLevelDb, setAudioLevelDb] = useComponentProp(nodeId, tComp?.id, AUDIO_LEVEL_DB_PROP);
  const [legacyPercent] = useComponentProp(nodeId, tComp?.id, VIDEO_AUDIO_LEVEL_PROP);
  const [audioMuted] = useComponentProp(nodeId, tComp?.id, VIDEO_AUDIO_MUTED_PROP);
  const [audioPan, setAudioPan] = useComponentProp(nodeId, tComp?.id, AUDIO_PAN_PROP);

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

  // Freeze mutes audio (held frame). Time remap expands into varispeed
  // segments — see audioRetimeSegments. Stretch/reverse use playbackRate.
  const speedAltered = node ? speedAltersAudio(node) : false;

  if (!node || !tComp) return null;

  /** Point the layer at `path`, keeping its keyframes, effects and masks. */
  const applyReplace = (path: string) => {
    if (!isLayer(nodeId)) return;
    void replaceFootageFromPath(nodeId, path);
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
              void edit('Interpret Footage', {
                type: 'setInterpretation',
                items: [alphaAssetId],
                patch: { alpha: e.currentTarget.value as AlphaInterpretation },
              });
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
            // The per-LAYER loop flag (`layer/sequenceLoop`, a B3z layer field).
            onChange={(e) => {
              void edit('Loop Sequence', {
                type: 'setProperty',
                prop: { layer: nodeId, path: 'layer/sequenceLoop' },
                value: values.bool(e.currentTarget.checked),
              });
            }}
            aria-label="Loop image sequence"
          />
        </InspectorRow>
      )}

      {/* Proxy: per-FILE like Alpha above, so it keys off the asset. Video only
          — a still has no seek cost to avoid. */}
      {isVideo && alphaAssetId && (
        <>
          <h4 className={styles.title} style={{ marginTop: 12 }}>Proxy</h4>
          <ProxyRow assetId={alphaAssetId} />
        </>
      )}

      {isVideo && (
        <>
          <RetimeSection nodeId={nodeId} />

          {!silent && (
            <>
              <h4 className={styles.title} style={{ marginTop: 12 }}>Audio</h4>
              {speedAltered ? (
                <p style={{ margin: '2px 0 6px', fontSize: 'var(--font-size-micro)', color: 'var(--color-warning, #d08a3a)', lineHeight: 1.5 }}>
                  Audio is muted while freeze frame is on — a held picture has no
                  continuous soundtrack. Time remap, stretch and reverse keep audio
                  in sync (varispeed). Clear freeze to hear sound.
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
                  <KeyframeRow
                    nodeId={nodeId}
                    prop={AUDIO_PAN_PROP}
                    label="Pan"
                    value={typeof audioPan === 'number' ? audioPan : 0}
                    unit="%"
                    min={MIN_PAN}
                    max={MAX_PAN}
                    // A centred pan is stored as ABSENT by the engine's audio seam.
                    onStatic={(v) => setAudioPan(v)}
                  />
                  <InspectorRow label="Mute" align="center">
                    <Switch
                      checked={audioMuted === true}
                      // AE's Audio switch (`setLayerSwitches` audioEnabled — stored as this mute flag).
                      onChange={(e) => {
                        if (!isLayer(nodeId)) return;
                        void edit(e.currentTarget.checked ? 'Mute Audio' : 'Unmute Audio', {
                          type: 'setLayerSwitches', layers: [nodeId], patch: { audioEnabled: !e.currentTarget.checked },
                        });
                      }}
                      aria-label="Mute this video's audio track"
                    />
                  </InspectorRow>
                  <p style={{ margin: '2px 0 6px', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
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
