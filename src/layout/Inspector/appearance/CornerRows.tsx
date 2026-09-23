/**
 * The Corners group of the Fill & Stroke section: the link switch, the
 * uniform radius, and the four individual corners.
 *
 * Split out of `AppearanceSection.tsx` (2026-09-04) with its six
 * `useNodeComponentProp` bindings; every write path is what the section ran
 * inline. The rows read the PRIMARY layer only — a corner write is six props
 * under one history key, bound to this node's Style component, and fanning
 * that out is a change for another day. With several layers selected the
 * row says so ("1 of 3").
 */

import { ValueField } from '@components/ValueField';
import { Icon } from '@components/Icon';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import { batchHistory } from '@stores/historyStore';
import type { PropertyAccess } from '@core/inspector/multiSelection';
import { AnimatablePaintRow } from './AnimatablePaintRow';
import styles from '../TransformSection.module.css';

export function CornerRows({ nodeId, styleCompId }: { nodeId: string; styleCompId: string }): JSX.Element | null {
  // B3-legacy: engine gap — per-corner radii (cornerRadii) are not catalog properties; linked writes need one entry.
  const [cornerRadiusRaw, setCornerRadius] = useNodeComponentProp(defaultSceneGraph, nodeId, styleCompId, 'cornerRadius');
  const cornerRadius = typeof cornerRadiusRaw === 'number' ? cornerRadiusRaw : 0;
  const [cornerTLRaw, setCornerTL] = useNodeComponentProp(defaultSceneGraph, nodeId, styleCompId, 'cornerRadiusTL');
  const [cornerTRRaw, setCornerTR] = useNodeComponentProp(defaultSceneGraph, nodeId, styleCompId, 'cornerRadiusTR');
  const [cornerBRRaw, setCornerBR] = useNodeComponentProp(defaultSceneGraph, nodeId, styleCompId, 'cornerRadiusBR');
  // B3-legacy: engine gap — per-corner radii (cornerRadii) are not catalog properties; linked writes need one entry.
  const [cornerBLRaw, setCornerBL] = useNodeComponentProp(defaultSceneGraph, nodeId, styleCompId, 'cornerRadiusBL');
  const [cornersLinkedRaw, setCornersLinked] = useNodeComponentProp(defaultSceneGraph, nodeId, styleCompId, 'cornersLinked');
  const cornerTL = typeof cornerTLRaw === 'number' ? cornerTLRaw : cornerRadius;
  const cornerTR = typeof cornerTRRaw === 'number' ? cornerTRRaw : cornerRadius;
  const cornerBR = typeof cornerBRRaw === 'number' ? cornerBRRaw : cornerRadius;
  const cornerBL = typeof cornerBLRaw === 'number' ? cornerBLRaw : cornerRadius;
  const cornersLinked = (() => {
    if (cornersLinkedRaw === false) return false;
    if (cornersLinkedRaw === true) return true;
    // Legacy docs with only `cornerRadius` (or equal individuals) stay linked.
    return cornerTL === cornerTR && cornerTR === cornerBR && cornerBR === cornerBL;
  })();

  if (!defaultSceneGraph.getNode(nodeId)) return null;

  /**
   * One drag of the linked corner field writes six props (the uniform radius,
   * all four corners, the link flag) — and history keys an action by the prop
   * it wrote, so without `batchHistory` that is six undo steps for one edit.
   */
  const writeAllCorners = (v: number, link: boolean) => {
    const r = Math.max(0, v);
    // B3-legacy: engine gap — per-corner radii (cornerRadii) are not catalog properties; linked writes need one entry.
    batchHistory(`corners:${nodeId}`, () => {
      setCornerRadius(r);
      setCornerTL(r);
      setCornerTR(r);
      setCornerBR(r);
      setCornerBL(r);
      if (link) setCornersLinked(true);
    });
  };

  const writeCorner = (
    which: 'TL' | 'TR' | 'BR' | 'BL',
    setOne: (v: unknown) => void,
    v: number,
  ) => {
    const r = Math.max(0, v);
    if (cornersLinked) {
      writeAllCorners(r, true);
      return;
    }
    // B3-legacy: engine gap — per-corner radii (cornerRadii) are not catalog properties; linked writes need one entry.
    batchHistory(`corners:${nodeId}`, () => {
      setOne(r);
      // Keep `cornerRadius` as the max so extrusion / legacy readers stay sensible.
      const next = {
        TL: which === 'TL' ? r : cornerTL,
        TR: which === 'TR' ? r : cornerTR,
        BR: which === 'BR' ? r : cornerBR,
        BL: which === 'BL' ? r : cornerBL,
      };
      setCornerRadius(Math.max(next.TL, next.TR, next.BR, next.BL));
    });
  };

  const toggleCornersLinked = () => {
    if (cornersLinked) {
      // Unlink: seed each corner from the current values so fields don't jump.
      // B3-legacy: engine gap — per-corner radii (cornerRadii) are not catalog properties; linked writes need one entry.
      batchHistory(`corners:${nodeId}`, () => {
        setCornerTL(cornerTL);
        setCornerTR(cornerTR);
        setCornerBR(cornerBR);
        setCornerBL(cornerBL);
        setCornersLinked(false);
      });
    } else {
      writeAllCorners(cornerRadius, true);
    }
  };

  /** Primary-only accessor: the value shown, and where a write goes. */
  const primaryAccess = (value: number, write: (v: number) => void): PropertyAccess => ({
    read: (id) => (id === nodeId ? value : undefined),
    writeStatic: (id, v) => {
      if (id !== nodeId) return false;
      write(v);
      return true;
    },
  });

  const isCornerAnimated = defaultAnimation.isAnimated(nodeId, 'cornerRadius')
    || defaultAnimation.isAnimated(nodeId, 'cornerRadiusTL')
    || defaultAnimation.isAnimated(nodeId, 'cornerRadiusTR')
    || defaultAnimation.isAnimated(nodeId, 'cornerRadiusBR')
    || defaultAnimation.isAnimated(nodeId, 'cornerRadiusBL');

  return (
    <>
      <div className={styles.subhead} style={{ marginTop: 10 }}>
        <span>Corners</span>
        <button
          type="button"
          onClick={toggleCornersLinked}
          className={`${styles.lockBtn} ${cornersLinked ? styles.lockBtnActive : ''}`}
          title={cornersLinked ? 'Unlink corners (edit individually)' : 'Link corners (same radius)'}
          style={{ marginLeft: 6 }}
          aria-pressed={cornersLinked}
        >
          <Icon name={cornersLinked ? 'lock' : 'unlock'} size="sm" style={{ color: cornersLinked ? '#f59e0b' : '#94a3b8' }} />
        </button>
        {isCornerAnimated && <span className={styles.animatedDot} />}
      </div>
      {cornersLinked ? (
        <AnimatablePaintRow
          nodeId={nodeId}
          prop="cornerRadius"
          label="All"
          access={primaryAccess(cornerRadius, (v) => writeAllCorners(v, true))}
        />
      ) : (
        <>
          <div className={styles.popoverRow}>
            <span className={styles.popoverLabel}>All</span>
            <ValueField
              value={Math.max(cornerTL, cornerTR, cornerBR, cornerBL)}
              unit="px"
              min={0}
              onChange={(v) => writeAllCorners(v, false)}
              aria-label="Corner radius"
            />
          </div>
          <div className={styles.cornerGrid} role="group" aria-label="Individual corner radii">
            <AnimatablePaintRow nodeId={nodeId} prop="cornerRadiusTL" label="TL" access={primaryAccess(cornerTL, (v) => writeCorner('TL', setCornerTL, v))} />
            <AnimatablePaintRow nodeId={nodeId} prop="cornerRadiusTR" label="TR" access={primaryAccess(cornerTR, (v) => writeCorner('TR', setCornerTR, v))} />
            <AnimatablePaintRow nodeId={nodeId} prop="cornerRadiusBL" label="BL" access={primaryAccess(cornerBL, (v) => writeCorner('BL', setCornerBL, v))} />
            <AnimatablePaintRow nodeId={nodeId} prop="cornerRadiusBR" label="BR" access={primaryAccess(cornerBR, (v) => writeCorner('BR', setCornerBR, v))} />
          </div>
        </>
      )}
    </>
  );
}

export default CornerRows;
