/**
 * Paragraph box handles that REFLOW — the write side.
 *
 * AE: while editing text (or with the Type tool on a selected paragraph
 * layer) the eight handles resize the text BOX, and the text re-wraps inside
 * it at the same font size. With the Selection tool the same handles scale the
 * layer (ports.ts `resizeNode`, unchanged).
 *
 * One drag = one viewport gesture = one undo step (viewportGesture.ts). The
 * box props are written as static props (they are not keyframeable); Position
 * — which moves so the opposite edge stays put — follows the AE keyframing
 * contract: a lit stopwatch (or Auto-Keyframe) keyframes it at the playhead.
 */

import type { ID } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { getRemappedTime } from '@core/timeline/TimelineController';
import { useProjectStore } from '@stores/projectStore';
import { readTransformProp, writesAsKeyframe, writeTransformBase } from '@core/scene/transformWrite';
import { parentWorld2DAt } from '@core/scene/layerSpace';
import {
  beginViewportGesture,
  endViewportGesture,
  gestureAnimEdit,
  gestureSceneBump,
} from '@core/workspace/viewportGesture';
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
  if (!node || node.locked) return null;
  const textComp = node.components.find((c) => c.type === 'Text');
  const transformComp = node.components.find((c) => c.type === 'Transform');
  const box = readParagraphBox(node);
  if (!textComp || !transformComp || !box) return null;

  const rawTime = playheadTime();
  const layerTime = getRemappedTime(nodeId, rawTime);
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
  const keyPosition = writesAsKeyframe(nodeId, 'x');
  let madeFixed = false;
  let open = true;

  beginViewportGesture();
  return {
    update(compDelta) {
      if (!open) return;
      const local = compDeltaToLocal(compDelta, parent, pose.rotationDeg, pose.scaleX, pose.scaleY);
      const next = resizeBoxFromHandle(vertical ? verticalPose : pose, handle, local, {
        minWidth: MIN_BOX_SIZE,
        minHeight: MIN_BOX_SIZE,
        round: true,
      });
      const id = nodeId as ID;
      // B3-legacy: engine gap — the paragraph box (Text.boxWidth / boxHeight / boxAutoSize) has no API property (text/boxWidth …); the reflow's compensating Position rides the same legacy viewport gesture.
      defaultSceneGraph.writeProp(id, textComp.id, 'boxWidth', next.width);
      if (vertical) {
        // Dragging a top/bottom handle of an auto-height box fixes its height,
        // as AE turns auto-size off when you size the box by hand.
        if (!box.fixedHeight && !madeFixed) {
          // B3-legacy: engine gap — the paragraph box (Text.boxWidth / boxHeight / boxAutoSize) has no API property (text/boxWidth …); the reflow's compensating Position rides the same legacy viewport gesture.
          defaultSceneGraph.writeProp(id, textComp.id, 'boxAutoSize', 'off');
          madeFixed = true;
        }
        // B3-legacy: engine gap — the paragraph box (Text.boxWidth / boxHeight / boxAutoSize) has no API property (text/boxWidth …); the reflow's compensating Position rides the same legacy viewport gesture.
        defaultSceneGraph.writeProp(id, textComp.id, 'boxHeight', next.height);
      }
      // Base Position through the router; the keyframe (when the stopwatch is
      // lit) is set in the gesture edit below.
      // B3-legacy: engine gap — the paragraph box (Text.boxWidth / boxHeight / boxAutoSize) has no API property (text/boxWidth …); the reflow's compensating Position rides the same legacy viewport gesture.
      writeTransformBase(nodeId, [{ prop: 'x', value: next.x }, { prop: 'y', value: next.y }], transformComp.id);
      if (keyPosition) {
        gestureAnimEdit(
          'Resize Text Box',
          () => {
            // B3-legacy: engine gap — the paragraph box (Text.boxWidth / boxHeight / boxAutoSize) has no API property (text/boxWidth …); the reflow's compensating Position rides the same legacy viewport gesture.
            defaultAnimation.setKeyframe(nodeId, 'x', layerTime, next.x);
            // B3-legacy: engine gap — the paragraph box (Text.boxWidth / boxHeight / boxAutoSize) has no API property (text/boxWidth …); the reflow's compensating Position rides the same legacy viewport gesture.
            defaultAnimation.setKeyframe(nodeId, 'y', layerTime, next.y);
          },
          `textbox:${nodeId}:${layerTime}`,
        );
      }
      gestureSceneBump();
    },
    end() {
      if (!open) return;
      open = false;
      endViewportGesture();
    },
  };
}
