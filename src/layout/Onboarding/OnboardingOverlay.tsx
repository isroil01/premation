/**
 * OnboardingOverlay — the first-run tour, drawn over the live editor.
 *
 * ## It does not block the app
 *
 * This is the whole design constraint, and it is why the scrim is an SVG mask
 * rather than a `<div>` with a background. Half the steps ask the user to DO
 * something — draw a shape, set a keyframe, press play — so every layer of this
 * overlay is `pointer-events: none` except the card itself. A tour that has to
 * be dismissed before the thing it describes can be tried is a slideshow.
 *
 * The mask is one full-viewport rect punched through by a rounded rect around
 * the anchor's bounding box. Compared with the usual four-divs-around-a-hole
 * trick it gives real corner rounding and one element to animate, and compared
 * with a `box-shadow: 0 0 0 9999px` ring it does not blow out on a large
 * viewport or fight the compositor.
 *
 * ## Measurement
 *
 * The anchor is found by selector, not by ref — the tour points at controls in
 * seven different subtrees, several of which are lazily mounted, and threading
 * a ref out of each would put tour plumbing in files that have nothing to do
 * with the tour. Re-measured on window resize, on scroll (capture phase, so
 * scrolling ANY container counts), by a ResizeObserver on the anchor, and on a
 * slow beat that also picks the element up when it mounts late. Every one of
 * those paths funnels into a single rAF-coalesced `measure`, so a scroll and a
 * resize in the same frame cost one measurement.
 *
 * ## When the anchor is not there
 *
 * A closed panel is not an error. The card centres itself, drops the spotlight,
 * and shows the step's `whenMissing` line, which says how to bring the control
 * back. The step still advances normally — its `check` is about the stores, not
 * about whether a panel happens to be open.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from '@components/Icon';
import { Button } from '@components/Button';
import { cn } from '@utils/cn';
import { positionPopover, type Placement } from '@hooks/positionPopover';
import {
  useOnboardingStore,
  TOUR_STEPS,
  type TourActionKind,
  type TourStep,
} from '@stores/onboardingStore';
import styles from './OnboardingOverlay.module.css';

/** Breathing room between the anchor's box and the hole cut around it, px. */
const SPOTLIGHT_PAD = 6;
/** Corner radius of the hole, px. */
const SPOTLIGHT_RADIUS = 10;
/** Extra gap between the spotlight edge and the card, px. */
const CARD_GAP = 10;
/** Re-measure beat for layout the browser does not report (panel resizes). */
const REMEASURE_MS = 500;

const ACTION_ICON: Readonly<Record<TourActionKind, IconName>> = {
  click: 'mouse-pointer',
  tool: 'shape',
  create: 'layer-plus',
  keyframe: 'keyframe',
};

interface AnchorState {
  el: HTMLElement | null;
  rect: DOMRect | null;
}

