/**
 * InfoReadout — the pointer (position, colour under it) and the composition
 * (size, frame rate, selection) as read-only values.
 *
 * Extracted 2026-09-15 so the Audio panel can carry it at its top: "Info &
 * Audio" and "Audio" were two right-rail tabs that both drew a master meter,
 * and the rails were cut to the everyday set. `InfoAudioPanel` still renders
 * the full form for the on-demand Info panel; Audio renders `compact`.
 */

import { useInfoStore } from '@stores/infoStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useActiveCompFps, useMirrorLayer } from '@hooks/useMirror';
import { useActiveCompSize } from './inspectorMirror';
import { cn } from '@utils/cn';
import styles from './InfoAudioPanel.module.css';

export interface InfoReadoutProps {
  /** One dense two-column grid instead of two labelled groups. */
  compact?: boolean;
}

export function InfoReadout({ compact = false }: InfoReadoutProps): JSX.Element {
  const { x, y, rgba, present } = useInfoStore();
  const selectedIds = useSelectionStore((s) => s.ids);
  const { width: compWidth, height: compHeight } = useActiveCompSize();
  // The rate as the settings dialog shows it: NTSC 30000/1001 reads 29.97.
  const compFps = Number(useActiveCompFps().toFixed(3));

  const swatch =
    rgba && rgba.a > 0
      ? `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${(rgba.a / 255).toFixed(2)})`
      : 'transparent';
  const hexColor = rgba
    ? `#${rgba.r.toString(16).padStart(2, '0')}${rgba.g.toString(16).padStart(2, '0')}${rgba.b.toString(16).padStart(2, '0')}`.toUpperCase()
    : '—';
  const primaryNode = useMirrorLayer(selectedIds[0]);
  const selectedLabel = primaryNode
    ? `${primaryNode.name}${selectedIds.length > 1 ? ` +${selectedIds.length - 1}` : ''}`
    : 'None';

  if (compact) {
    return (
      <section className={styles.compact} aria-label="Info">
        <div className={styles.compactGrid}>
          <span className={styles.key}>X</span>
          <span className={cn(styles.value, styles.mono)}>{present ? x : '—'}</span>
          <span className={styles.key}>Y</span>
          <span className={cn(styles.value, styles.mono)}>{present ? y : '—'}</span>
          <span className={styles.key}>Colour</span>
          <span className={cn(styles.value, styles.mono)}>
            {rgba && <span className={styles.colorSwatch} style={{ background: swatch }} />}
            {hexColor}
          </span>
          <span className={styles.key}>Alpha</span>
          <span className={cn(styles.value, styles.mono)}>{rgba ? `${Math.round((rgba.a / 255) * 100)}%` : '—'}</span>
          <span className={styles.key}>Comp</span>
          <span className={cn(styles.value, styles.mono)}>{compWidth}×{compHeight}</span>
          <span className={styles.key}>Rate</span>
          <span className={cn(styles.value, styles.mono)}>{compFps} fps</span>
        </div>
      </section>
    );
  }

  return (
    <>
      {/* ── Pointer ── */}
      <section className={styles.group} aria-label="Pointer">
        <div className={styles.groupHead}>
          <span className={styles.groupLabel}>Pointer</span>
          <span className={cn(styles.status, present && styles.statusLive)}>{present ? 'Live' : 'Idle'}</span>
        </div>
        <div className={styles.rows}>
          <div className={styles.row}>
            <span className={styles.key}>X</span>
            <span className={cn(styles.value, styles.mono)}>{present ? `${x} px` : '—'}</span>
          </div>
          <div className={styles.row}>
            <span className={styles.key}>Y</span>
            <span className={cn(styles.value, styles.mono)}>{present ? `${y} px` : '—'}</span>
          </div>
          <div className={styles.row}>
            <span className={styles.key}>RGB</span>
            <span className={cn(styles.value, styles.mono)}>
              {rgba ? (
                <>
                  <span className={styles.colorSwatch} style={{ background: swatch }} />
                  {`${rgba.r}, ${rgba.g}, ${rgba.b}`}
                </>
              ) : '—'}
            </span>
          </div>
          <div className={styles.row}>
            <span className={styles.key}>Alpha</span>
            <span className={cn(styles.value, styles.mono)}>{rgba ? `${Math.round((rgba.a / 255) * 100)}%` : '—'}</span>
          </div>
          <div className={styles.row}>
            <span className={styles.key}>Hex</span>
            <span className={cn(styles.value, styles.mono)}>{hexColor}</span>
          </div>
        </div>
      </section>

      {/* ── Composition ── */}
      <section className={styles.group} aria-label="Composition">
        <div className={styles.groupHead}>
          <span className={styles.groupLabel}>Composition</span>
        </div>
        <div className={styles.rows}>
          <div className={styles.row}>
            <span className={styles.key}>Size</span>
            <span className={cn(styles.value, styles.mono)}>{compWidth} × {compHeight}</span>
          </div>
          <div className={styles.row}>
            <span className={styles.key}>Frame rate</span>
            <span className={cn(styles.value, styles.mono)}>{compFps} fps</span>
          </div>
          <div className={styles.row}>
            <span className={styles.key}>Selected</span>
            <span className={styles.value} title={primaryNode?.name ?? undefined}>{selectedLabel}</span>
          </div>
        </div>
      </section>
    </>
  );
}
