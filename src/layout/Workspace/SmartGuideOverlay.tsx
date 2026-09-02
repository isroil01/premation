/**
 * SmartGuideOverlay — the measuring chrome Figma made standard, drawn over the
 * viewport while a gesture is in flight.
 *
 * ## What it adds
 *
 * The workspace has always drawn ALIGNMENT: a pink line saying "these two edges
 * agree". That is half of what a layout tool owes you. The other half is the
 * space between things — how far apart, and whether the gaps match — and until
 * now the only way to find that out was to read two positions out of the
 * inspector and subtract them by hand.
 *
 *   • **Distance badges.** The gap to the nearest neighbour on each side, in
 *     COMPOSITION pixels (not screen px — a measurement that changed as you
 *     zoomed would be useless), on a dimension line that touches both boxes.
 *   • **Equal-spacing runs.** When the dragged box sits at the same distance
 *     from its neighbour as that neighbour sits from ITS neighbour, the engine
 *     snaps the run even and every gap in it is drawn as a pink hatch bar —
 *     Figma's idiom, and the reason "distribute" is rarely needed by hand.
 *   • **Equal size.** A neighbour whose width or height matches the dragged
 *     box gets outlined, so "make these two cards the same" is something you
 *     can see happening rather than verify afterwards.
 *
 * ## Why SVG and not the canvas painter
 *
 * The snap lines are painted into the overlay canvas in `useWorkspace`, and
 * this could have gone there too. It didn't, for two reasons. The badges are
 * TYPE — they belong in the same token system as the rest of the chrome
 * (`--font-size-micro`, the theme's surface and border colours), and a canvas
 * painter can only get at those by parsing computed styles. And hatch bars are
 * a `<pattern>`, which SVG gives for free and 2D canvas makes you build.
 *
 * Everything here is geometry the ENGINE computed (see
 * `packages/workspace/src/snap/smartGuides.ts`); this file only draws it. The
 * numbers arrive in screen pixels with comp-pixel labels already attached, so
 * there is no projection maths in this component and no way for it to disagree
 * with the snapping that produced it.
 *
 * ## Alt-hover measuring
 *
 * Hold Alt with something selected and hover another layer: the same dimension
 * lines appear between the two, with no drag. The engine owns the rule (see
 * `Workspace.setMeasureHover`); this component owns the KEY, because the
 * workspace engine is only fed the keys the host chooses to forward and Alt is
 * not one of them.
 *
 * Pointer-transparent throughout — it must never take a click away from the
 * viewport beneath it.
 */

import { useEffect, useRef, useState } from 'react';
import type { SmartGuideOverlayData, SmartGuideSpan } from '@motion/workspace';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { useGuidesStore } from '@stores/guidesStore';
import styles from './SmartGuideOverlay.module.css';

/** Half-height of a hatch bar, px. Wide enough to read as a bar, not a line. */
const HATCH_HALF = 4;
/** Length of the little end ticks that cap a dimension line, px. */
const TICK = 5;
/** Badge box metrics — the label is `--font-size-micro` (10px). */
const BADGE_H = 14;
const BADGE_PAD = 5;
const CHAR_W = 6;

function badgeWidth(label: string): number {
  return Math.max(14, label.length * CHAR_W + BADGE_PAD * 2);
}

/**
 * Where a span's badge sits: centred on the dimension line when the gap is
 * wide enough to hold it, and pushed off to the side when it is not — a badge
 * wider than the gap it describes covers both boxes and reads as belonging to
 * neither.
 */
function badgeAnchor(span: SmartGuideSpan): { x: number; y: number } {
  const lo = Math.min(span.from, span.to);
  const hi = Math.max(span.from, span.to);
  const mid = (lo + hi) / 2;
  const w = badgeWidth(span.label);
  const fits = hi - lo >= w + 4;
  if (span.axis === 'x') {
    return fits ? { x: mid, y: span.cross } : { x: mid, y: span.cross - BADGE_H };
  }
  return fits ? { x: span.cross, y: mid } : { x: span.cross + w / 2 + 6, y: mid };
}

