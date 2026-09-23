/**
 * Right-click menus for two viewport precision targets that are not layers:
 *
 *  • a MOTION-PATH KEYFRAME — AE's Keyframe Interpolation ▸ Spatial
 *    Interpolation (Linear / Bezier / Continuous Bezier / Auto Bezier), per
 *    vertex, plus Convert Vertex;
 *  • a RULER GUIDE — Edit Guide…, Lock / Unlock, Delete.
 *
 * Pure builders like `useWorkspaceContextMenu`'s: take ids, return items.
 */

import type { ContextMenuItem } from '@stores/contextMenuStore';
import type { SpatialInterp } from '@motion/animation';
import { setSpatialInterpolation, spatialInterpAt, toggleVertexInterpolation } from '@core/motion/motionPath';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { openGuideEditor } from './GuideEditorDialog';
import { editPositionKeys } from './viewportEdits';

const SPATIAL_LABELS: ReadonlyArray<{ mode: SpatialInterp; label: string }> = [
  { mode: 'linear', label: 'Linear' },
  { mode: 'bezier', label: 'Bezier' },
  { mode: 'continuous', label: 'Continuous Bezier' },
  { mode: 'auto', label: 'Auto Bezier' },
];

/**
 * Undoable: one entry per conversion. The conversion arithmetic is the motion
 * path module's, run on a SCRATCH copy of the Position tracks; the changed
 * keys go to the engine as one `updateKeyframes` (see `editPositionKeys`).
 */
export function applySpatialInterpolation(nodeId: string, t: number, mode: SpatialInterp): Promise<void> {
  const label = SPATIAL_LABELS.find((s) => s.mode === mode)?.label ?? mode;
  return editPositionKeys(nodeId, `Spatial Interpolation: ${label}`, (scratch) => {
    // B3-legacy: not a write — the helper runs on the scratch engine passed in; the document
    // edit is the `updateKeyframes` built from its result (rule false positive by name).
    setSpatialInterpolation(nodeId, t, mode, scratch);
  });
}

/** Undoable Convert Vertex (Ctrl/Cmd+click a motion-path keyframe). */
export function convertMotionPathVertex(nodeId: string, t: number): Promise<void> {
  return editPositionKeys(nodeId, 'Convert Vertex', (scratch) => {
    // B3-legacy: not a write — scratch engine (see `applySpatialInterpolation`).
    toggleVertexInterpolation(nodeId, t, scratch);
  });
}

export function motionPathKeyframeMenuItems(nodeId: string, t: number): ContextMenuItem[] {
  const current = spatialInterpAt(nodeId, t);
  return [
    {
      id: 'mp-spatial',
      label: 'Spatial Interpolation',
      children: SPATIAL_LABELS.map(({ mode, label }): ContextMenuItem => ({
        id: `mp-spatial-${mode}`,
        label,
        icon: current === mode ? 'check' : undefined,
        onSelect: () => { void applySpatialInterpolation(nodeId, t, mode); },
      })),
    },
    { id: 'mp-sep', separator: true },
    {
      id: 'mp-convert',
      label: current === 'linear' ? 'Convert Vertex to Auto Bezier (Ctrl+Click)' : 'Convert Vertex to Corner (Ctrl+Click)',
      onSelect: () => { void convertMotionPathVertex(nodeId, t); },
    },
  ];
}

export function guideContextMenuItems(guideId: string): ContextMenuItem[] {
  const controller = getWorkspaceController();
  const guide = controller.ws.guides.get(guideId);
  if (!guide) return [];
  return [
    { id: 'guide-edit', label: 'Edit Guide…', onSelect: () => openGuideEditor(guideId) },
    {
      id: 'guide-lock',
      label: guide.locked ? 'Unlock Guide' : 'Lock Guide',
      onSelect: () => {
        controller.ws.guides.setLocked(guideId, !guide.locked);
        controller.requestRender();
      },
    },
    { id: 'guide-sep', separator: true },
    {
      id: 'guide-delete',
      label: 'Delete Guide',
      danger: true,
      onSelect: () => {
        // `remove` refuses a locked guide; a deliberate menu delete unlocks first.
        controller.ws.guides.setLocked(guideId, false);
        controller.ws.removeGuide(guideId);
        controller.requestRender();
      },
    },
  ];
}
