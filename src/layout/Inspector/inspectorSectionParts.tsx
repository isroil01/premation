/**
 * The inspector sections that are a COMPOSITION of other controls rather
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
import { documentMirror } from '@stores/documentMirror';
import { childOrderOf } from '@core/mirror/layerTree';
import { revertSvgToLayer } from './svgLayerActions';
import { useFocusStore } from '@stores/focusStore';
import { PrecompControl } from './PrecompControl';
import { RevertSvgRow } from './SvgSection';
import { TransformSection } from './TransformSection';
import { ThreeDControl } from './ThreeDControl';
import { useCompLayersWatch } from './inspectorMirror';
import { LayerStylesControls } from '@layout/Effects/LayerStylesControls';
import { StylePresetsSection } from './StylePresetsSection';
import styles from '@layout/EditorLayout/panels.module.css';

/**
 * Transform. The name predates the move of the 3D switch into Geometry Options
 * (below); it stays because it is the registry's component identity.
 */
export function TransformWithThreeDSection({ nodeId }: { nodeId: string }): JSX.Element {
  return <TransformSection nodeId={nodeId} />;
}

/**
 * AE's Geometry Options group: the 3D Layer switch, then Bevel Style, Bevel
 * Depth, Hole Bevel Depth and Extrusion Depth. In AE the switch is a timeline
 * column; here it heads the group so turning a layer 3D and giving it depth is
 * one place, instead of Transform › More › 3D Layer.
 */
export function GeometryOptionsSection({ nodeId }: { nodeId: string }): JSX.Element {
  return <ThreeDControl nodeId={nodeId} />;
}

/**
 * A group's pre-composition controls, its child count, and the way in.
 *
 * Whether it can Revert to Original SVG is read per render (`LayerInfo.svg`
 * 'converted': the group still retains the original source) rather than cached.
 */
export function PrecompGroupSection({ nodeId }: { nodeId: string }): JSX.Element {
  // Before any early return — the hook count must not depend on the node.
  const enterFocus = useFocusStore((s) => s.enter);
  // B4: the group's members (its header) and the layers parented to it (the comp's stack).
  useCompLayersWatch(nodeId);
  const childrenCount = childOrderOf(documentMirror(), nodeId).length;
  // Whether the group was converted from an SVG it still retains (`LayerInfo.svg`: Revert to Original SVG).
  const retainsSvg = documentMirror().layer(nodeId)?.svg === 'converted';
  return (
    <>
      <PrecompControl nodeId={nodeId} />
      {retainsSvg && <RevertSvgRow onRevert={() => { void revertSvgToLayer(nodeId); }} />}
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
