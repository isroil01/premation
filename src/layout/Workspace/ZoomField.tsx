/**
 * The viewport's ONE zoom control, AE's magnification popup: a scrubbable
 * percentage and its preset menu (Fit first, then AE's ladder). The −, + and
 * Fit buttons that flanked it were five controls for one value (2026-10-07);
 * the wheel, the +/− keys and the menu's Fit row do the same.
 *
 * It was `TopNav/ViewControls.ZoomField`, and the same presets sat a second
 * time in the View Options menu as "magnification". That menu is gone; this
 * field is the only place the zoom is set by hand. Wheel zoom and the +/−
 * keys still reach the same controller.
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import { Icon } from '@components/Icon';
import type { DropdownItem } from '@components/Dropdown';
import { Dropdown } from '@components/Dropdown';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import styles from './ZoomField.module.css';

/** Magnification presets (AE's zoom menu). 100 = 1:1. */
export const ZOOM_PRESETS = [12.5, 25, 50, 75, 100, 150, 200, 400, 800] as const;

/**
 * The preset menu's rows, shared with the transport's overflow menu so the
 * zoom is reachable when the row has had to shed the field itself.
 */
export function zoomMenuItems(zoom: number): DropdownItem[] {
  return [
    { type: 'item', id: 'zoom-fit', label: 'Fit in view', icon: 'fit', onSelect: () => getWorkspaceController().fitComposition() },
    { type: 'separator' },
    ...ZOOM_PRESETS.map<DropdownItem>((pct) => ({
      type: 'checkbox',
      id: `zoom-${pct}`,
      label: `${pct}%`,
      checked: Math.abs(zoom - pct) < 0.5,
      onChange: () => getWorkspaceController().setZoomPercent(pct),
    })),
  ];
}

/** The live zoom percentage, following the workspace camera. */
export function useZoomPercent(): number {
  const [zoom, setZoom] = useState(() => getWorkspaceController().zoomPercent());
  useEffect(() => {
    const ws = getWorkspaceController().ws;
    const sync = (): void => setZoom(getWorkspaceController().zoomPercent());
    const s1 = ws.events.on('ZoomChanged', sync);
    const s2 = ws.events.on('ViewportChanged', sync);
    return () => { s1.dispose(); s2.dispose(); };
  }, []);
  return zoom;
}

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
  const stopDragRef = useRef<(() => void) | null>(null);

  const commit = useCallback((v: number) => {
    let clamped = v;
    if (min !== undefined) clamped = Math.max(min, clamped);
    if (max !== undefined) clamped = Math.min(max, clamped);
    if (!Number.isFinite(clamped)) return;
    onChange(clamped);
  }, [min, max, onChange]);

  useEffect(() => () => stopDragRef.current?.(), []);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (editing) return;
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startV: value };
      const onMove = (me: MouseEvent): void => {
        if (!dragRef.current) return;
        const dx = me.clientX - dragRef.current.startX;
        commit(dragRef.current.startV + dx * step);
      };
      const onUp = (): void => {
        dragRef.current = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        stopDragRef.current = null;
      };
      stopDragRef.current = onUp;
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [editing, value, step, commit],
  );

  const onDoubleClick = (): void => {
    setRaw(value.toFixed(digits));
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.select());
  };

  const onBlur = (): void => {
    commit(parseFloat(raw));
    setEditing(false);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') { commit(parseFloat(raw)); setEditing(false); }
    if (e.key === 'Escape') setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={styles.scrubInput}
        aria-label="Zoom percentage"
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

/** Live zoom % field — syncs with the workspace camera. */
export function ZoomField(): JSX.Element {
  const zoom = useZoomPercent();

  return (
    <span className={styles.zoomGroup} role="group" aria-label="Viewport zoom">
      <ScrubField
        value={zoom}
        onChange={(v) => getWorkspaceController().setZoomPercent(v)}
        unit="%"
        min={5}
        max={6400}
        step={1}
        digits={0}
        title="Magnification · drag or double-click to type (wheel, + and − zoom too)"
      />
      <Dropdown
        placement="top-end"
        trigger={
          <button type="button" className={styles.tool} title="Magnification presets — Fit, 12.5% … 800%" aria-label="Magnification presets">
            <Icon name="chevron-down" size="sm" className={styles.chevron} />
          </button>
        }
        items={zoomMenuItems(zoom)}
      />
    </span>
  );
}
