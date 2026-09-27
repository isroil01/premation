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
 *
 * B4: the pose is read from the document MIRROR (the box fields, Position /
 * Rotation / Scale at the playhead); the measured auto height and its line
 * offset are the engine's `getTextLayout`, the parent's world matrix its
 * `getLayerTransforms` — both asked at press, so a drag's first moves wait for
 * them (only the latest delta is applied when they land).
 */

import { secondsToFlicks, type Command, type ParagraphLayout } from '@motion/engine-api';
import { useProjectStore } from '@stores/projectStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { documentMirror } from '@stores/documentMirror';
import { engine } from '@core/engine/engineInstance';
import { paths } from '@core/engine/propRefs';
import { GestureSession } from '@core/engine/uiEdits';
import { readTrack } from '@core/mirror/selection';
import { uiKindOf } from '@core/mirror/layerKinds';
import { fieldCommands } from '@layout/Text/textEdits';
import { mirrorParagraphBox } from '@layout/Text/textMirror';
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
import { MIN_BOX_SIZE } from '@core/text/textExtras';

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

type Parent2D = { a: number; b: number; c: number; d: number };
const IDENTITY: Parent2D = { a: 1, b: 0, c: 0, d: 1 };

/** The parent's 2D world matrix at `seconds` (identity at the top of a comp), from the engine. */
async function parentMatrix(parent: string | undefined, seconds: number): Promise<Parent2D> {
  if (!parent) return IDENTITY;
  const r = await engine().query({ type: 'getLayerTransforms', layers: [parent], time: secondsToFlicks(seconds) });
  const m = r.ok ? r.value.transforms[0]?.matrix : undefined;
  return m && m.length >= 16 ? { a: m[0]!, b: m[1]!, c: m[4]!, d: m[5]! } : IDENTITY;
}

/** The measured paragraph box (auto height), from the engine. */
async function measuredBox(nodeId: string): Promise<ParagraphLayout | undefined> {
  const r = await engine().query({ type: 'getTextLayout', layer: nodeId, time: 0 });
  return r.ok ? r.value.paragraph : undefined;
}

/** Start a box-handle drag on a paragraph text layer, or null when it cannot take one. */
export function beginBoxReflow(nodeId: string, handle: BoxHandle): BoxReflowSession | null {
  const m = documentMirror();
  const layer = m.layer(nodeId);
  if (!layer || layer.switches.locked || uiKindOf(layer) !== 'text') return null;
  const box = mirrorParagraphBox(m, nodeId);
  if (!box) return null;

  const rawTime = playheadTime();
  const read = (track: string, fb: number): number => readTrack(m, nodeId, track, rawTime) ?? fb;
  const base = {
    x: read('x', 0),
    y: read('y', 0),
    rotationDeg: read('rotation', 0),
    scaleX: read('scaleX', 1),
    scaleY: read('scaleY', 1),
  };
  const vertical = handleDirection(handle).y !== 0;
  const autoKeyframe = usePreferenceStore.getState().timelineAutoKeyframe;
  let open = true;
  let pending: Vec2 | null = null;
  let sent: Vec2 | null = null;
  let ready: { pose: BoxPose; verticalPose: BoxPose; parent: Parent2D } | null = null;

  const gesture = new GestureSession('Resize Text Box');
  const apply = (compDelta: Vec2): void => {
    if (!ready) return;
    sent = compDelta;
    const { pose, verticalPose, parent } = ready;
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
  };

  const inputs = Promise.all([
    box.fixedHeight ? Promise.resolve(undefined) : measuredBox(nodeId),
    parentMatrix(layer.parent, rawTime),
  ]).then(([measured, parent]) => {
    const pose: BoxPose = {
      width: box.boxWidth,
      height: box.fixedHeight ? box.boxHeight : Math.max(MIN_BOX_SIZE, Math.ceil(measured?.contentHeight ?? MIN_BOX_SIZE)),
      ...base,
    };
    // An anchored auto-height box is drawn `lineOffsetY` below the layer origin.
    // A top/bottom drag turns it into a FIXED box, which is centred on the
    // origin — so that drag starts from the box's real centre, or it would jump.
    const anchorDy = !box.fixedHeight ? measured?.lineOffsetY ?? 0 : 0;
    const shift = anchorDy ? localToParentVector({ x: 0, y: anchorDy }, pose.rotationDeg, pose.scaleX, pose.scaleY) : null;
    const verticalPose: BoxPose = shift ? { ...pose, x: pose.x + shift.x, y: pose.y + shift.y } : pose;
    ready = { pose, verticalPose, parent };
    if (open && pending && pending !== sent) apply(pending);
  });

  return {
    update(compDelta) {
      if (!open) return;
      pending = compDelta;
      apply(compDelta);
    },
    end() {
      if (!open) return;
      open = false;
      // A release before the inputs landed still applies the last move, then closes.
      void inputs.then(() => {
        if (pending && pending !== sent) apply(pending);
        return gesture.end();
      });
    },
  };
}
