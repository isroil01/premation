/**
 * Footage preview — look at a clip BEFORE committing it to the comp.
 *
 * AE's footage viewer, sized to this app: double-clicking a clip in the
 * project panel opens it for scrubbing, and the actions that would commit it
 * (add to comp, new comp from it) sit in the footer. Until now double-click
 * INSERTED — which meant the only way to check "is this the right take?" was
 * to add it, look, and undo. A library you cannot look inside is a folder of
 * guesses.
 *
 * TWO transports, honestly split. The native `<video controls>` remains the
 * default: it plays realtime with audio, and its scrub promises exactly the
 * approximate seeking it delivers. "Frame by frame" switches the stage to the
 * exact decode path (@core/video: mp4box demux → WebCodecs) where stepping
 * lands on true frame boundaries — the first consumer of the real decoder,
 * exactly as this header used to promise. The mode is offered only when the
 * platform has WebCodecs and the clip demuxes; anything else falls back to
 * the player with a note instead of dressing imprecision as precision.
 */

import { useEffect, useRef, useState } from 'react';
import { openModal } from '@stores/modalStore';
import { Button } from '@components/Button';
import { insertMedia } from '@core/scene/sceneInsert';
import { insertMediaAtPlayhead, retargetLayerSource, replaceableSelectedLayer } from '@core/scene/footageWorkflow';
import { createCompositionFromFootage } from '@core/composition/compositionOps';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { demuxMp4 } from '@core/video/mp4Demuxer';
import { ExactVideoSource, webCodecsAvailable } from '@core/video/exactVideoSource';
import type { ImportedAsset } from '@stores/assetStore';
import styles from './FootagePreviewDialog.module.css';

function factsOf(asset: ImportedAsset): string {
  const m = asset.metadata ?? {};
  const parts: string[] = [];
  const par = asset.interpret?.par ?? 1;
  if (m.width && m.height) parts.push(`${Math.round(m.width * par)}×${m.height}`);
  if (m.duration && m.duration > 0) parts.push(`${m.duration.toFixed(2)}s`);
  // Probed rate only — the browser cannot report one, and printing the comp's
  // rate here would be a lie wearing units. Same rule as the panel footer.
  if (m.fps && m.fps > 0) parts.push(`${m.fps % 1 === 0 ? m.fps : m.fps.toFixed(3)} fps`);
  if (m.hasAudioTrack) parts.push('audio');
  return parts.join(' · ');
}

const fmtSec = (us: number): string => (us / 1e6).toFixed(3);

/** The exact-mode machinery for one video asset. Kept as a hook so the modal
 *  body stays a rendering function; the source is built lazily on first use
 *  and closed with the dialog. */
function useExactStepper(asset: ImportedAsset): {
  mode: 'player' | 'frames';
  note: string | null;
  frameIdx: number;
  frameCount: number;
  timeUs: number;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  videoRef: React.RefObject<HTMLVideoElement>;
  enter: () => void;
  exit: () => void;
  step: (by: number) => void;
} {
  const [mode, setMode] = useState<'player' | 'frames'>('player');
  const [note, setNote] = useState<string | null>(null);
  const [frameIdx, setFrameIdx] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [timeUs, setTimeUs] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const sourceRef = useRef<ExactVideoSource | null>(null);

  useEffect(() => () => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  const show = (src: ExactVideoSource, idx: number): void => {
    const clamped = Math.max(0, Math.min(src.frameCount - 1, idx));
    void src.frameAt(clamped).then((frame) => {
      if (sourceRef.current !== src) return; // dialog closed mid-decode
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) {
        // Cache owns the frame — draw, never close.
        ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, canvas.width, canvas.height);
      }
      setFrameIdx(clamped);
      setTimeUs(src.timeUsOf(clamped));
    }).catch((e: unknown) => {
      setNote(`Frame-by-frame failed: ${e instanceof Error ? e.message : String(e)}`);
      setMode('player');
    });
  };

  const enter = (): void => {
    const existing = sourceRef.current;
    if (existing) {
      setMode('frames');
      show(existing, frameIdx);
      return;
    }
    setNote(null);
    // Promise.resolve first: a platform with no fetch (or one that throws
    // synchronously on an unsupported scheme) must land in the SAME catch as
    // a failed read, not escape the handler.
    void Promise.resolve()
      .then(() => fetch(asset.src))
      .then((r) => {
        if (!r.ok) throw new Error(`source unreadable (${r.status})`);
        return r.arrayBuffer();
      })
      .then(demuxMp4)
      .then((demuxed) => {
        const src = new ExactVideoSource(demuxed);
        sourceRef.current = src;
        setFrameCount(src.frameCount);
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.width = demuxed.codedWidth;
          canvas.height = demuxed.codedHeight;
          // Anamorphic footage: the canvas holds coded (unstretched) pixels,
          // so the PAR correction is display-side, like the facts row does.
          const par = asset.interpret?.par ?? 1;
          if (par !== 1) canvas.style.aspectRatio = `${demuxed.codedWidth * par} / ${demuxed.codedHeight}`;
        }
        setMode('frames');
        // Land where the player was paused, not back at 0 — stepping exists
        // to inspect the moment you were just looking at.
        const t = videoRef.current?.currentTime ?? 0;
        show(src, src.frameIndexAt(Math.round(t * 1e6)));
      })
      .catch((e: unknown) => {
        setNote(`Frame-by-frame unavailable: ${e instanceof Error ? e.message : String(e)}`);
        setMode('player');
      });
  };

  const exit = (): void => setMode('player');
  const step = (by: number): void => {
    const src = sourceRef.current;
    if (src) show(src, frameIdx + by);
  };

  return { mode, note, frameIdx, frameCount, timeUs, canvasRef, videoRef, enter, exit, step };
}

