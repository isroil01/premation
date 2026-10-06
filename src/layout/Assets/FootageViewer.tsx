/**
 * FootageViewer — After Effects' Footage panel, as a tab of the viewer.
 *
 * The source file on its own, before (or apart from) its use in a composition.
 * It used to be a modal dialog, which covered the timeline the clip was going
 * into and could not stay open; and marking In / Out lived in a separate
 * "Source" panel of the right dock. Both are this one viewer now:
 *
 *   • video and audio — the source monitor (SourceMonitorPanel): the file's
 *     whole length with the marked range, J K L, I / O, exact frame stepping,
 *     and the verbs that put the range into the composition;
 *   • a still — the picture on a transparency grid, and the actions that
 *     commit it (add, add at the playhead, new composition, replace the
 *     selected layer's source).
 *
 * One line of facts about the file sits on top in every case.
 */

import { useEffect, useState } from 'react';
import { Button } from '@components/Button';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { Icon } from '@components/Icon';
import { ValueField } from '@components/ValueField';
import { SourceMonitorPanel } from '@layout/SourceMonitor/SourceMonitorPanel';
import { replaceSourceWithAsset } from '@layout/Timeline/timelineEdits';
import { insertMediaEdit, newCompFromFootageEdit } from '@layout/Workspace/footageEdits';
import { useSourceMonitorStore } from '@stores/sourceMonitorStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useFootageViewStore } from '@stores/footageViewStore';
import type { ImportedAsset } from '@stores/assetStore';
import { factsOf } from './footagePreviewHooks';
import { replaceTargetLayer } from './replaceTarget';
import { formatBytes } from './assetListLogic';
import { FootageStage } from './FootageStage';
import styles from './FootageViewer.module.css';

const KIND: Readonly<Record<string, string>> = { image: 'still', video: 'video', audio: 'audio' };

export function FootageViewer({ asset }: { asset: ImportedAsset }): JSX.Element {
  const timed = asset.type === 'video' || asset.type === 'audio';

  // The monitor shows whichever item its store names; keep it on this one.
  useEffect(() => {
    if (!timed) return;
    const s = useSourceMonitorStore.getState();
    if (s.assetId !== asset.id) s.open(asset.id, asset.metadata?.duration);
  }, [timed, asset.id, asset.metadata?.duration]);

  // A different file starts at Fit with no guides.
  useEffect(() => { useFootageViewStore.getState().reset(); }, [asset.id]);

  const facts = [KIND[asset.type] ?? asset.type, factsOf(asset), asset.size > 0 ? formatBytes(asset.size) : '']
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={styles.root} data-footage-viewer="">
      <div className={styles.info}>
        <span className={styles.name} title={asset.name}>{asset.name}</span>
        <span className={styles.facts}>{facts}</span>
        {asset.type === 'image' || asset.type === 'video' ? <ViewControls /> : null}
      </div>
      <div className={styles.body}>
        {timed ? <SourceMonitorPanel /> : <StillBody asset={asset} />}
      </div>
    </div>
  );
}

