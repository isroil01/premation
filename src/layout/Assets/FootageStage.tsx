/**
 * The Footage viewer's stage: the file's picture under the viewer's own camera.
 *
 * Fit by default; the wheel zooms about the pointer and the middle button (or
 * a drag with the Hand tool) moves the view, as in the Composition and Layer
 * viewers. Exposure is a brightness on the picture only. Rulers read in the
 * file's pixels and guides are stored in them (`footageViewStore`).
 *
 * A file with no known size (audio; a clip the probe could not measure) is
 * laid out as it is — there is nothing to zoom against.
 */

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from 'react';
import { ViewerRulers } from '@components/ViewerRulers/ViewerRulers';
import { FOOTAGE_ZOOM_MAX, FOOTAGE_ZOOM_MIN, useFootageViewStore } from '@stores/footageViewStore';
import { useUIStore } from '@stores/uiStore';
import styles from './FootageStage.module.css';

/** Fit leaves this much of the stage around the picture. */
const FIT_MARGIN = 0.92;

export interface FootageStageProps {
  /** The file's own size in pixels; absent = not zoomable. */
  natural?: { width: number; height: number } | null;
  /** The transparency grid behind the picture (stills with alpha). */
  checker?: boolean;
  /** The media element(s). They fill the picture box. */
  children: ReactNode;
}

/** The scale Fit uses for a `natural` picture on a stage, and the scale in use. */
export function footageScale(stage: { width: number; height: number }, natural: { width: number; height: number }, zoom: number | null): number {
  if (zoom !== null) return zoom;
  if (stage.width <= 0 || stage.height <= 0) return 0;
  return Math.min(stage.width / natural.width, stage.height / natural.height) * FIT_MARGIN;
}

export function FootageStage({ natural, checker = false, children }: FootageStageProps): JSX.Element {
  const zoom = useFootageViewStore((s) => s.zoom);
  const panX = useFootageViewStore((s) => s.panX);
  const panY = useFootageViewStore((s) => s.panY);
  const exposure = useFootageViewStore((s) => s.exposure);
  const showRulers = useFootageViewStore((s) => s.showRulers);
  const guides = useFootageViewStore((s) => s.guides);
  const setZoom = useFootageViewStore((s) => s.setZoom);
  const setPan = useFootageViewStore((s) => s.setPan);
  const setGuides = useFootageViewStore((s) => s.setGuides);
  const handTool = useUIStore((s) => s.activeTool === 'hand');

  const ref = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = (): void => {
      const r = el.getBoundingClientRect();
      setStage((prev) => (prev.width === r.width && prev.height === r.height ? prev : { width: r.width, height: r.height }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const sized = natural && natural.width > 0 && natural.height > 0 ? natural : null;
  const scale = sized ? footageScale(stage, sized, zoom) : 0;
  const cx = stage.width / 2 + (zoom === null ? 0 : panX);
  const cy = stage.height / 2 + (zoom === null ? 0 : panY);
  const filter = exposure !== 0 ? `brightness(${Math.pow(2, exposure).toFixed(4)})` : undefined;

  const onWheel = (e: ReactWheelEvent<HTMLDivElement>): void => {
    if (!sized || scale <= 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const next = Math.min(FOOTAGE_ZOOM_MAX, Math.max(FOOTAGE_ZOOM_MIN, scale * Math.exp(-e.deltaY * 0.0015)));
    // The point under the pointer stays under it.
    setZoom(next, px - (px - cx) * (next / scale) - stage.width / 2, py - (py - cy) * (next / scale) - stage.height / 2);
  };
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const onDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!sized || (e.button !== 1 && !(e.button === 0 && handTool))) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, px: cx - stage.width / 2, py: cy - stage.height / 2 };
    if (zoom === null) setZoom(scale, 0, 0);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (d) setPan(d.px + (e.clientX - d.x), d.py + (e.clientY - d.y));
  };
  const onUp = (): void => {
    drag.current = null;
  };

  // ONE structure in both modes: the media elements must not remount when the
  // stage is first measured or the file's size arrives (a remounted <video>
  // loses its listeners and the point the frame stepper resumes from).
  const placed = sized !== null && scale > 0;
  const w = placed ? sized.width * scale : 0;
  const h = placed ? sized.height * scale : 0;
  const box: CSSProperties = placed
    ? { left: cx - w / 2, top: cy - h / 2, width: w, height: h, ...(filter ? { filter } : {}) }
    : filter ? { filter } : {};
  return (
    <div
      ref={ref}
      className={styles.stage}
      data-footage-stage=""
      data-hand={(placed && handTool) || undefined}
      onWheel={onWheel}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <div className={placed ? (checker ? `${styles.picture} ${styles.checker}` : styles.picture) : styles.loose} style={box}>
        {children}
      </div>
      {placed && showRulers ? (
        <ViewerRulers
          width={stage.width}
          height={stage.height}
          scale={scale}
          originX={cx - w / 2}
          originY={cy - h / 2}
          guides={guides}
          onGuidesChange={setGuides}
        />
      ) : null}
    </div>
  );
}