function PreviewBody({ asset, close }: { asset: ImportedAsset; close: () => void }): JSX.Element {
  const [failed, setFailed] = useState(false);
  const replaceTarget = replaceableSelectedLayer();
  const targetName = replaceTarget ? defaultSceneGraph.getNode(replaceTarget)?.name : null;
  const stepper = useExactStepper(asset);
  const exactOffered = asset.type === 'video' && webCodecsAvailable() && !failed;
  const inFrames = stepper.mode === 'frames';

  return (
    <div className={styles.body}>
      <div className={styles.stage}>
        {failed ? (
          // A dead blob URL (source file moved, session restored) must say so —
          // a black rectangle reads as "the clip is black".
          <div className={styles.dead}>Preview unavailable — the source may need relinking.</div>
        ) : asset.type === 'video' ? (
          <>
            {/* Both mounted, one shown: unmounting the <video> would forget
                the pause point Frame-by-frame resumes from. */}
            <video
              ref={stepper.videoRef}
              className={styles.media}
              style={inFrames ? { display: 'none' } : undefined}
              src={asset.src}
              controls
              onError={() => setFailed(true)}
            />
            <canvas
              ref={stepper.canvasRef}
              className={styles.media}
              style={inFrames ? undefined : { display: 'none' }}
            />
          </>
        ) : asset.type === 'audio' ? (
          <audio className={styles.audio} src={asset.src} controls onError={() => setFailed(true)} />
        ) : (
          <img className={styles.media} src={asset.thumbSrc && !asset.src ? asset.thumbSrc : asset.src} alt={asset.name} onError={() => setFailed(true)} />
        )}
      </div>

      {inFrames && (
        <div className={styles.transport}>
          <Button size="sm" variant="secondary" onClick={() => stepper.step(-1)} disabled={stepper.frameIdx <= 0} title="Previous frame">
            ◀
          </Button>
          <Button size="sm" variant="secondary" onClick={() => stepper.step(1)} disabled={stepper.frameIdx >= stepper.frameCount - 1} title="Next frame">
            ▶
          </Button>
          <span className={styles.transportReadout}>
            {`frame ${stepper.frameIdx + 1} / ${stepper.frameCount} · ${fmtSec(stepper.timeUs)}s`}
          </span>
          <Button size="sm" variant="secondary" onClick={stepper.exit}>
            Player
          </Button>
        </div>
      )}

      {exactOffered && !inFrames && (
        <div className={styles.transport}>
          <Button
            size="sm"
            variant="secondary"
            onClick={stepper.enter}
            title="Exact stepping on true frame boundaries (WebCodecs decode)"
          >
            Frame by frame
          </Button>
          {stepper.note && <span className={styles.exactNote}>{stepper.note}</span>}
        </div>
      )}

      <div className={styles.facts}>{factsOf(asset) || 'No metadata probed for this file.'}</div>

      <div className={styles.actions}>
        <Button size="sm" variant="secondary" onClick={() => { void insertMedia(asset); close(); }}>
          Add to Comp
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => { void insertMediaAtPlayhead(asset); close(); }}
          title="Insert with the clip starting at the playhead instead of frame 0"
        >
          Add at Playhead
        </Button>
        {asset.type !== 'audio' && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => { void createCompositionFromFootage(asset); close(); }}
            title="New composition sized, timed and paced to this clip"
          >
            New Comp
          </Button>
        )}
        {replaceTarget && asset.type !== 'audio' && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => { retargetLayerSource(replaceTarget, asset); close(); }}
            // The layer's NAME in the label, because "replace" without a target
            // named is a button that might do anything to anything.
            title={`Point the selected layer at this footage — keyframes, effects and masks survive`}
          >
            {`Use for “${targetName ?? 'layer'}”`}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Open the viewer for one asset. The modal id is fixed so double-clicking a
 *  second clip REPLACES the viewer rather than stacking a pile of them. */
export function openFootagePreview(asset: ImportedAsset): void {
  openModal({
    id: 'footage-preview',
    title: asset.name,
    size: 'lg',
    render: (close) => <PreviewBody asset={asset} close={close} />,
  });
}
