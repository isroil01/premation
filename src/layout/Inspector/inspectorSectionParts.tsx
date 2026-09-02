/**
 * The four inspector sections that are a COMPOSITION of other controls rather
 * than a component of their own.
 *
 * They used to be inline JSX inside `InspectorContent`'s push list, which is
 * why that function was 280 lines of markup interleaved with the ordering
 * logic. The registry (`inspectorSections.ts`) takes a component per entry, so
 * each of these is now a named component — and, being named, each is covered by
 * `conditionalHooks.test.tsx` and `inspectorHistoryGranularity.test.tsx` like
 * every other section in this directory. As inline JSX they were covered by
 * neither.
 *
 * Nothing here changes what was written or when. These are the same children in
 * the same order.
 */

import { Button } from '@components/Button';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { canRevertToSvg, revertSvgGroupToLayer } from '@core/svg/svgConvert';
import { useFocusStore } from '@stores/focusStore';
import { PrecompControl } from './PrecompControl';
import { RevertSvgRow } from './SvgSection';
import { TransformSection } from './TransformSection';
import { ThreeDControl } from './ThreeDControl';
import { LayerStylesControls } from '@layout/Effects/LayerStylesControls';
import { StylePresetsSection } from './StylePresetsSection';
import { readNodeKind } from '@core/scene/sceneDerive';
import styles from '@layout/EditorLayout/panels.module.css';

/**
 * Transform, plus the 3D switch for the kinds that have one.
 *
 * Groups and nulls are excluded from the switch, not from the section: both
 * still have a position.
 */
export function TransformWithThreeDSection({ nodeId }: { nodeId: string }): JSX.Element {
  const node = defaultSceneGraph.getNode(nodeId);
  const kind = node ? readNodeKind(node) : null;
  return (
    <>
      <TransformSection nodeId={nodeId} />
      {kind !== 'group' && kind !== 'null' && <ThreeDControl nodeId={nodeId} />}
    </>
  );
}

/**
 * A group's pre-composition controls, its child count, and the way in.
 *
 * `canRevertToSvg` is asked per render rather than cached: the row is only
 * honest while the group still holds the paths the original SVG produced, and
 * editing them is exactly what removes it.
 */
export function PrecompGroupSection({ nodeId }: { nodeId: string }): JSX.Element {
  // Before any early return — the hook count must not depend on the node.
  const enterFocus = useFocusStore((s) => s.enter);
  const childrenCount = defaultSceneGraph.getChildren(nodeId).length;
  return (
    <>
      <PrecompControl nodeId={nodeId} />
      {canRevertToSvg(nodeId) && <RevertSvgRow onRevert={() => revertSvgGroupToLayer(nodeId)} />}
      <div className={styles.groupMeta}>
        <span className={styles.groupCount}>Children: {childrenCount}</span>
        <Button size="sm" variant="secondary" fullWidth onClick={() => enterFocus(nodeId)}>
          Enter group
        </Button>
      </div>
    </>
  );
}

/** A null object has nothing to edit; it has something to EXPLAIN. */
export function NullInfoSection(): JSX.Element {
  return (
    <p className={styles.sectionNote}>
      An invisible controller. Attach layers to it as children via Parent &amp; Link.
    </p>
  );
}

/**
 * Layer styles and the saved-preset shelf, in one section.
 *
 * They are together because they answer the same question from two directions:
 * the styles are what this layer's look is made of, the presets are how that
 * look gets reused. The rule between them is drawn by `InspectorSection`'s
 * nested variant rather than an inline border, which is how it stopped being a
 * one-off `borderTop` written in a style attribute.
 */
export function LayerStylesWithPresetsSection({ nodeId }: { nodeId: string }): JSX.Element {
  return (
    <>
      <LayerStylesControls nodeId={nodeId} />
      <div className={styles.stylePresetsRule}>
        <StylePresetsSection nodeId={nodeId} />
      </div>
    </>
  );
}
