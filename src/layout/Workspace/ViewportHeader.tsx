/**
 * ViewportHeader — the AE-style composition panel header bar.
 *
 * Sits directly above the canvas and surfaces the most-used controls:
 *   ← [Comp name] · [W×H] · [FPS] · [Duration] · [BG colour] · [Transparent] · [Zoom] · [Fit] · [Grid] · [Rulers] · [Safe] →
 *
 * Everything is live-editable inline. The colour swatch opens the system
 * colour picker; the zoom field scrubs on drag. All changes write through to
 * the canonical stores so the canvas repaints immediately.
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import { Icon } from '@components/Icon';
import { useCompositionStore } from '@stores/compositionStore';
import { useGuidesStore } from '@stores/guidesStore';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';
import { openNewCompositionDialog } from '@layout/Composition/NewCompositionDialog';
import styles from './ViewportHeader.module.css';

/** Tiny inline number field that scrubs on drag. */
function ScrubField({
  value,
  onChange,
  unit = '',
  min,
  max,
  step = 1,
  digits = 0,
  title,
}: {
  value: number;
  onChange: (v: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  digits?: number;
  title?: string;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ startX: number; startV: number } | null>(null);

  const commit = (v: number) => {
    let clamped = v;
    if (min !== undefined) clamped = Math.max(min, clamped);
    if (max !== undefined) clamped = Math.min(max, clamped);
    if (!Number.isFinite(clamped)) return;
    onChange(clamped);
  };

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (editing) return;
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startV: value };
      const onMove = (me: MouseEvent) => {
        if (!dragRef.current) return;
        const dx = me.clientX - dragRef.current.startX;
        commit(dragRef.current.startV + dx * step);
      };
      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [editing, value, step, commit],
  );

  const onDoubleClick = () => {
    setRaw(value.toFixed(digits));
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.select());
  };

  const onBlur = () => {
    commit(parseFloat(raw));
    setEditing(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { commit(parseFloat(raw)); setEditing(false); }
    if (e.key === 'Escape') setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={styles.scrubInput}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        autoFocus
      />
    );
  }

  return (
    <span
      className={styles.scrubField}
      title={title}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
    >
      {value.toFixed(digits)}{unit}
    </span>
  );
}

/** Tiny colour swatch that opens native <input type=color>. */
function ColourSwatch({ value, onChange, title }: { value: string; onChange: (v: string) => void; title?: string }): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <span className={styles.colourSwatch} title={title} onClick={() => inputRef.current?.click()}>
      <span className={styles.colourPreview} style={{ background: value }} />
      <span className={styles.colourHex}>{value}</span>
      <input
        ref={inputRef}
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }}
        tabIndex={-1}
      />
    </span>
  );
}

/** Live zoom % field — syncs with the workspace camera. */
function ZoomField(): JSX.Element {
  const [zoom, setZoom] = useState(() => getWorkspaceController().zoomPercent());

  useEffect(() => {
    const ws = getWorkspaceController().ws;
    const sync = () => setZoom(getWorkspaceController().zoomPercent());
    const s1 = ws.events.on('ZoomChanged', sync);
    const s2 = ws.events.on('ViewportChanged', sync);
    return () => { s1.dispose(); s2.dispose(); };
  }, []);

  return (
    <span className={styles.zoomGroup}>
      <button className={styles.headerBtn} onClick={() => getWorkspaceController().zoomOut()} title="Zoom out (-)">
        <Icon name="zoom-out" size={12} />
      </button>
      <ScrubField
        value={zoom}
        onChange={(v) => getWorkspaceController().setZoomPercent(v)}
        unit="%"
        min={5}
        max={6400}
        step={1}
        digits={0}
        title="Zoom · drag or double-click to type"
      />
      <button className={styles.headerBtn} onClick={() => getWorkspaceController().zoomIn()} title="Zoom in (+)">
        <Icon name="zoom-in" size={12} />
      </button>
      <button className={styles.headerBtn} onClick={() => getWorkspaceController().fitComposition()} title="Fit comp in view (Shift+/ or H)">
        <Icon name="fit" size={12} />
      </button>
    </span>
  );
}

