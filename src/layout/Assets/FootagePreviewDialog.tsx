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
 * The scrub bar is the native `<video controls>` on purpose. This preview runs
 * on the same `HTMLVideoElement` decode path as the renderer, so its seeking
 * is approximate by nature (see videoFrameCache.ts) — building a custom
 * frame-accurate-looking transport over approximate seeks would DRESS the
 * imprecision as precision. The browser's own controls promise exactly what
 * they deliver. When the real decoder lands, this is the first surface that
 * should upgrade.
 */

import { useState } from 'react';
import { openModal } from '@stores/modalStore';
import { Button } from '@components/Button';
import { insertMedia } from '@core/scene/sceneInsert';
import { insertMediaAtPlayhead, retargetLayerSource, replaceableSelectedLayer } from '@core/scene/footageWorkflow';
import { createCompositionFromFootage } from '@core/composition/compositionOps';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
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

function PreviewBody({ asset, close }: { asset: ImportedAsset; close: () => void }): JSX.Element {
  const [failed, setFailed] = useState(false);
  const replaceTarget = replaceableSelectedLayer();
  const targetName = replaceTarget ? defaultSceneGraph.getNode(replaceTarget)?.name : null;

  return (
    <div className={styles.body}>
      <div className={styles.stage}>
        {failed ? (
          // A dead blob URL (source file moved, session restored) must say so —
          // a black rectangle reads as "the clip is black".
          <div className={styles.dead}>Preview unavailable — the source may need relinking.</div>
        ) : asset.type === 'video' ? (
          <video className={styles.media} src={asset.src} controls onError={() => setFailed(true)} />
        ) : asset.type === 'audio' ? (
          <audio className={styles.audio} src={asset.src} controls onError={() => setFailed(true)} />
        ) : (
          <img className={styles.media} src={asset.thumbSrc && !asset.src ? asset.thumbSrc : asset.src} alt={asset.name} onError={() => setFailed(true)} />
        )}
      </div>

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