function StillBody({ asset }: { asset: ImportedAsset }): JSX.Element {
  const [failed, setFailed] = useState(false);
  // Re-read when the selection changes: "replace" names the selected layer.
  useSelectionStore((s) => s.ids);
  const target = replaceTargetLayer();
  // The file's own size: what the import measured, else what the picture
  // itself reports once it has loaded (an SVG, a restored session).
  const [loaded, setLoaded] = useState<{ src: string; width: number; height: number } | null>(null);
  const natural = asset.metadata?.width && asset.metadata.height
    ? { width: asset.metadata.width, height: asset.metadata.height }
    : loaded && loaded.src === asset.src ? loaded : null;
  // A new file gets a fresh chance to load.
  useEffect(() => setFailed(false), [asset.src]);

  return (
    <>
      {failed ? (
        // A dead URL (source file moved, session restored) must say so — an
        // empty stage reads as "the picture is empty".
        <div className={styles.stage}>
          <div className={styles.dead}>The file for this footage cannot be shown. It may have moved; relink it from the Project panel.</div>
        </div>
      ) : (
        <FootageStage natural={natural} checker>
          <img
            src={asset.thumbSrc && !asset.src ? asset.thumbSrc : asset.src}
            alt={asset.name}
            draggable={false}
            onLoad={(e) => {
              const el = e.currentTarget;
              if (el.naturalWidth > 0 && el.naturalHeight > 0) setLoaded({ src: asset.src, width: el.naturalWidth, height: el.naturalHeight });
            }}
            onError={() => setFailed(true)}
          />
        </FootageStage>
      )}
      <div className={styles.actions} data-dialog-actions="">
        {target && (
          <Button
            size="sm"
            variant="secondary"
            // `replaceLayerSource` (keep size): keyframes, effects and masks survive.
            onClick={() => { void replaceSourceWithAsset(target.id, asset.id); }}
            title="Point the selected layer at this footage — keyframes, effects and masks survive"
          >
            {`Replace “${target.name}”`}
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={() => { void newCompFromFootageEdit(asset); }} title="New composition sized to this picture">
          New comp from footage
        </Button>
        <Button size="sm" variant="secondary" onClick={() => { void insertMediaEdit([asset], { atPlayhead: true }); }} title="Add it starting at the current time">
          Add at playhead
        </Button>
        <Button size="sm" variant="primary" onClick={() => { void insertMediaEdit([asset]); }} title="Add it to the composition">
          Add to composition
        </Button>
      </div>
    </>
  );
}

const ZOOM_STEPS: readonly number[] = [0.25, 0.5, 1, 2, 4];

/** Zoom, exposure and rulers — how the viewer shows the file, never the file. */
function ViewControls(): JSX.Element {
  const zoom = useFootageViewStore((s) => s.zoom);
  const setZoom = useFootageViewStore((s) => s.setZoom);
  const exposure = useFootageViewStore((s) => s.exposure);
  const setExposure = useFootageViewStore((s) => s.setExposure);
  const showRulers = useFootageViewStore((s) => s.showRulers);
  const setRulers = useFootageViewStore((s) => s.setRulers);
  const guides = useFootageViewStore((s) => s.guides);
  const setGuides = useFootageViewStore((s) => s.setGuides);

  const zoomItems: DropdownItem[] = [
    { type: 'checkbox', id: 'fit', label: 'Fit', checked: zoom === null, onChange: () => setZoom(null) },
    { type: 'separator' },
    ...ZOOM_STEPS.map((z): DropdownItem => ({
      type: 'checkbox',
      id: `z${z}`,
      label: `${Math.round(z * 100)} %`,
      checked: zoom !== null && Math.abs(zoom - z) < 1e-6,
      onChange: () => setZoom(z),
    })),
  ];
  const viewItems: DropdownItem[] = [
    { type: 'checkbox', id: 'rulers', label: 'Rulers and Guides', checked: showRulers, onChange: (on) => setRulers(on) },
    ...(guides.x.length + guides.y.length > 0
      ? [{ type: 'item', id: 'clear-guides', label: 'Clear Guides', onSelect: () => setGuides({ x: [], y: [] }) } as DropdownItem]
      : []),
  ];

  return (
    <span className={styles.view} data-footage-view="">
      <Dropdown
        placement="bottom-end"
        items={zoomItems}
        trigger={
          <button type="button" className={styles.select} title="Zoom — the wheel zooms, the middle button or the Hand tool moves the view">
            <span>{zoom === null ? 'Fit' : `${Math.round(zoom * 100)} %`}</span>
            <Icon name="chevron-down" size="sm" />
          </button>
        }
      />
      <span className={styles.exposure} title="Exposure, in stops: how this viewer shows the picture. It does not change the file. Double-click to reset.">
        <span className={styles.viewLabel}>Exposure</span>
        <span onDoubleClick={() => setExposure(0)}>
          <ValueField value={exposure} onChange={setExposure} min={-8} max={8} step={0.05} precision={1} aria-label="Exposure (stops)" />
        </span>
      </span>
      <Dropdown
        placement="bottom-end"
        items={viewItems}
        trigger={
          <button type="button" className={styles.select} title="Rulers in the file’s pixels; drag a guide out of a ruler">
            <span>View</span>
            <Icon name="chevron-down" size="sm" />
          </button>
        }
      />
    </span>
  );
}
