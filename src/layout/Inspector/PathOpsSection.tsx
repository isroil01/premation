/**
 * Pathfinder — the boolean path operations, given a surface.
 *
 * ## Why this exists
 *
 * Both engines shipped complete. `liveMergeSelectedPaths` (operands stay
 * editable and animatable, the result re-evaluates every frame) and
 * `mergeSelectedPaths` (a one-shot bake) were reachable from a "Merge Paths"
 * submenu inside the Scene panel's node kebab — which you find by
 * right-clicking two selected layers and hoping — and, after the last batch,
 * from the command palette if you knew to search for it. Neither is a place a
 * designer looks for a pathfinder. Every vector tool puts these four buttons
 * next to the shape, so that is where they are now.
 *
 * ## Nothing here implements a boolean
 *
 * Every button dispatches a REGISTERED COMMAND (`shape.boolean.<op>` for live,
 * `shape.merge<Op>` for the bake) rather than calling the merge functions
 * directly. Three doors — kebab, palette, this panel — onto one implementation,
 * so the notification, the enablement rule and the undo entry are identical
 * whichever you use, and a user's rebound shortcut for "Path Operation: Union"
 * does the same thing this button does.
 *
 * ## Why the glyphs are drawn here
 *
 * The icon set is generated from Material Symbols Sharp and has no pathfinder
 * glyphs — Providers falls back to `layers` for all four, which is honest for a
 * palette row but useless as a button, because the four ops are told apart by
 * WHICH REGION IS FILLED and nothing else. Two overlapping squares with the
 * right region filled is the diagram every vector app uses, and it reads at
 * 16px in a way four identical stacks never could. Local SVG rather than new
 * icon names: these are diagrams of an operation, not glyphs with a life
 * outside this row.
 */

import { useState } from 'react';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { asCommandId } from '@app-types/common';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useUIStore } from '@stores/uiStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { Icon } from '@components/Icon';
import styles from './PathOpsSection.module.css';

/** Which command family the four op buttons dispatch into. */
type Mode = 'live' | 'bake';

interface OpDef {
  op: 'union' | 'subtract' | 'intersect' | 'exclude';
  label: string;
  /** The BAKE command id, which predates the live ones and cannot be renamed:
   *  it is the key into the user's persisted shortcut overrides. */
  bakeId: string;
  glyph: JSX.Element;
}

// Two overlapping 8×8 squares in a 16 box. `A` is the top layer in the
// selection order the ops use, `B` everything below it — which is what makes
// Subtract's direction legible rather than something to look up.
const A = 'M2 2h8v8H2z';
const B = 'M6 6h8v8H6z';
const OVERLAP = 'M6 6h4v4H6z';

function Glyph({ fill, ghost, evenOdd }: { fill: string; ghost?: string; evenOdd?: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      {ghost && <path d={ghost} fill="none" stroke="currentColor" strokeWidth="1" opacity="0.45" />}
      <path d={fill} fill="currentColor" fillRule={evenOdd ? 'evenodd' : 'nonzero'} />
    </svg>
  );
}

const OPS: readonly OpDef[] = [
  { op: 'union', label: 'Union (Add)', bakeId: 'shape.mergeUnion', glyph: <Glyph fill={`${A} ${B}`} /> },
  // A with the overlap punched out, and B outlined so it is clear WHAT was
  // subtracted rather than just that something was.
  { op: 'subtract', label: 'Subtract (top minus below)', bakeId: 'shape.mergeSubtract', glyph: <Glyph fill={`${A} ${OVERLAP}`} evenOdd ghost={B} /> },
  { op: 'intersect', label: 'Intersect', bakeId: 'shape.mergeIntersect', glyph: <Glyph fill={OVERLAP} ghost={`${A} ${B}`} /> },
  { op: 'exclude', label: 'Exclude (XOR)', bakeId: 'shape.mergeExclude', glyph: <Glyph fill={`${A} ${B}`} evenOdd /> },
];

function run(id: string): void {
  void getCommandSystem().execute(asCommandId(id));
}

/**
 * Shown when the selection holds at least one shape layer. The four ops need
 * TWO, so they disable rather than disappear — a pathfinder that vanishes when
 * you have one shape selected teaches nothing about why.
 */
export function PathOpsSection(): JSX.Element | null {
  const selectedIds = useSelectionStore((s) => s.ids);
  const setTool = useUIStore((s) => s.setActiveTool);
  const activeTool = useUIStore((s) => s.activeTool);
  const [mode, setMode] = useState<Mode>('live');
  useSceneRevision((s) => s.rev);

  const shapeCount = selectedIds.filter((id) => {
    const node = defaultSceneGraph.getNode(id);
    return !!node && readNodeKind(node) === 'shape';
  }).length;
  if (shapeCount === 0) return null;

  const canCombine = selectedIds.length >= 2;
  const hint = canCombine
    ? mode === 'live'
      ? 'Operands stay editable and animatable; the result re-evaluates every frame.'
      : 'One-shot: the sources are consumed and the result is static geometry.'
    : 'Select two or more shape layers to combine.';

  return (
    <div className={styles.root}>
      <div className={styles.modeRow}>
        <span className={styles.modeLabel}>Result</span>
        <div className={styles.modeToggles}>
          <button
            type="button"
            className={mode === 'live' ? styles.modeBtnActive : styles.modeBtn}
            onClick={() => setMode('live')}
            title="Live — sources stay in the scene as editable operands"
            aria-pressed={mode === 'live'}
          >
            Live
          </button>
          <button
            type="button"
            className={mode === 'bake' ? styles.modeBtnActive : styles.modeBtn}
            onClick={() => setMode('bake')}
            title="Bake now — sources are consumed and the result is static"
            aria-pressed={mode === 'bake'}
          >
            Bake now
          </button>
        </div>
      </div>

      <div className={styles.grid}>
        {OPS.map((o) => (
          <button
            key={o.op}
            type="button"
            className={styles.opButton}
            aria-label={`${o.label}${mode === 'bake' ? ' (bake)' : ''}`}
            title={`${o.label}${canCombine ? '' : ' — select 2+ shape layers'}`}
            disabled={!canCombine}
            onClick={() => run(mode === 'live' ? `shape.boolean.${o.op}` : o.bakeId)}
          >
            {o.glyph}
          </button>
        ))}
      </div>

      <p className={styles.hint}>{hint}</p>

      <div className={styles.actions}>
        {/* AE's own named operation, and the one people search for by name. It
            is Bake ▸ Union, but a user who wants "Merge Paths" should not have
            to know that it is spelled as a mode plus an operator. */}
        <button
          type="button"
          className={styles.action}
          disabled={!canCombine}
          title={canCombine ? 'Merge the selected paths into one static layer' : 'Select 2+ shape layers'}
          onClick={() => run('shape.mergeUnion')}
        >
          <Icon name="layers" size="sm" />
          <span>Merge Paths (bake)</span>
        </button>
        <button
          type="button"
          className={activeTool === 'knife' ? styles.actionActive : styles.action}
          aria-pressed={activeTool === 'knife'}
          title="Knife — drag a line across the shape; every crossing splits its path"
          onClick={() => setTool('knife')}
        >
          <Icon name="scissors" size="sm" />
          <span>Knife</span>
        </button>
      </div>
    </div>
  );
}

export default PathOpsSection;