function sameRect(a: DOMRect | null, b: DOMRect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

/**
 * Track the element matching `selector` and its viewport rect.
 *
 * Returns the element too, because `positionPopover` wants a real trigger —
 * handing it the live element rather than a synthesised rect means the card and
 * the spotlight can never disagree about where the anchor is.
 */
function useAnchorRect(selector: string): AnchorState {
  const [state, setState] = useState<AnchorState>({ el: null, rect: null });

  useEffect(() => {
    let alive = true;
    let raf = 0;
    let observed: HTMLElement | null = null;
    let ro: ResizeObserver | null = null;

    const measure = (): void => {
      raf = 0;
      if (!alive) return;
      const el = document.querySelector<HTMLElement>(selector);
      if (el !== observed) {
        observed = el;
        ro?.disconnect();
        ro = null;
        if (el && typeof ResizeObserver !== 'undefined') {
          ro = new ResizeObserver(schedule);
          ro.observe(el);
        }
      }
      const rect = el ? el.getBoundingClientRect() : null;
      setState((prev) => (prev.el === el && sameRect(prev.rect, rect) ? prev : { el, rect }));
    };

    const schedule = (): void => {
      if (raf !== 0) return;
      raf = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(measure)
        : (setTimeout(measure, 16) as unknown as number);
    };

    schedule();
    window.addEventListener('resize', schedule);
    // Capture phase: a scroll inside any panel moves the anchor too, and those
    // events do not bubble to window.
    window.addEventListener('scroll', schedule, true);
    const beat = setInterval(schedule, REMEASURE_MS);

    return () => {
      alive = false;
      clearInterval(beat);
      if (raf !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [selector]);

  return state;
}

/** Push the card away from the spotlight along the requested side. */
function gapOffset(placement: Placement): { x: number; y: number } {
  const side = placement.split('-')[0];
  if (side === 'top') return { x: 0, y: -(SPOTLIGHT_PAD + CARD_GAP) };
  if (side === 'bottom') return { x: 0, y: SPOTLIGHT_PAD + CARD_GAP };
  if (side === 'left') return { x: -(SPOTLIGHT_PAD + CARD_GAP), y: 0 };
  return { x: SPOTLIGHT_PAD + CARD_GAP, y: 0 };
}

function Spotlight({ rect }: { rect: DOMRect }): JSX.Element {
  const x = Math.max(0, rect.left - SPOTLIGHT_PAD);
  const y = Math.max(0, rect.top - SPOTLIGHT_PAD);
  const w = rect.width + SPOTLIGHT_PAD * 2;
  const h = rect.height + SPOTLIGHT_PAD * 2;
  return (
    <svg className={styles.spotlight} aria-hidden="true">
      <defs>
        <mask id="onb-spotlight-mask">
          {/* White keeps the scrim, black punches the hole through it. */}
          <rect x="0" y="0" width="100%" height="100%" fill="white" />
          <rect x={x} y={y} width={w} height={h} rx={SPOTLIGHT_RADIUS} ry={SPOTLIGHT_RADIUS} fill="black" />
        </mask>
      </defs>
      <rect
        x="0"
        y="0"
        width="100%"
        height="100%"
        className={styles.scrimFill}
        mask="url(#onb-spotlight-mask)"
      />
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={SPOTLIGHT_RADIUS}
        ry={SPOTLIGHT_RADIUS}
        className={styles.spotlightRing}
      />
    </svg>
  );
}

/**
 * The running tour. Split from the exported component so that every hook below
 * runs only while the tour is up — measuring, listening and beating on an
 * overlay that is not rendered would be pure cost for the 99% of sessions where
 * the tour has already been taken.
 */
function TourLayer({ onDone }: { onDone: () => void }): JSX.Element {
  const index = useOnboardingStore((s) => s.index);
  const next = useOnboardingStore((s) => s.next);
  const back = useOnboardingStore((s) => s.back);
  const skip = useOnboardingStore((s) => s.skip);
  const setDontShowAgain = useOnboardingStore((s) => s.setDontShowAgain);

  const step: TourStep = TOUR_STEPS[index] ?? TOUR_STEPS[0]!;
  const isFirst = index === 0;
  const isLast = index === TOUR_STEPS.length - 1;

  const { el, rect } = useAnchorRect(step.anchor);
  // A zero-area rect is an element that is present but not laid out (a
  // display:none ancestor, or jsdom). Treated as absent: a spotlight around
  // nothing points at nothing.
  const anchored = el !== null && rect !== null && rect.width > 0 && rect.height > 0;

  const cardRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; placement: Placement } | null>(null);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!anchored || !el || !card) {
      setPos(null);
      return;
    }
    setPos(positionPopover(el, card, step.placement, gapOffset(step.placement)));
    // `rect` is in the deps so the card follows the anchor as it moves; the
    // effect is cheap and idempotent.
  }, [anchored, el, rect, step.placement]);

  const close = useCallback((): void => {
    skip();
    onDone();
  }, [skip, onDone]);

  const advance = useCallback((): void => {
    if (isLast) {
      close();
      return;
    }
    next();
  }, [isLast, close, next]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        advance();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, advance]);

  const cardStyle = anchored && pos
    ? { top: pos.top, left: pos.left }
    : undefined;

  return (
    <div className={styles.layer} role="dialog" aria-label="Welcome tour" aria-live="polite">
      {anchored && rect ? <Spotlight rect={rect} /> : <div className={styles.plainScrim} aria-hidden="true" />}

      <div
        ref={cardRef}
        className={cn(styles.card, (!anchored || !pos) && styles.cardCentered)}
        style={cardStyle}
        data-placement={pos?.placement ?? 'center'}
      >
        <div className={styles.head}>
          <span className={styles.badge}><Icon name="tour" size="sm" /></span>
          <span className={styles.count}>Step {index + 1} of {TOUR_STEPS.length}</span>
        </div>

        <h2 className={styles.title}>{step.title}</h2>
        <p className={styles.body}>{step.body}</p>

        {step.action ? (
          <div className={styles.task}>
            <Icon name={ACTION_ICON[step.action.kind]} size="sm" />
            <span>{step.action.hint}</span>
          </div>
        ) : null}

        {!anchored && step.whenMissing ? (
          <div className={styles.missing}>
            <Icon name="info" size="sm" />
            <span>{step.whenMissing}</span>
          </div>
        ) : null}

        {isFirst ? (
          <label className={styles.optOut}>
            <input
              type="checkbox"
              onChange={(e) => {
                setDontShowAgain(e.target.checked);
              }}
            />
            Don&rsquo;t show this again
          </label>
        ) : null}

        <div className={styles.dots} role="presentation">
          {TOUR_STEPS.map((s, i) => (
            <span key={s.id} className={cn(styles.dot, i === index && styles.dotOn)} />
          ))}
        </div>

        <div className={styles.footer}>
          <button type="button" className={styles.skip} onClick={close}>Skip tour</button>
          <div className={styles.nav}>
            {!isFirst ? <Button variant="secondary" size="sm" onClick={back}>Back</Button> : null}
            <Button variant="primary" size="sm" onClick={advance}>
              {isLast ? 'Done' : 'Next'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function OnboardingOverlay({ onDone }: { onDone: () => void }): JSX.Element | null {
  const active = useOnboardingStore((s) => s.active);

  // The editor shell is now up. This is what lets the store distinguish the
  // first-run auto-start (which happens during boot, before this mounts) from
  // someone deliberately choosing Take the Tour.
  useEffect(() => {
    useOnboardingStore.getState().onEditorMounted();
  }, []);

  if (!active) return null;
  return createPortal(<TourLayer onDone={onDone} />, document.body);
}

export default OnboardingOverlay;
