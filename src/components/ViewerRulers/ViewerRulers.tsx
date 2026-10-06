/**
 * Rulers and guides over a viewer's stage — the Layer and Footage viewers'
 * (the Composition viewer has its own, drawn on its canvas).
 *
 * The rulers read in the CONTENT's pixels (a layer's, a file's), whatever the
 * zoom: the host says where content (0, 0) sits on the stage and how many
 * stage pixels one content pixel is. Guides are stored in content pixels, so
 * they stay on the same spot of the picture when the view zooms or pans.
 *
 * Guides, as in After Effects: drag one out of a ruler; drag an existing one to
 * move it; drag it back onto its ruler to remove it. Viewing aids only — the
 * host keeps them as editor state, never in the document.
 */

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import styles from './ViewerRulers.module.css';

export interface ViewerGuides {
  /** Vertical guides: content x. */
  x: readonly number[];
  /** Horizontal guides: content y. */
  y: readonly number[];
}

export interface ViewerRulersProps {
  /** Stage size, CSS px. */
  width: number;
  height: number;
  /** Stage px per content px. */
  scale: number;
  /** Where content (0, 0) is on the stage. */
  originX: number;
  originY: number;
  guides: ViewerGuides;
  onGuidesChange: (next: ViewerGuides) => void;
}

/** The ruler band's thickness, CSS px. */
export const RULER_SIZE = 16;

/** A "nice" tick step (1, 2, 5 × 10ⁿ content px) at least `minPx` stage px apart. */
export function rulerStep(scale: number, minPx = 56): number {
  if (!(scale > 0)) return 100;
  const raw = minPx / scale;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

interface Tick {
  /** Stage px along the ruler. */
  at: number;
  label: string;
}

function ticksFor(length: number, origin: number, scale: number): Tick[] {
  if (!(scale > 0) || length <= 0) return [];
  const step = rulerStep(scale);
  const first = Math.ceil((RULER_SIZE - origin) / scale / step) * step;
  const out: Tick[] = [];
  for (let v = first; out.length < 400; v += step) {
    const at = origin + v * scale;
    if (at > length) break;
    out.push({ at, label: String(Math.round(v)) });
  }
  return out;
}

type Drag = { axis: 'x' | 'y'; index: number | null };

export function ViewerRulers({ width, height, scale, originX, originY, guides, onGuidesChange }: ViewerRulersProps): JSX.Element | null {
  const rootRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  /**
   * The guide being dragged, in content px (value null = over its ruler: it
   * will be removed). `index` names an existing guide; null is a new one.
   */
  const [live, setLive] = useState<{ axis: 'x' | 'y'; index: number | null; value: number | null } | null>(null);
  if (width <= 0 || height <= 0 || !(scale > 0)) return null;

  const valueAt = (e: ReactPointerEvent, axis: 'x' | 'y'): number | null => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return null;
    const px = axis === 'x' ? e.clientX - r.left : e.clientY - r.top;
    // Back on the ruler it came from: let go of it there and it is gone.
    if (px < RULER_SIZE) return null;
    return Math.round((px - (axis === 'x' ? originX : originY)) / scale);
  };
  const begin = (e: ReactPointerEvent, axis: 'x' | 'y', index: number | null): void => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { axis, index };
    setLive({ axis, index, value: valueAt(e, axis) });
  };
  const move = (e: ReactPointerEvent): void => {
    const d = drag.current;
    if (!d) return;
    setLive({ axis: d.axis, index: d.index, value: valueAt(e, d.axis) });
  };
  const end = (e: ReactPointerEvent): void => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setLive(null);
    const value = valueAt(e, d.axis);
    const list = [...guides[d.axis]];
    if (d.index !== null) list.splice(d.index, 1);
    if (value !== null) list.push(value);
    onGuidesChange({ ...guides, [d.axis]: list });
  };

  const xTicks = ticksFor(width, originX, scale);
  const yTicks = ticksFor(height, originY, scale);
  // A guide being moved stays MOUNTED (its element holds the pointer capture)
  // and follows the pointer; over the ruler it hides, to say it will go.
  const posOf = (axis: 'x' | 'y', i: number, v: number): { value: number; hidden: boolean } =>
    live && live.axis === axis && live.index === i ? { value: live.value ?? v, hidden: live.value === null } : { value: v, hidden: false };

  return (
    <div ref={rootRef} className={styles.root} data-viewer-rulers="">
      {guides.x.map((v, i) => {
        const p = posOf('x', i, v);
        return (
          <div
            key={`x${i}`}
            className={styles.guideX}
            style={{ left: originX + p.value * scale, opacity: p.hidden ? 0 : undefined }}
            title={`Guide at ${v} px — drag to move, drag onto the ruler to remove`}
            onPointerDown={(e) => begin(e, 'x', i)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
          />
        );
      })}
      {guides.y.map((v, i) => {
        const p = posOf('y', i, v);
        return (
          <div
            key={`y${i}`}
            className={styles.guideY}
            style={{ top: originY + p.value * scale, opacity: p.hidden ? 0 : undefined }}
            title={`Guide at ${v} px — drag to move, drag onto the ruler to remove`}
            onPointerDown={(e) => begin(e, 'y', i)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
          />
        );
      })}
      {live && live.index === null && live.value !== null ? (
        live.axis === 'x'
          ? <div className={`${styles.guideX} ${styles.guideLive}`} style={{ left: originX + live.value * scale }}><span className={styles.readout}>{live.value}</span></div>
          : <div className={`${styles.guideY} ${styles.guideLive}`} style={{ top: originY + live.value * scale }}><span className={styles.readout}>{live.value}</span></div>
      ) : null}

      <div
        className={styles.rulerX}
        title="Drag down from the ruler to add a guide"
        onPointerDown={(e) => begin(e, 'y', null)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        {xTicks.map((t) => (
          <span key={t.at} className={styles.tickX} style={{ left: t.at }}>{t.label}</span>
        ))}
      </div>
      <div
        className={styles.rulerY}
        title="Drag right from the ruler to add a guide"
        onPointerDown={(e) => begin(e, 'x', null)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        {yTicks.map((t) => (
          <span key={t.at} className={styles.tickY} style={{ top: t.at }}><span>{t.label}</span></span>
        ))}
      </div>
      <div className={styles.corner} aria-hidden />
    </div>
  );
}