export function ViewportHeader(): JSX.Element {
  const name     = useCompositionStore((s) => s.name);
  const width    = useCompositionStore((s) => s.width);
  const height   = useCompositionStore((s) => s.height);
  const fps      = useCompositionStore((s) => s.fps);
  const dur      = useCompositionStore((s) => s.durationSeconds);
  const bg       = useCompositionStore((s) => s.background);
  const transp   = useCompositionStore((s) => s.transparent);
  const update   = useCompositionStore((s) => s.update);
  const setBg    = useCompositionStore((s) => s.setBackground);
  const setTrans = useCompositionStore((s) => s.setTransparent);

  const grid      = useGuidesStore((s) => s.grid);
  const rulers    = useGuidesStore((s) => s.rulers);
  const safeArea  = useGuidesStore((s) => s.safeArea);
  const camera3dMode = useGuidesStore((s) => s.camera3dMode);
  const gridDivisions  = useGuidesStore((s) => s.gridDivisions);
  const setGridDivisions = useGuidesStore((s) => s.setGridDivisions);
  const toggleGrid     = useGuidesStore((s) => s.toggleGrid);
  const toggleRulers   = useGuidesStore((s) => s.toggleRulers);
  const toggleSafeArea = useGuidesStore((s) => s.toggleSafeArea);
  const toggleCamera3dMode = useGuidesStore((s) => s.toggleCamera3dMode);

  return (
    <div className={styles.root}>
      {/* ── Left: comp name + settings cog ──────────────────── */}
      <div className={styles.group}>
        <button className={styles.compName} onClick={() => openCompositionSettings()} title="Composition Settings (Ctrl+K)">
          <Icon name="layers" size={11} className={styles.compIcon} />
          <span className={styles.compLabel}>{name}</span>
        </button>
        <span className={styles.sep} />
        <button className={styles.headerBtn} onClick={() => openNewCompositionDialog()} title="New Composition">
          <Icon name="plus" size={12} />
        </button>
      </div>

      <span className={styles.divider} />

      {/* ── Resolution & FPS ─────────────────────────────────── */}
      <div className={styles.group}>
        <ScrubField value={width}  onChange={(v) => { update({ width: Math.round(v) }); requestAnimationFrame(() => getWorkspaceController().fitComposition()); }}  step={4}  min={1} max={16384} title="Width · drag or double-click" />
        <span className={styles.x}>×</span>
        <ScrubField value={height} onChange={(v) => { update({ height: Math.round(v) }); requestAnimationFrame(() => getWorkspaceController().fitComposition()); }} step={4}  min={1} max={16384} title="Height · drag or double-click" />
        <span className={styles.sep} />
        <ScrubField value={fps}    onChange={(v) => update({ fps: Math.round(v) })}    step={1}  min={1} max={240}   unit=" fps" title="Frame rate · drag or double-click" />
        <span className={styles.sep} />
        <ScrubField value={dur}    onChange={(v) => update({ durationSeconds: v })}    step={0.1} min={0.1} max={3600} digits={1} unit="s" title="Duration · drag or double-click" />
      </div>

      <span className={styles.divider} />

      {/* ── Background colour + transparency ─────────────────── */}
      <div className={styles.group}>
        {!transp && (
          <ColourSwatch value={bg} onChange={setBg} title="Background colour" />
        )}
        <button
          className={transp ? styles.headerBtnActive : styles.headerBtn}
          onClick={() => setTrans(!transp)}
          title="Toggle transparent background (checkerboard)"
        >
          <Icon name="image" size={12} />
          <span className={styles.btnLabel}>α</span>
        </button>
      </div>

      <span className={styles.divider} />

      {/* ── View overlays ────────────────────────────────────── */}
      <div className={styles.group}>
        <button
          className={grid ? styles.headerBtnActive : styles.headerBtn}
          onClick={toggleGrid}
          title="Toggle grid (')"
        >
          <Icon name="layout" size={12} />
        </button>
        {grid ? (
          <input
            type="number"
            min={2}
            max={64}
            value={gridDivisions}
            onChange={(e) => setGridDivisions(Number(e.target.value))}
            title="Grid divisions (cells per axis)"
            aria-label="Grid divisions"
            style={{
              width: 40, height: 22, background: '#1c1c1f', color: '#ddd',
              border: '1px solid #333', borderRadius: 3, fontSize: 11,
              textAlign: 'center', marginRight: 2,
            }}
          />
        ) : null}
        <button
          className={rulers ? styles.headerBtnActive : styles.headerBtn}
          onClick={toggleRulers}
          title="Toggle rulers (Ctrl+R)"
        >
          <Icon name="move" size={12} />
        </button>
        <button
          className={safeArea ? styles.headerBtnActive : styles.headerBtn}
          onClick={toggleSafeArea}
          title="Toggle safe areas"
        >
          <Icon name="crosshair" size={12} />
        </button>
        <button
          className={camera3dMode === 'active' ? styles.headerBtnActive : styles.headerBtn}
          onClick={toggleCamera3dMode}
          title={camera3dMode === 'active' ? 'Active Camera View (3D)' : 'Front View (2D)'}
        >
          <Icon name="camera" size={12} />
        </button>
      </div>

      <span className={styles.spacer} />

      {/* ── Zoom controls ────────────────────────────────────── */}
      <ZoomField />
    </div>
  );
}
