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
 *
 * The MECHANICS (the exact stepper, the facts row) now live in
 * `footagePreviewHooks.ts`: the docked Source Monitor shows the same clip the
 * same way, and two decoders in one app would eventually disagree about which
 * frame is frame 12. What stays here is the MODAL — its layout, its commit
 * actions, and this argument.
 */

import { useState } from 'react';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { openModal } from '@stores/modalStore';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { insertMedia } from '@core/scene/sceneInsert';
import { insertMediaAtPlayhead, retargetLayerSource, replaceableSelectedLayer } from '@core/scene/footageWorkflow';
import { createCompositionFromFootage } from '@core/composition/compositionOps';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { webCodecsAvailable } from '@core/video/exactVideoSource';
import { openSourceMonitor } from '@stores/sourceMonitorStore';
import { factsOf, fmtSec, useExactStepper } from './footagePreviewHooks';
import type { ImportedAsset } from '@stores/assetStore';
import styles from './FootagePreviewDialog.module.css';

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
            <Icon name="chevron-left" size="sm" />
          </Button>
          <Button size="sm" variant="secondary" onClick={() => stepper.step(1)} disabled={stepper.frameIdx >= stepper.frameCount - 1} title="Next frame">
            <Icon name="chevron-right" size="sm" />
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
        {asset.type !== 'image' && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => { openSourceMonitor(asset); close(); }}
            // The modal is where you LOOK; the monitor is where you WORK. In
            // and out points, JKL shuttle and trimmed inserts live there, and
            // a modal cannot host them — it covers the timeline the trimmed
            // clip is going into.
            title="Open in the docked Source Monitor to mark in/out and insert a trimmed range"
          >
            <Icon name="tv" size="sm" /> Open in Source Monitor
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={() => { void insertMedia(asset); close(); }}>
          <Icon name="plus" size="sm" /> Add to Comp
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => { void insertMediaAtPlayhead(asset); close(); }}
          title="Insert with the clip starting at the playhead instead of frame 0"
        >
          <Icon name="play" size="sm" /> Add at Playhead
        </Button>
        {asset.type !== 'audio' && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => { void createCompositionFromFootage(asset); close(); }}
            title="New composition sized, timed and paced to this clip"
          >
            <Icon name="component" size="sm" /> New Comp
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
            <Icon name="refresh" size="sm" /> {`Use for “${targetName ?? 'layer'}”`}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The most recently viewed asset — what the tab strip's Footage tab shows and
 * reopens, the way AE's Footage viewer holds what was last opened in it.
 * A store (not module state) so the tab label re-renders when it changes.
 */
export const useLastFootagePreview = createLastPreviewStore();
function createLastPreviewStore(): UseBoundStore<StoreApi<{ asset: ImportedAsset | null; set: (a: ImportedAsset) => void }>> {
  return create<{ asset: ImportedAsset | null; set: (a: ImportedAsset) => void }>((set) => ({
    asset: null,
    set: (asset) => set({ asset }),
  }));
}

/**
 * Forget the last-viewed asset. Called when a PROJECT opens: the memory is
 * per-working-session, and without this the Footage tab in a freshly opened
 * (even empty) project kept naming whatever clip the PREVIOUS project had in
 * its viewer — a label with no referent in the project on screen.
 */
export function clearLastFootagePreview(): void {
  useLastFootagePreview.setState({ asset: null });
}

/** Open the viewer for one asset. The modal id is fixed so double-clicking a
 *  second clip REPLACES the viewer rather than stacking a pile of them. */
export function openFootagePreview(asset: ImportedAsset): void {
  useLastFootagePreview.getState().set(asset);
  openModal({
    id: 'footage-preview',
    title: asset.name,
    size: 'lg',
    render: (close) => <PreviewBody asset={asset} close={close} />,
  });
}
