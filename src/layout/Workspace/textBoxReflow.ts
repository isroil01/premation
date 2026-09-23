/**
 * Paragraph box handles that REFLOW — the write side.
 *
 * AE: while editing text (or with the Type tool on a selected paragraph
 * layer) the eight handles resize the text BOX, and the text re-wraps inside
 * it at the same font size. With the Selection tool the same handles scale the
 * layer (ports.ts `resizeNode`, unchanged).
 *
 * One drag = one engine gesture = one undo step (G1: the box is the
 * `text/boxWidth` / `text/boxHeight` / `text/boxAutoSize` fields). The
 * box props are written as static props (they are not keyframeable); Position
 * — which moves so the opposite edge stays put — follows the AE keyframing
 * contract: a lit stopwatch (or Auto-Keyframe) keyframes it at the playhead.
 */

import type { Command } from '@motion/engine-api';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useProjectStore } from '@stores/projectStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { readTransformProp } from '@core/scene/transformWrite';
import { parentWorld2DAt } from '@core/scene/layerSpace';
import { isLayer } from '@core/engine/doc';
import { paths } from '@core/engine/propRefs';
import { GestureSession } from '@core/engine/uiEdits';
import { fieldCommands } from '@layout/Text/textEdits';
import { valueCommands } from '@layout/Inspector/inspectorEdits';
import {
  compDeltaToLocal,
  handleDirection,
  localToParentVector,
  resizeBoxFromHandle,
  type BoxHandle,
  type BoxPose,
  type Vec2,
} from '@core/text/paragraphBox';
import { measureTextNodeParagraphBox } from '@core/text/measureText';
import { MIN_BOX_SIZE, readParagraphBox } from '@core/text/textExtras';

export interface BoxReflowSession {
  /** Apply the drag so far: the pointer's COMPOSITION-space delta since press. */
  update(compDelta: Vec2): void;
  /** Close the gesture (records the one undo step). */
  end(): void;
}

function playheadTime(): number {
  const s = useProjectStore.getState();
  return s.tabs[s.activeTabId ?? '']?.time ?? 0;
}

/** Start a box-handle drag on a paragraph text layer, or null when it cannot take one. */
export function beginBoxReflow(nodeId: string, handle: BoxHandle): BoxReflowSession | null {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || node.locked || !isLayer(nodeId)) return null;
  const textComp = node.components.find((c) => c.type === 'Text');
  const transformComp = node.components.find((c) => c.type === 'Transform');
  const box = readParagraphBox(node);
  if (!textComp || !transformComp || !box) return null;

  const rawTime = playheadTime();
  const measured = box.fixedHeight ? null : measureTextNodeParagraphBox(node);
  const pose: BoxPose = {
    width: box.boxWidth,
    height: box.fixedHeight ? box.boxHeight : Math.max(MIN_BOX_SIZE, Math.ceil(measured?.contentHeight ?? MIN_BOX_SIZE)),
    x: readTransformProp(nodeId, 'x'),
    y: readTransformProp(nodeId, 'y'),
    rotationDeg: readTransformProp(nodeId, 'rotation'),
    scaleX: readTransformProp(nodeId, 'scaleX', 1),
    scaleY: readTransformProp(nodeId, 'scaleY', 1),
  };
  const parent = parentWorld2DAt(nodeId, rawTime);
  const vertical = handleDirection(handle).y !== 0;
  // An anchored auto-height box is drawn `lineOffsetY` below the layer origin.
  // A top/bottom drag turns it into a FIXED box, which is centred on the
  // origin — so that drag starts from the box's real centre, or it would jump.
  const anchorDy = !box.fixedHeight ? measured?.lineOffsetY ?? 0 : 0;
  const shift = anchorDy ? localToParentVector({ x: 0, y: anchorDy }, pose.rotationDeg, pose.scaleX, pose.scaleY) : null;
  const verticalPose: BoxPose = shift ? { ...pose, x: pose.x + shift.x, y: pose.y + shift.y } : pose;
  const autoKeyframe = usePreferenceStore.getState().timelineAutoKeyframe;
  let open = true;

  const gesture = new GestureSession('Resize Text Box');
  return {
    update(compDelta) {
      if (!open) return;
      const local = compDeltaToLocal(compDelta, parent, pose.rotationDeg, pose.scaleX, pose.scaleY);
      const next = resizeBoxFromHandle(vertical ? verticalPose : pose, handle, local, {
        minWidth: MIN_BOX_SIZE,
        minHeight: MIN_BOX_SIZE,
        round: true,
      });
      // ONE engine gesture (G1): the box fields (`text/boxWidth`, `text/boxHeight`,
      // `text/boxAutoSize`) and the compensating Position — keyed at the playhead
      // when animated / Auto-Keyframe (AE). Every send carries absolute values.
      const cmds: Command[] = [...fieldCommands(nodeId, paths.textProp('boxWidth'), next.width)];
      if (vertical) {
        // Dragging a top/bottom handle of an auto-height box fixes its height,
        // as AE turns auto-size off when you size the box by hand.
        if (!box.fixedHeight) cmds.push(...fieldCommands(nodeId, paths.textProp('boxAutoSize'), 'off'));
        cmds.push(...fieldCommands(nodeId, paths.textProp('boxHeight'), next.height));
      }
      cmds.push(...valueCommands([{ nodeId, values: { x: next.x, y: next.y } }], { seconds: rawTime, autoKeyframe }));
      gesture.send(cmds);
    },
    end() {
      if (!open) return;
      open = false;
      void gesture.end();
    },
  };
}
