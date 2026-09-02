/**
 * MotionEditorPanel — the layer's motion TOOLS, wrapped around the shared graph.
 *
 * ── What changed, and why it had to ─────────────────────────────────────────
 *
 * This panel used to carry its own curve editor: a second SVG, a second
 * keyframe drag, a second easing vocabulary, a second idea of what "selected"
 * meant. It and `Timeline/GraphEditor` disagreed about all four. The panel
 * edited exactly ONE keyframe (its own `selT`) while the timeline, F9 and the
 * easing pills operated on the shared keyframe SELECTION; the panel wrote
 * `easing: 'hold'` where the shared path wrote `'step'`; the panel's Easy Ease
 * button and its "Smooth" chip applied two different curves under names that
 * suggested one. Anything fixed in one graph stayed broken in the other —
 * snapping, box zoom, the frozen drag range, the reference curve, the property
 * filter, multi-track plotting: all of that existed only in the timeline's.
 *
 * So there is now ONE graph editor component and this panel HOSTS it. What the
 * panel keeps is what a graph is not:
 *
 *   • Motion Path & Orientation (auto-orient, smooth/straighten)
 *   • the Bounce generator, on its own workspace tab
 *   • the expression editor for one chosen property
 *
 * The easing selector, rove toggle, ease copy/paste and ease library that used
 * to sit under the panel's curve moved INTO the shared editor's toolbar, where
 * they act on the keyframe selection instead of on one keyframe.
 *
 * The panel gives the graph its own viewport (it has no timeline ruler to
 * borrow one from): pixels-per-second is fitted to the panel width until the
 * user zooms, after which their zoom is kept.
 */

import { useMemo, useState } from 'react';
import { cn } from '@utils/cn';
import { EmptyState } from '@components/EmptyState';
import { useSelectionStore } from '@stores/selectionStore';
import { useWorkspaceStore } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useSceneRevision } from '@stores/sceneStore';
import { defaultAnimation } from '@motion/animation';
import { Icon } from '@components/Icon';
import { Tabs } from '@components/Tabs';
import { useResizeObserver } from '@hooks/useResizeObserver';
import { GraphEditor } from '@layout/Timeline/GraphEditor';
import { ExpressionEditor } from './ExpressionEditor';
import { BounceSection } from './BounceSection';
import { MotionControls } from '@layout/Inspector/MotionControls';
import styles from './MotionEditorPanel.module.css';

/**
 * Motion-path options (auto-orient, smooth/straighten, separate dimensions).
 * Moved here from the Properties inspector so the Motion tab is the single home
 * for a layer's motion — Properties now covers style only.
 */
function MotionPathBlock({ nodeId }: { nodeId: string }): JSX.Element {
  return (
    <details className={styles.fold}>
      <summary className={styles.foldSummary}>Motion Path &amp; Orientation</summary>
      <div className={styles.foldBody}>
        <MotionControls nodeId={nodeId} />
      </div>
    </details>
  );
}

/** Below this the graph is a stripe, not a graph — the panel scrolls instead. */
const MIN_PPS = 4;
/** Fallback zoom before the panel has been measured (first paint, or no comp). */
const FALLBACK_PPS = 60;

export function MotionEditorPanel(): JSX.Element {
  const primary = useSelectionStore((s) => s.primary);
  const selectedIds = useSelectionStore((s) => s.ids);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const playhead = useWorkspaceStore((s) => (activeTabId ? s.tabs[activeTabId]?.time : 0) ?? 0);
  const duration = useCompositionStore((s) => s.durationSeconds);
  const fps = useCompositionStore((s) => s.fps);
  // The engine mutates keyframes in place, so the track keeps its reference.
  // Bump-driven `rev` is what tells the property list to recompute.
  const rev = useSceneRevision((s) => s.rev);

  const propList = useMemo(
    () => (primary ? defaultAnimation.animatedProps(primary) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [primary, rev],
  );
  const [propState, setProp] = useState<string | null>(null);
  const prop = propState && propList.includes(propState) ? propState : propList[0] ?? null;
  const [workspace, setWorkspace] = useState<'curve' | 'bounce'>('curve');

  // ── The graph's viewport ──────────────────────────────────────
  // The timeline hands its GraphEditor a ruler's worth of view state. Here
  // there is no ruler, so the panel owns it: fit to width until the user zooms
  // (ctrl/⌘+wheel or an Alt box-zoom), then keep what they chose — a fit that
  // re-asserted itself would undo the zoom on the next re-render.
  const { ref: graphHostRef, size } = useResizeObserver<HTMLDivElement>();
  const [zoomedPps, setZoomedPps] = useState<number | null>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const fittedPps =
    size.width > 0 && duration > 0 ? Math.max(MIN_PPS, size.width / duration) : FALLBACK_PPS;
  const pps = zoomedPps ?? fittedPps;

  if (!primary) {
    return (
      <EmptyState
        icon="graph-value"
        title="No selection"
        message="Select a layer to shape its keyframe curves, or generate a bounce."
      />
    );
  }

  return (
    <div className={styles.shell}>
      <Tabs
        value={workspace}
        onChange={(id) => setWorkspace(id as 'curve' | 'bounce')}
        size="sm"
        variant="bordered"
        className={styles.workspaceTabs}
        items={[
          { id: 'curve', label: 'Curve', icon: <Icon name="graph-value" size="sm" />, ariaLabel: 'Keyframe curve' },
          { id: 'bounce', label: 'Bounce', icon: <Icon name="ease" size="sm" />, ariaLabel: 'Bounce generator' },
        ]}
      />

      {workspace === 'bounce' ? (
        <div className={styles.bounceBody} role="tabpanel" aria-label="Bounce">
          <BounceSection nodeId={primary} />
        </div>
      ) : (
        <div className={styles.body} role="tabpanel" aria-label="Keyframe curve">
          {/* The shared editor. Same component, same toolbar, same keyframe
              selection as the timeline's — only the viewport is local. */}
          <div className={styles.graphHost} ref={graphHostRef}>
            <GraphEditor
              selectedNodeIds={selectedIds}
              currentTime={playhead}
              duration={duration}
              pixelsPerSecond={pps}
              scrollLeft={scrollLeft}
              onScrollChange={setScrollLeft}
              onZoom={setZoomedPps}
              frameRate={fps}
              onScrub={(t) => getTimelineController().seekSeconds(t)}
            />
          </div>

          <MotionPathBlock nodeId={primary} />

          {prop ? (
            <>
              {/* Which property the expression below drives. The graph plots
                  every animated property at once, so this is no longer the
                  graph's subject — only the expression's. */}
              <h3 className={styles.sectionLabel}>Expression</h3>
              <div className={styles.props} role="radiogroup" aria-label="Animated property">
                {propList.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={cn(styles.propChip, p === prop && styles.propChipOn)}
                    role="radio"
                    aria-checked={p === prop}
                    onClick={() => setProp(p)}
                  >
                    {p}
                  </button>
                ))}
              </div>
              <ExpressionEditor nodeId={primary} prop={prop} />
            </>
          ) : (
            <EmptyState
              compact
              icon="keyframe"
              title="No keyframes"
              message="Add a keyframe on the timeline, apply a preset, or switch to Bounce to generate motion from scratch."
            />
          )}
        </div>
      )}
    </div>
  );
}

export default MotionEditorPanel;
