/**
 * Version compare — a saved version against the live composition, at the
 * playhead, under a wipe.
 *
 * Both frames come from the still-render path exports use (`renderStillFrame`:
 * same backend, same 1:1 comp→frame view), so what the wipe shows is what a
 * render of each would contain. The live frame renders from the engines as
 * they are. The VERSION's frame renders by swapping its document in, rendering,
 * and swapping the live document back — the offline renderer reads the
 * default scene graph and animation, so there is no second engine to hand it.
 * The swap runs under `runRestoring`, which is how undo and redo tell the
 * snapshot history "this change is not an edit"; nothing lands in the undo
 * stack and the live document is byte-identical afterwards (it is the same
 * captured document, restored).
 *
 * The compare is a blocking dialog on purpose: for the second or so the
 * version is swapped in, an edit would land on the wrong document.
 */

import { useEffect, useRef, useState } from 'react';
import { Button } from '@components/Button';
import { DialogFooter } from '@components/Modal';
import { Progress } from '@components/Progress';
import { openModal } from '@stores/modalStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useProjectStore } from '@stores/projectStore';
import { useVersionHistoryStore } from '@stores/versionHistoryStore';
import { getCloudProjectId } from '@stores/cloudProjectStore';
import { api, type ProjectVersionSummary } from '@core/api/client';
import type { EditorDocument } from '@core/api/cloudDocument';
import { withDocumentSwapped } from '@core/project/documentSwap';
import { renderStillFrame } from '@core/export/offlineRenderer';
import { compSizeOf } from '@core/composition/compSizes';
import { restoreVersionAsOneEdit } from './versionRestore';
import styles from './VersionCompareDialog.module.css';

/** The playhead, in seconds, of the active tab — where both frames render. */
function playheadSeconds(): number {
  const s = useProjectStore.getState();
  return (s.activeTabId ? s.tabs[s.activeTabId]?.time : 0) ?? 0;
}

/** The comp's frame at `sec`, clamped into the comp. Pure, for the test. */
export function frameAt(sec: number, fps: number, durationSec: number): number {
  const last = Math.max(0, Math.round(durationSec * fps) - 1);
  return Math.max(0, Math.min(Math.round(sec * fps), last));
}

/** Render the LIVE engines at the playhead to an object URL. */
async function renderLiveFrame(): Promise<string> {
  const c = useCompositionStore.getState().comp();
  const params = {
    width: c.width,
    height: c.height,
    fps: c.fps,
    durationSec: c.durationSeconds,
    comp: { ...c, rootId: c.id, compSizeOf },
  };
  const blob = await renderStillFrame(params, frameAt(playheadSeconds(), c.fps, c.durationSeconds));
  if (!blob) throw new Error('The renderer could not produce a frame.');
  return URL.createObjectURL(blob);
}

/**
 * Render a VERSION's document at the playhead by swapping it in and back.
 * The swap is invisible to undo (see the module comment) and the live
 * document is restored in `finally`, so a render failure cannot leave the
 * editor showing the version.
 */
export async function renderVersionFrame(doc: EditorDocument): Promise<string> {
  return withDocumentSwapped(doc, renderLiveFrame);
}

interface CompareProps {
  version: ProjectVersionSummary;
  close: () => void;
}

type Phase = { kind: 'loading'; step: string } | { kind: 'ready' } | { kind: 'error'; message: string };

function VersionCompare({ version, close }: CompareProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading', step: 'Rendering the current composition…' });
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [versionUrl, setVersionUrl] = useState<string | null>(null);
  const [wipe, setWipe] = useState(50);
  const [restoring, setRestoring] = useState(false);
  const urls = useRef<string[]>([]);

  useEffect(() => {
    let alive = true;
    const run = async (): Promise<void> => {
      const projectId = getCloudProjectId();
      if (!projectId) throw new Error('Open a cloud project to compare its versions.');
      const live = await renderLiveFrame();
      urls.current.push(live);
      if (!alive) return;
      setLiveUrl(live);
      setPhase({ kind: 'loading', step: `Rendering ${version.label || `revision ${version.revision}`}…` });
      const record = await api.getVersion(projectId, version.id);
      if (!alive) return;
      const ver = await renderVersionFrame(record.document as EditorDocument);
      urls.current.push(ver);
      if (!alive) return;
      setVersionUrl(ver);
      setPhase({ kind: 'ready' });
    };
    run().catch((err: unknown) => {
      if (alive) setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    });
    return () => {
      alive = false;
      for (const u of urls.current) URL.revokeObjectURL(u);
      urls.current = [];
    };
  }, [version.id, version.label, version.revision]);

  const restore = async (): Promise<void> => {
    setRestoring(true);
    try {
      await restoreVersionAsOneEdit(version.id);
      close();
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className={styles.root}>
      <div className={styles.stage} data-testid="compare-stage">
        {liveUrl ? <img className={styles.frame} src={liveUrl} alt="Current composition at the playhead" /> : null}
        {versionUrl ? (
          <img
            className={styles.frame}
            src={versionUrl}
            alt={`${version.label || `Revision ${version.revision}`} at the playhead`}
            // The wipe: the version covers the current frame from the left edge
            // to the slider. A number, not a design decision, so inline.
            style={{ clipPath: `inset(0 ${100 - wipe}% 0 0)` }}
          />
        ) : null}
        {phase.kind === 'loading' ? (
          <div className={styles.veil}>
            <Progress size="sm" indeterminate aria-label={phase.step} className={styles.veilBar} />
            <span className={styles.veilText}>{phase.step}</span>
          </div>
        ) : null}
        {phase.kind === 'error' ? (
          <div className={styles.veil}>
            <span className={styles.veilError}>{phase.message}</span>
          </div>
        ) : null}
        <span className={styles.tagLeft}>{version.label || `Revision ${version.revision}`}</span>
        <span className={styles.tagRight}>Current</span>
      </div>
      <label className={styles.wipeRow}>
        <span className={styles.wipeLabel}>Wipe</span>
        <input
          className={styles.wipe}
          type="range"
          min={0}
          max={100}
          value={wipe}
          onChange={(e) => setWipe(Number(e.currentTarget.value))}
          aria-label="Wipe between the saved version and the current composition"
          disabled={phase.kind !== 'ready'}
          data-enter-safe=""
        />
      </label>
      <DialogFooter
        note={`At the playhead · ${playheadSeconds().toFixed(2)}s`}
        secondary={<Button variant="ghost" onClick={close}>Close</Button>}
        primary={
          <Button variant="primary" onClick={() => void restore()} disabled={phase.kind !== 'ready' || restoring}>
            {restoring ? 'Restoring…' : 'Restore this version'}
          </Button>
        }
      />
    </div>
  );
}

export function openVersionCompare(version: ProjectVersionSummary): void {
  openModal({
    id: 'version-compare',
    title: 'Compare with current',
    description: `${version.label || `Revision ${version.revision}`} against the composition as it is now`,
    size: 'lg',
    render: (close) => <VersionCompare version={version} close={close} />,
  });
}

/** Test seam: the store's own restore is what the button runs. */
export const __compareInternals = { useVersionHistoryStore };