function Badge({ span }: { span: SmartGuideSpan }): React.JSX.Element {
  const { x, y } = badgeAnchor(span);
  const w = badgeWidth(span.label);
  return (
    <g>
      <rect
        className={styles.badge}
        x={x - w / 2}
        y={y - BADGE_H / 2}
        width={w}
        height={BADGE_H}
        rx={3}
      />
      <text className={styles.badgeText} x={x} y={y} textAnchor="middle" dominantBaseline="central">
        {span.label}
      </text>
    </g>
  );
}

function Span({ span }: { span: SmartGuideSpan }): React.JSX.Element {
  const lo = Math.min(span.from, span.to);
  const hi = Math.max(span.from, span.to);
  const horizontal = span.axis === 'x';
  if (span.equal) {
    // Equal-spacing run: a hatched bar filling the gap, Figma's idiom for
    // "these distances are the same" — deliberately NOT the same mark as a
    // plain measurement, so an equalized run is recognisable at a glance.
    const rect = horizontal
      ? { x: lo, y: span.cross - HATCH_HALF, width: hi - lo, height: HATCH_HALF * 2 }
      : { x: span.cross - HATCH_HALF, y: lo, width: HATCH_HALF * 2, height: hi - lo };
    return (
      <g>
        <rect className={styles.hatch} {...rect} />
        <Badge span={span} />
      </g>
    );
  }
  const line = horizontal
    ? { x1: lo, y1: span.cross, x2: hi, y2: span.cross }
    : { x1: span.cross, y1: lo, x2: span.cross, y2: hi };
  const caps = horizontal
    ? [
        { x1: lo, y1: span.cross - TICK, x2: lo, y2: span.cross + TICK },
        { x1: hi, y1: span.cross - TICK, x2: hi, y2: span.cross + TICK },
      ]
    : [
        { x1: span.cross - TICK, y1: lo, x2: span.cross + TICK, y2: lo },
        { x1: span.cross - TICK, y1: hi, x2: span.cross + TICK, y2: hi },
      ];
  return (
    <g>
      <line className={styles.dim} {...line} />
      {caps.map((c, i) => (
        <line key={i} className={styles.dim} {...c} />
      ))}
      <Badge span={span} />
    </g>
  );
}

export function SmartGuideOverlay(): React.JSX.Element | null {
  const [data, setData] = useState<SmartGuideOverlayData | null>(null);
  const enabled = useGuidesStore((s) => s.smartGuides);
  // Read inside the effect without making the subscription depend on it: the
  // Alt listeners are installed once and must not be torn down on every toggle.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // The preference is the ENGINE's switch: it gates the equal-spacing magnet as
  // well as this chrome, so pushing it down is what makes the menu row mean
  // "smart guides off" rather than "smart guides invisible".
  useEffect(() => {
    getWorkspaceController().ws.setSnap({ smartGuides: enabled });
  }, [enabled]);

  useEffect(() => {
    const ws = getWorkspaceController().ws;
    const setMeasuring = (on: boolean): void => ws.setMeasureHover(on && enabledRef.current);
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.altKey) setMeasuring(true);
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (!e.altKey) setMeasuring(false);
    };
    // Alt-Tab and any Alt-driven menu take the key-up with them; without this
    // the overlay would measure forever after the window came back.
    const onBlur = (): void => setMeasuring(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      ws.setMeasureHover(false);
    };
  }, []);

  useEffect(() => {
    const controller = getWorkspaceController();
    const tick = (): void => {
      // `null → null` is a no-op re-render in React, so an idle viewport costs
      // nothing here however often the renderer ticks.
      setData(controller.ws.overlay().smartGuides ?? null);
    };
    tick();
    return controller.onRender(tick);
  }, []);

  if (!enabled || !data || data.spans.length === 0) return null;

  return (
    <svg className={styles.overlay} data-smart-guides={data.measuring ? 'measuring' : 'gesture'}>
      <defs>
        <pattern id="smartGuideHatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line className={styles.hatchLine} x1="0" y1="0" x2="0" y2="4" />
        </pattern>
      </defs>
      {data.sizeMatches.map((r, i) => (
        <rect
          key={`size-${i}`}
          className={styles.sizeMatch}
          x={r.x}
          y={r.y}
          width={r.width}
          height={r.height}
        />
      ))}
      {data.spans.map((span, i) => (
        <Span key={`span-${i}`} span={span} />
      ))}
    </svg>
  );
}

export default SmartGuideOverlay;
