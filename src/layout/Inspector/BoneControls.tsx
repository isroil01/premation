/**
 * BoneControls — the Rigging panel's skeleton editor (bones, IK goals, the
 * skinning mesh, per-vertex weights, controllers, Auto-Rig).
 *
 * Every write goes through the engine API on the rig paths (B3z,
 * docs/ENGINE_API.md §15.9 "Rigging"; builders in rigEdits.ts): one `edit` per
 * click / pick / typed value, one gesture per scrub (useEngineEdit). Times sent
 * are composition time; the engine converts to the layer's keyframe axis. The
 * rig is read from the document mirror (`layer/skeleton`).
 */

import { useRef, useState } from 'react';
import { t } from '@core/i18n';
import { ValueField } from '@components/ValueField';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { useUIStore } from '@stores/uiStore';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorLayer, useMirrorLayersWatch, useMirrorTree, useMirrorValueAt } from '@hooks/useMirror';
import { useMirrorJson } from '@hooks/useMirrorFields';
import { useThrottledTime } from '@stores/playbackClockStore';
import { numbersOfValue } from '@core/mirror/trackIndex';
import { RigAnimToggle } from './PuppetControls';
import { applyRigPresetEdit, rigPaths } from '@core/engine/rigPaths';
import { edit } from '@core/engine/uiEdits';
import { compTime } from '@core/engine/propRefs';
import { engine } from '@core/engine/engineInstance';
import type { RigPose } from '@motion/engine-api';
import { fetchLayerBox } from '@stores/layerBoxes';
import type { IKTarget, SkeletonRig } from '@core/rig/skeletonCommands';
import { RIG_PRESETS, RIG_PRESET_LABELS, type RigPresetId } from '@core/rig/rigPresets';
import { MESH_DENSITY_DEFAULT, MESH_EXPANSION_DEFAULT } from '@core/rig/rigMeshInputs';
import type { ChainMode } from '@core/rig/ikfk';
import type { Bone } from '@core/rig/skeleton';
import type { IkTargetResolved } from '@core/rig/rigDeform';
import { useRigPose } from '@hooks/useRigPose';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useActiveWorkspace } from '@stores/projectStore';
import {
  defaultControllerFor, CONTROLLER_SHAPES, CONTROLLER_SIDES,
  type ControllerShape, type ControllerSide,
} from '@core/rig/controllers';
import type { PuppetRig } from '@core/rig/puppet';
import { ikChainIds } from '@core/rig/rigDeform';
import { boneRoot, boneTip, computeWorldTransforms } from '@core/rig/skeleton';
import {
  setVertexWeight, emptyWeightPaint, weightPaintMatches, isWeightPaintEmpty,
} from '@core/rig/weightPaint';
import { useEngineEdit } from './useEngineEdit';
import {
  addControllerCommands, addPoleCommands, boneFieldCommands, bonePoseCommands, boneRestCommands, chainSwitchCommands,
  controllerFieldCommands, deleteBoneCommands, deleteControllerCommands, ikChainLengthCommands, ikSoftnessCommands, ikStretchCommands,
  ikTargetCommands, ikToggleCommands, removePoleCommands, renameBoneCommands, skeletonMeshCommands,
  weightPaintCommands,
} from './rigEdits';
import { useRigVertexSelection, clearRigVertex } from '@stores/rigVertexStore';
import { useRigSelectionStore } from '@stores/rigSelectionStore';
import styles from './BoneControls.module.css';

export function BoneControls({ nodeId }: { nodeId: string }): JSX.Element | null {
  // B4: re-render on this layer's header / property tree / keyframes (the live
  // pose below follows bone keys), and read the rigs from the document mirror.
  useMirrorLayersWatch([nodeId]);
  const layer = useMirrorLayer(nodeId);
  // `layer/skeleton` / `layer/puppet` are fx.skeleton / fx.puppet verbatim (rigProps wholeRig codec).
  const skel = useMirrorJson<SkeletonRig>(nodeId, 'layer/skeleton');
  const puppet = useMirrorJson<PuppetRig>(nodeId, 'layer/puppet');
  // EVERY hook above the `!node` guard. React counts hooks per render, so a
  // hook below an early return runs on one pass and not the next — "Rendered
  // fewer hooks than expected", which unmounts the tree and takes the editor
  // down. Deleting a selected layer with this panel open is the ordinary way to
  // hit it; `conditionalHooks.test.tsx` exists because it has happened before.
  const workspaceTime = useActiveWorkspace()?.time ?? 0;
  const selectedVertex = useRigVertexSelection(nodeId);
  const boneRigMode = useUIStore((s) => s.boneRigMode);
  const rigSelectionNodeId = useRigSelectionStore((s) => s.nodeId);
  const selectedBoneId = useRigSelectionStore((s) => s.boneId);
  const selectedBoneIds = useRigSelectionStore((s) => s.boneIds);
  const selectedControllerId = useRigSelectionStore((s) => s.controllerId);
  const eng = useEngineEdit();
  // The bone-name field edits a local draft and commits ONE rename on blur /
  // Enter (Escape abandons it) — not a document write per keystroke.
  const [nameDraft, setNameDraft] = useState<{ boneId: string; value: string } | null>(null);
  const cancelRename = useRef(false);
  // B4 round 5: the rig at the playhead as the engine resolves it (getRigPose) — the live and
  // solved pose, the goals' chain modes, the picked vertex's bind weights.
  const pose = useRigPose(layer ? nodeId : null, workspaceTime, selectedVertex);
  // C1's mesh settings (`skeleton/mesh/traceAccuracy`, `skeleton/mesh/alphaThreshold`) appear once the engine lists them.
  const meshTree = useMirrorTree(layer ? nodeId : null);
  const hasTrace = !!meshTree?.nodes.has('skeleton/mesh/traceAccuracy');
  const hasAlpha = !!meshTree?.nodes.has('skeleton/mesh/alphaThreshold');
  const skelMeshAny = skel as (SkeletonRig & { traceAccuracy?: number; alphaThreshold?: number }) | undefined;
  if (!layer) return null;

  const bones = skel?.bones ?? [];
  const ikTargets = skel?.ikTargets ?? [];
  const controllers = skel?.controllers ?? [];
  const selectedBone =
    rigSelectionNodeId === nodeId
      ? bones.find((bone) => bone.id === selectedBoneId) ?? null
      : bones[0] ?? null;
  const selectBone = (boneId: string | null): void =>
    useRigSelectionStore.getState().selectBone(nodeId, boneId);
  // The live pose (the bone tracks at the playhead) and the solved one (FK + the goals in IK
  // mode), resolved by the engine (getRigPose); the stored rig until the answer lands.
  const poseById = new Map((pose?.bones ?? []).map((b) => [b.id, b]));
  /** The live bones and solving goals of a pose answer — what an IK/FK switch plans from. */
  const switchInputs = (from: RigPose | undefined): { bones: Bone[]; targets: IkTargetResolved[] } => {
    const byId = new Map((from?.bones ?? []).map((b) => [b.id, b]));
    return {
      bones: bones.map((b) => {
        const q = byId.get(b.id);
        return q ? { ...b, x: q.x, y: q.y, rotation: q.rotation, scaleX: q.scaleX, scaleY: q.scaleY } : b;
      }),
      targets: (from?.ik ?? [])
        .filter((g) => g.enabled && g.mode === 'ik')
        .map((g) => ({
          boneId: g.bone, x: g.x, y: g.y,
          ...(g.chainLength !== undefined ? { chainLength: g.chainLength } : {}),
          ...(g.pole.length === 2 ? { pole: { x: g.pole[0]!, y: g.pole[1]! } } : {}),
        })),
    };
  };
  const { bones: liveBones, targets: liveTargets } = switchInputs(pose);
  const posedBones: Bone[] = bones.map((b) => {
    const p = poseById.get(b.id);
    return p ? { ...b, x: p.posedX, y: p.posedY, rotation: p.posedRotation, scaleX: p.scaleX, scaleY: p.scaleY } : b;
  });
  const posedWorld = computeWorldTransforms({ bones: posedBones });
  /** A goal's chain mode at the playhead (its ikMode track over the stored mode). */
  const chainModeAt = (ik: Pick<IKTarget, 'boneId' | 'ikMode'>): ChainMode =>
    (pose?.ik.find((g) => g.bone === ik.boneId)?.mode as ChainMode | undefined) ?? ik.ikMode ?? 'ik';
  const hasPuppet = (puppet?.pins ?? []).length > 0;

  const effectorFor = (boneId: string): { x: number; y: number } => {
    const bone = posedBones.find((candidate) => candidate.id === boneId);
    const world = posedWorld.get(boneId);
    return bone && world ? boneTip(world, bone.length) : { x: 0, y: 0 };
  };

  const poleFor = (boneId: string, chainLength?: number): { x: number; y: number } => {
    const chain = ikChainIds(posedBones, boneId, chainLength);
    const first = chain[0];
    const bend = chain[1];
    const end = posedBones.find((candidate) => candidate.id === boneId);
    const firstWorld = first ? posedWorld.get(first) : undefined;
    const endWorld = posedWorld.get(boneId);
    if (!firstWorld || !endWorld || !end) return { x: 0, y: -80 };
    const root = boneRoot(firstWorld);
    const tip = boneTip(endWorld, end.length);
    const dx = tip.x - root.x;
    const dy = tip.y - root.y;
    const distance = Math.hypot(dx, dy) || 1;
    let nx = -dy / distance;
    let ny = dx / distance;
    const midpoint = { x: (root.x + tip.x) / 2, y: (root.y + tip.y) / 2 };
    const bendWorld = bend ? posedWorld.get(bend) : undefined;
    if (bendWorld) {
      const joint = boneRoot(bendWorld);
      if ((joint.x - midpoint.x) * nx + (joint.y - midpoint.y) * ny < 0) {
        nx = -nx;
        ny = -ny;
      }
    }
    const offset = Math.max(40, distance * 0.5);
    return { x: midpoint.x + nx * offset, y: midpoint.y + ny * offset };
  };

  /** The IK goal at the playhead (its keys when animated, else the static value). */
  const goalAt = (ik: IKTarget): { x: number; y: number } => {
    const v = documentMirror().valueAt(nodeId, rigPaths.ikProp(ik.boneId, 'target'), compTime(workspaceTime));
    return v?.kind === 'vec2' ? v.value : { x: ik.x, y: ik.y };
  };

  const commitRename = (boneId: string, current: string | undefined): void => {
    const draft = nameDraft;
    setNameDraft(null);
    if (cancelRename.current) {
      cancelRename.current = false;
      return;
    }
    if (!draft || draft.boneId !== boneId || draft.value === (current ?? '')) return;
    void edit('Rename Bone', renameBoneCommands(nodeId, boneId, draft.value));
  };

  const orderedBones: Array<{ bone: (typeof bones)[number]; depth: number }> = [];
  const seenBones = new Set<string>();
  const appendChildren = (parentId: string | null, depth: number): void => {
    for (const bone of bones) {
      if (bone.parentId !== parentId || seenBones.has(bone.id)) continue;
      seenBones.add(bone.id);
      orderedBones.push({ bone, depth });
      appendChildren(bone.id, depth + 1);
    }
  };
  appendChildren(null, 0);
  // Keep malformed legacy rigs inspectable instead of hiding cycle/orphan rows.
  for (const bone of bones) {
    if (!seenBones.has(bone.id)) orderedBones.push({ bone, depth: 0 });
  }

  /**
   * The per-vertex weight editor — numbers for what the brush paints by feel.
   *
   * A plain function, not a hook and not a child component: it renders only when
   * a vertex is selected, and a component whose hooks appear and disappear with
   * the selection is the "Rendered fewer hooks than expected" crash this file's
   * header is about.
   *
   * The mesh comes from `nodeRestMesh` — the same assembly `BoneOverlay` uses —
   * because the weights are addressed by vertex INDEX. A second derivation at a
   * different density would not be approximately right, it would be editing a
   * different part of the artwork.
   */
  const renderVertexWeights = (): JSX.Element | null => {
    if (selectedVertex === null || bones.length === 0) return null;
    // The skinning mesh's size and this vertex's bind weights come from the engine (getRigPose),
    // over the same mesh the overlay paints and the renderer skins.
    if (!pose) return null;
    const numVerts = pose.vertexCount;
    // A selection made against a denser mesh addresses nothing now. Say so
    // rather than editing whatever vertex happens to hold that index.
    if (selectedVertex >= numVerts) {
      return (
        <div className={styles.card}>
          <div className={styles.subText}>
            {t('inspector.bone.staleVertex', 'Vertex {n} is from a different mesh resolution. Re-pick a vertex on the canvas.', { n: selectedVertex })}
          </div>
        </div>
      );
    }

    // Weights are read off the BIND pose, not the posed one — the numeric
    // editor must show the same influences the renderer skinned with. Strongest
    // first (the engine's order): the order an animator reads them in, and it
    // makes the dominant bone obvious without comparing four numbers.
    const influences = pose.weights.map((w) => ({ boneId: w.bone, weight: w.weight }));
    const nameOf = (id: string): string => bones.find((b) => b.id === id)?.name ?? id;
    const total = influences.reduce((a, w) => a + w.weight, 0);

    const commit = (boneId: string, percent: number): void => {
      const base = weightPaintMatches(skel?.weightPaint, numVerts)
        ? skel!.weightPaint!
        : emptyWeightPaint(numVerts);
      // Pure: returns the new map (weightPaint.ts); the write is the one `skeleton/weightPaint` set below.
      const next = setVertexWeight(base, selectedVertex, boneId, percent / 100, influences);
      // One write, so a typed value is one undo step exactly like a brush
      // stroke (a scrub is one gesture) — and an emptied map is dropped rather
      // than serialised.
      eng.send('Set Vertex Weight', weightPaintCommands(nodeId, isWeightPaintEmpty(next) ? null : next));
    };

    return (
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div className={styles.cardTitle}>
            <Icon name="grid" size="sm" />
            <span>{t('inspector.bone.vertexWeights', 'Vertex Weights')}</span>
            <span className={styles.badge}>#{selectedVertex}</span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t('inspector.bone.deselectVertex', 'Deselect vertex')}
            title={t('inspector.bone.deselectVertex', 'Deselect vertex')}
            onClick={() => clearRigVertex()}
          >
            <Icon name="close" size="sm" />
          </Button>
        </div>

        {influences.length === 0 && (
          <div className={styles.subText}>
            {t('inspector.bone.noInfluence', 'No bone reaches this vertex — it stays in its bind position.')}
          </div>
        )}

        {influences.length === 1 && (
          // The boundary made unrepresentable rather than corrected afterwards:
          // one influence is 1 by definition, and an editable field here would
          // renormalise whatever was typed straight back to 100%.
          <div className={styles.subText}>
            <strong>{nameOf(influences[0]!.boneId)}</strong>{' '}
            {t('inspector.bone.onlyInfluence', 'is the only influence here, so it holds 100%. Paint a second bone onto this vertex to divide it.')}
          </div>
        )}

        {influences.length > 1 && influences.map((w) => (
          <div key={w.boneId} className={styles.paramRow}>
            <span className={styles.paramLabel} title={w.boneId}>{nameOf(w.boneId)}</span>
            <ValueField
              value={w.weight * 100}
              min={0}
              max={100}
              unit="%"
              precision={1}
              aria-label={t('inspector.bone.weightAria', '{name} weight at vertex {n}', { name: nameOf(w.boneId), n: selectedVertex })}
              {...eng.scrub('Set Vertex Weight')}
              onChange={(v) => commit(w.boneId, v)}
            />
          </div>
        ))}

        {influences.length > 1 && (
          <div className={styles.subText} style={{ marginTop: 4 }}>
            {/* Read back from the binding, not from what was typed — so this
                reports the weights that actually deform. */}
            {t('inspector.bone.total', 'Total {n}%. Editing one weight redistributes the rest in proportion.', { n: (total * 100).toFixed(0) })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={styles.root}>
      {/* Skeleton summary card */}
      <div className={styles.headerCard}>
        <div className={styles.headerTitle}>
          <Icon name="bone" size="sm" style={{ color: '#f97316' }} />
          <span>{t('inspector.bone.bones', 'Bones')}</span>
          <span className={styles.badge}>{bones.length === 1 ? t('inspector.bone.countOne', '{n} bone', { n: 1 }) : t('inspector.bone.countOther', '{n} bones', { n: bones.length })}</span>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => useUIStore.getState().setActiveTool('bone')}
        >
          <Icon name="plus" size="sm" /> {t('inspector.bone.addJoint', 'Add Joint')}
        </Button>
      </div>

      {/* Auto-rig. Offered whether or not bones exist, but the destructive
          case is stated on the control itself: applying a preset REPLACES the
          rig, because merging two skeletons produces duplicate bone ids and a
          duplicate id silently couples two bones onto one animation track. */}
      <div className={styles.paramRow}>
        <span className={styles.paramLabel} title={t('inspector.bone.autoRigTip', 'Generates bones, IK chains and controllers scaled to this layer. Replaces any existing rig.')}>
          {t('inspector.bone.autoRig', 'Auto-Rig')}
        </span>
        <select
          value=""
          aria-label={t('inspector.bone.autoRigPreset', 'Auto-rig preset')}
          onChange={(e) => {
            const id = e.target.value as RigPresetId;
            if (!id) return;
            // The layer's drawn size (the engine's `getLayerBounds`: text / group / shape box) sizes the preset.
            // One `layer/skeleton` write (REPLACES the rig); an invalid rig is refused before anything is sent.
            void fetchLayerBox(nodeId, compTime(workspaceTime)).then((geom) => applyRigPresetEdit(
              nodeId,
              RIG_PRESETS[id]({ width: geom?.width ?? 200, height: geom?.height ?? 200 }),
              t('inspector.bone.autoRigUndo', 'Auto-Rig {preset}', { preset: RIG_PRESET_LABELS[id] }),
            )).then((problems) => {
              if (problems.length > 0) {
                // Never silently: a refused rig with no message reads as a dead
                // control, which is worse than the error.
                console.error("Auto-rig refused:", problems);
              }
            });
            e.currentTarget.value = "";
          }}
          className={styles.select}
        >
          <option value="">{t('inspector.bone.generate', 'Generate…')}</option>
          {(Object.keys(RIG_PRESETS) as RigPresetId[]).map((id) => (
            <option key={id} value={id}>{RIG_PRESET_LABELS[id]}</option>
          ))}
        </select>
      </div>
      {bones.length === 0 && (
        <div className={styles.card} style={{ textAlign: 'center', padding: '16px 12px' }}>
          <span className={styles.subText}>{t('inspector.bone.clickToDraw', 'Click the layer to draw bones.')}</span>
          <Button
            size="sm"
            variant="primary"
            onClick={() => useUIStore.getState().setActiveTool('bone')}
            style={{ marginTop: 8 }}
          >
            <Icon name="bone" size="sm" /> {t('inspector.bone.drawBones', 'Draw Bones with Bone Tool (Ctrl+B)')}
          </Button>
        </div>
      )}

      {bones.length > 0 && hasPuppet && (
        <div className={styles.card} style={{ padding: '10px 12px' }}>
          <span className={styles.subText}>
            {t('inspector.bone.puppetToo', "This layer also has puppet pins — the two rigs compose: the puppet refines the mesh first, then the skeleton pose carries it. The skinning mesh below follows the puppet's mesh settings.")}
          </span>
        </div>
      )}

      {boneRigMode === 'weights' && bones.length > 0 && !hasPuppet && (
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <div className={styles.cardTitle}>
              <Icon name="grid" size="sm" />
              <span>{t('inspector.bone.skinningMesh', 'Skinning Mesh')}</span>
            </div>
          </div>
          {/* These two rows used to read 15 and 8 while `buildRestMesh` actually
              meshed at 22 and 0 — the panel described a mesh the renderer was
              not building, and an expansion of 8 in particular turns on the
              one-cell dilation that wraps a PNG character in a ring of empty
              pixels. Read the engine's defaults instead of restating them. */}
          <div className={styles.paramRow}>
            <span className={styles.paramLabel}>{t('inspector.bone.density', 'Density')}</span>
            <ValueField
              value={skel?.meshDensity ?? MESH_DENSITY_DEFAULT}
              min={2}
              max={50}
              {...eng.scrub('Edit Skeleton Mesh')}
              onChange={(v) => eng.send('Edit Skeleton Mesh', skeletonMeshCommands(nodeId, { density: Math.round(v) }))}
              aria-label={t('inspector.bone.meshDensityAria', 'Skinning mesh density')}
            />
          </div>
          <div className={styles.paramRow}>
            <span className={styles.paramLabel}>{t('inspector.bone.mesh', 'Mesh')}</span>
            {/* Grid = a lattice over the bounding box, culled against the alpha.
                Outline = the alpha OUTLINE traced and Delaunay-filled, so a thin
                limb is its own strip of triangles and a bone bends it instead of
                dragging the rectangle it sits in. New rigs on an image layer pick
                Outline; an existing rig keeps the mesh its weights were painted
                on until you switch it here. */}
            <select
              value={skel?.meshMode ?? 'grid'}
              aria-label={t('inspector.bone.meshModeAria', 'Skinning mesh mode')}
              onChange={(e) => {
                void edit('Edit Skeleton Mesh', skeletonMeshCommands(nodeId, {
                  mode: e.target.value as 'grid' | 'silhouette',
                }));
              }}
              className={styles.select}
            >
              <option value="grid">{t('inspector.bone.meshGrid', 'Grid')}</option>
              <option value="silhouette">{t('inspector.bone.meshOutline', 'Outline')}</option>
            </select>
          </div>
          <div className={styles.paramRow}>
            <span className={styles.paramLabel}>{t('inspector.bone.expansion', 'Expansion')}</span>
            <ValueField
              value={skel?.meshExpansion ?? MESH_EXPANSION_DEFAULT}
              min={0}
              max={100}
              unit="px"
              {...eng.scrub('Edit Skeleton Mesh')}
              onChange={(v) => eng.send('Edit Skeleton Mesh', skeletonMeshCommands(nodeId, { expansion: Math.round(v) }))}
              aria-label={t('inspector.bone.meshExpansionAria', 'Skinning mesh expansion')}
            />
          </div>
          {hasTrace && (
            <div className={styles.paramRow}>
              <span className={styles.paramLabel} title={t('inspector.puppet.traceAccuracyHint', "How closely the outline mesh follows the artwork's edge (0–100). Higher keeps small notches; lower smooths them away.")}>
                {t('inspector.puppet.traceAccuracy', 'Trace Accuracy')}
              </span>
              <ValueField
                value={skelMeshAny?.traceAccuracy ?? 60}
                min={0}
                max={100}
                {...eng.scrub('Edit Skeleton Mesh')}
                onChange={(v) => eng.send('Edit Skeleton Mesh', skeletonMeshCommands(nodeId, { traceAccuracy: Math.max(0, Math.min(100, Math.round(v))) }))}
                aria-label={t('inspector.puppet.traceAccuracy', 'Trace Accuracy')}
              />
            </div>
          )}
          {hasAlpha && (
            <div className={styles.paramRow}>
              <span className={styles.paramLabel} title={t('inspector.puppet.alphaThresholdHint', 'Alpha below this (0–255) counts as outside the artwork when the outline is traced.')}>
                {t('inspector.puppet.alphaThreshold', 'Alpha Threshold')}
              </span>
              <ValueField
                value={skelMeshAny?.alphaThreshold ?? 32}
                min={0}
                max={255}
                {...eng.scrub('Edit Skeleton Mesh')}
                onChange={(v) => eng.send('Edit Skeleton Mesh', skeletonMeshCommands(nodeId, { alphaThreshold: Math.max(0, Math.min(255, Math.round(v))) }))}
                aria-label={t('inspector.puppet.alphaThreshold', 'Alpha Threshold')}
              />
            </div>
          )}
        </div>
      )}

      {boneRigMode === 'weights' && renderVertexWeights()}

      {bones.length > 0 && (
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <div className={styles.cardTitle}>
              <Icon name="bone" size="sm" style={{ color: '#f97316' }} />
              <span>{t('inspector.bone.hierarchy', 'Hierarchy')}</span>
              <span className={styles.badge}>{bones.length}</span>
            </div>
          </div>
          <div role="tree" aria-label={t('inspector.bone.hierarchyAria', 'Bone hierarchy')}>
            {orderedBones.map(({ bone, depth }) => {
              const selected = rigSelectionNodeId === nodeId ? selectedBoneIds.includes(bone.id) : selectedBone?.id === bone.id;
              const hasIk = ikTargets.some((target) => target.boneId === bone.id);
              return (
                <button
                  key={bone.id}
                  type="button"
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-selected={selected}
                  onClick={(e) => {
                    if (e.shiftKey) useRigSelectionStore.getState().toggleBone(nodeId, bone.id);
                    else selectBone(bone.id);
                  }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: `5px 6px 5px ${6 + depth * 14}px`,
                    border: 0,
                    borderRadius: 4,
                    background: selected ? 'rgba(43,126,255,.2)' : 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                    textAlign: 'left',
                    lineHeight: 1,
                  }}
                >
                  <Icon name="bone" size="sm" style={{ color: selected ? '#f97316' : '#94a3b8', opacity: selected ? 1 : 0.7 }} />
                  <span className={styles.boneName}>{bone.name ?? bone.id}</span>
                  {hasIk && <span className={styles.badge}>IK</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* One selected-item editor, rather than a full property card per bone. */}
      {selectedBone && [selectedBone].map((bone) => {
        const ik = ikTargets.find((tg) => tg.boneId === bone.id);
        const hasIK = ik?.enabled !== false && !!ik;

        return (
          <div key={bone.id} className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardTitle}>
                <Icon name="bone" size="sm" style={{ color: '#f97316' }} />
                {/* Editable label. The card used to print the raw generated id
                    (`bone_x8f2a1`), which is unreadable on a real character. */}
                <input
                  value={nameDraft?.boneId === bone.id ? nameDraft.value : bone.name ?? ''}
                  placeholder={bone.id}
                  aria-label={t('inspector.bone.nameAria', '{name} name', { name: bone.name || bone.id })}
                  onChange={(e) => setNameDraft({ boneId: bone.id, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    else if (e.key === 'Escape') {
                      cancelRename.current = true;
                      e.currentTarget.blur();
                    }
                  }}
                  className={styles.nameInput}
                  onBlur={() => commitRename(bone.id, bone.name)}
                />
                <span className={styles.subText}>
                  {bone.parentId
                    ? `← ${bones.find((b) => b.id === bone.parentId)?.name ?? bone.parentId}`
                    : t('inspector.bone.root', '(Root)')}
                </span>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void edit('Delete Bone', deleteBoneCommands(nodeId, bone.id));
                  selectBone(null);
                }}
                aria-label={t('inspector.bone.deleteAria', 'Delete bone {name}', { name: bone.name || bone.id })}
                title={t('inspector.bone.deleteTip', 'Delete bone')}
              >
                <Icon name="trash" size="sm" />
              </Button>
            </div>

            {/* The POSE at the playhead (the keyframeable bone tracks), each row with its
                stopwatch and navigator — Rest Angle / Scale below are the bind pose. */}
            <BonePoseRows nodeId={nodeId} bone={bone} seconds={workspaceTime} eng={eng} />
            {(() => {
              const live = posedBones.find((candidate) => candidate.id === bone.id) ?? bone;
              return (
                <div className={styles.paramRow}>
                  <span className={styles.paramLabel}>{t('inspector.bone.livePose', 'Solved Pose')}</span>
                  <span className={styles.subText}>
                    {`${((live.rotation * 180) / Math.PI).toFixed(1)}° · ${live.x.toFixed(1)}, ${live.y.toFixed(1)}`}
                  </span>
                </div>
              );
            })()}

            <div className={styles.paramRow}>
              <span className={styles.paramLabel}>{t('inspector.bone.restLength', 'Rest Length')}</span>
              <ValueField
                value={bone.length}
                min={1}
                unit="px"
                {...eng.scrub('Set Bone Length')}
                onChange={(v) => eng.send('Set Bone Length', boneFieldCommands(nodeId, bone.id, 'length', Math.max(1, v)))}
                aria-label={t('inspector.bone.lengthAria', '{name} length', { name: bone.name || bone.id })}
              />
            </div>

            <div className={styles.paramRow}>
              <span className={styles.paramLabel}>{t('inspector.bone.falloff', 'Falloff')}</span>
              {/* How far this bone's influence travels THROUGH the artwork.
                  0 = unlimited, which is what a bone holds until you set it and
                  what every rig authored before the field does. Bounding it is
                  how you stop a shoulder bone owning the whole torso simply
                  because nothing else is nearer — see `Bone.influenceRadius`. */}
              <ValueField
                value={bone.influenceRadius ?? 0}
                min={0}
                unit="px"
                {...eng.scrub('Set Bone Falloff')}
                onChange={(v) =>
                  // 0 = unlimited: the engine clears the stored field at its default.
                  eng.send('Set Bone Falloff', boneFieldCommands(nodeId, bone.id, 'influenceRadius', v > 0 ? v : 0))
                }
                aria-label={t('inspector.bone.radiusAria', '{name} influence radius', { name: bone.name || bone.id })}
              />
            </div>

            <div className={styles.paramRow}>
              <span className={styles.paramLabel}>{t('inspector.bone.restAngle', 'Rest Angle')}</span>
              {/* `Bone.rotation` is stored in RADIANS (skeleton.ts). This field
                  displayed the raw radian value under a ° label and wrote whatever
                  you typed straight back — so typing "45" set 45 radians ≈ 2578°
                  and folded the limb into itself. Convert at the display boundary.
                  The API speaks degrees (ENGINE_API.md §15.9), so the typed
                  value is sent as is: the rest pose, plus the static pose while
                  the rotation is not keyframed. */}
              <ValueField
                value={(bone.rotation * 180) / Math.PI}
                unit="°"
                {...eng.scrub('Set Bone Rest Angle')}
                onChange={(v) => eng.send('Set Bone Rest Angle', boneRestCommands(nodeId, bone.id, 'rotation', v))}
                aria-label={t('inspector.bone.rotationAria', '{name} rotation', { name: bone.name || bone.id })}
              />
            </div>

            <div className={styles.paramRow}>
              <span className={styles.paramLabel}>{t('inspector.bone.scaleXY', 'Scale X / Y')}</span>
              <div style={{ display: 'flex', gap: 4 }}>
                <ValueField
                  value={bone.scaleX ?? 1}
                  {...eng.scrub('Set Bone Scale')}
                  onChange={(v) => eng.send('Set Bone Scale', boneRestCommands(nodeId, bone.id, 'scale', { x: v, y: bone.scaleY ?? 1 }))}
                  aria-label={t('inspector.bone.scaleXAria', '{name} scale x', { name: bone.name || bone.id })}
                />
                <ValueField
                  value={bone.scaleY ?? 1}
                  {...eng.scrub('Set Bone Scale')}
                  onChange={(v) => eng.send('Set Bone Scale', boneRestCommands(nodeId, bone.id, 'scale', { x: bone.scaleX ?? 1, y: v }))}
                  aria-label={t('inspector.bone.scaleYAria', '{name} scale y', { name: bone.name || bone.id })}
                />
              </div>
            </div>

            <div className={styles.paramRow} style={{ marginTop: 2 }}>
              <span className={styles.paramLabel}>{t('inspector.bone.ik', 'Inverse Kinematics')}</span>
              <Button
                size="sm"
                variant={hasIK ? 'primary' : 'secondary'}
                onClick={() => {
                  // Off = the goal removed with its keys; a disabled goal switches back on; none = a new goal at the effector.
                  void edit(hasIK ? 'Remove IK Target' : 'Enable IK Target', ikToggleCommands(nodeId, bone.id, ik, effectorFor(bone.id)));
                }}
              >
                <Icon name="crosshair" size="sm" style={{ color: hasIK ? '#22c55e' : 'inherit' }} />
                {hasIK ? t('inspector.bone.ikActive', 'IK Active') : t('inspector.bone.enableIk', 'Enable IK Target')}
              </Button>
            </div>

            {/* IK/FK mode. Only meaningful where a chain exists, so it appears
                with the IK target rather than on every bone. Switching converts
                the pose so the limb does not move — see `ikfk.ts`. */}
            {hasIK && (
              <div className={styles.paramRow}>
                <span
                  className={styles.paramLabel}
                  title={t('inspector.bone.chainModeTip', 'IK poses the chain from its goal; FK poses it from the bones. Switching preserves the pose.')}
                >
                  {t('inspector.bone.chainMode', 'Chain Mode')}
                </span>
                <select
                  value={chainModeAt({ boneId: bone.id, ikMode: ik?.ikMode })}
                  aria-label={t('inspector.bone.chainModeAria', '{name} chain mode', { name: bone.name || bone.id })}
                  onChange={(e) => {
                    const to = e.target.value as ChainMode;
                    const keyframe =
                      usePreferenceStore.getState().timelineAutoKeyframe ||
                      // The mode property (track ikMode.<bone>) is keyframed — read at call time from the mirror.
                      documentMirror().keyframes(nodeId, rigPaths.ikProp(bone.id, 'mode')).length > 0;
                    // A client macro (planChainSwitch): mode + the pose that keeps the limb still, ONE entry.
                    // Planned from the pose the engine holds NOW: the panel's own answer can be one
                    // edit behind (a second switch right after the first), and a plan from a stale
                    // pose moves the limb.
                    void engine()
                      .query({ type: 'getRigPose', layer: nodeId, time: compTime(workspaceTime), points: [] })
                      .then((fresh) => {
                        const from = fresh.ok ? switchInputs(fresh.value) : { bones: liveBones, targets: liveTargets };
                        return edit(
                          `Switch ${bone.name || bone.id} to ${to.toUpperCase()}`,
                          chainSwitchCommands(nodeId, bone.id, to, workspaceTime, keyframe, {
                            bones: from.bones, targets: from.targets, chainLength: ik?.chainLength,
                          }),
                        );
                      });
                  }}
                  className={styles.select}
                >
                  <option value="ik">{t('inspector.bone.modeIk', 'IK (pose from the goal)')}</option>
                  <option value="fk">{t('inspector.bone.modeFk', 'FK (pose from the bones)')}</option>
                </select>
              </div>
            )}
            {hasIK && (
              <>
                <div className={styles.paramRow}>
                  <span className={styles.paramLabel}>{t('inspector.bone.chainLength', 'Chain Length')}</span>
                  <ValueField
                    value={ik?.chainLength ?? 2}
                    min={1}
                    max={8}
                    {...eng.scrub('Set IK Chain Length')}
                    onChange={(v) => eng.send('Set IK Chain Length', ikChainLengthCommands(nodeId, bone.id, v))}
                    aria-label={t('inspector.bone.chainLengthAria', '{name} IK chain length', { name: bone.name || bone.id })}
                  />
                </div>
                {/* Two-bone limbs: Stretch lets the limb lengthen to a goal past its
                    reach (bound parts lengthen with it); Softness eases the last
                    pixels of the reach so the knee never snaps straight. */}
                {(ik?.chainLength ?? 2) === 2 && (
                  <>
                    <div className={styles.paramRow}>
                      <span
                        className={styles.paramLabel}
                        title={t('inspector.bone.stretchTip', 'How far the limb may lengthen to reach its goal: 1.5 = up to 150 %. 0 = never.')}
                      >
                        {t('inspector.bone.stretch', 'Stretch')}
                      </span>
                      <ValueField
                        value={ik?.stretch ?? 0}
                        min={0}
                        max={4}
                        step={0.05}
                        {...eng.scrub('Set IK Stretch')}
                        onChange={(v) => eng.send('Set IK Stretch', ikStretchCommands(nodeId, bone.id, v))}
                        aria-label={t('inspector.bone.stretchAria', '{name} IK stretch', { name: bone.name || bone.id })}
                      />
                    </div>
                    <div className={styles.paramRow}>
                      <span
                        className={styles.paramLabel}
                        title={t('inspector.bone.softnessTip', 'Pixels over which the limb eases into full reach, so the joint never snaps straight. 0 = off.')}
                      >
                        {t('inspector.bone.softness', 'Softness')}
                      </span>
                      <ValueField
                        value={ik?.softness ?? 0}
                        min={0}
                        max={500}
                        unit="px"
                        {...eng.scrub('Set IK Softness')}
                        onChange={(v) => eng.send('Set IK Softness', ikSoftnessCommands(nodeId, bone.id, v))}
                        aria-label={t('inspector.bone.softnessAria', '{name} IK softness', { name: bone.name || bone.id })}
                      />
                    </div>
                  </>
                )}
                <div className={styles.paramRow}>
                  <RigAnimToggle
                    nodeId={nodeId}
                    path={rigPaths.ikProp(bone.id, 'target')}
                    tracks={[`ikTarget.${bone.id}.x`, `ikTarget.${bone.id}.y`]}
                    label={`${bone.name || bone.id} IK Goal`}
                    seconds={workspaceTime}
                  />
                  <span className={styles.paramLabel}>{t('inspector.bone.goalXY', 'Goal X / Y')}</span>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {/* The goal at the playhead: a typed value keys it there
                        when the target is keyframed (setValueAtTime), else
                        sets the static goal. */}
                    <ValueField
                      value={goalAt(ik!).x}
                      unit="px"
                      {...eng.scrub('Set IK Goal')}
                      onChange={(x) => eng.send('Set IK Goal', ikTargetCommands(nodeId, bone.id, { x, y: goalAt(ik!).y }, workspaceTime))}
                      aria-label={t('inspector.bone.goalXAria', '{name} IK goal x', { name: bone.name || bone.id })}
                    />
                    <ValueField
                      value={goalAt(ik!).y}
                      unit="px"
                      {...eng.scrub('Set IK Goal')}
                      onChange={(y) => eng.send('Set IK Goal', ikTargetCommands(nodeId, bone.id, { x: goalAt(ik!).x, y }, workspaceTime))}
                      aria-label={t('inspector.bone.goalYAria', '{name} IK goal y', { name: bone.name || bone.id })}
                    />
                  </div>
                </div>
              </>
            )}
            {hasIK && (
              <div className={styles.paramRow}>
                <span
                  className={styles.paramLabel}
                  title={t('inspector.bone.poleTip', 'The side the joint bends toward. Without a pole the solver only preserves the current side and can never flip it.')}
                >
                  {t('inspector.bone.poleVector', 'Pole Vector')}
                </span>
                <Button
                  size="sm"
                  variant={ik?.pole ? 'primary' : 'secondary'}
                  onClick={() => {
                    // A toggle, as it always was: "Pole Set" takes the pole off again.
                    if (ik?.pole) void edit('Remove Pole', removePoleCommands(nodeId, bone.id));
                    else void edit('Add Pole', addPoleCommands(nodeId, bone.id, poleFor(bone.id, ik!.chainLength)));
                  }}
                >
                  {ik?.pole ? t('inspector.bone.poleSet', 'Pole Set') : t('inspector.bone.addPole', 'Add Pole')}
                </Button>
                {ik?.pole && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => { void edit('Remove Pole', removePoleCommands(nodeId, bone.id)); }}
                  >
                    {t('inspector.bone.remove', 'Remove')}
                  </Button>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* ── Controllers ────────────────────────────────────────────
          The grab handles. Listed after the bones because a controller is
          defined BY the bone it drives — the link is picked from the bones
          above, so there is nothing to configure before one exists. */}
      {boneRigMode === 'pose' && bones.length > 0 && (
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <div className={styles.cardTitle}>
              <Icon name="puppet-pin" size="sm" style={{ color: '#f97316' }} />
              <span>{t('inspector.bone.controllers', 'Controllers')}</span>
              <span className={styles.badge}>{controllers.length}</span>
            </div>
          </div>

          {controllers.length === 0 && (
            <div className={styles.subText} style={{ margin: "2px 0 8px" }}>
              {t('inspector.bone.noControllers', 'Add a handle to pose a bone or an IK goal without grabbing the joint.')}
            </div>
          )}

          {controllers.map((c) => (
            <div
              key={c.id}
              className={styles.paramRow}
              style={{
                flexWrap: 'wrap',
                gap: 4,
                borderRadius: 4,
                background:
                  rigSelectionNodeId === nodeId && selectedControllerId === c.id
                    ? 'rgba(43,126,255,.16)'
                    : undefined,
              }}
              onClick={() =>
                useRigSelectionStore.getState().selectController(nodeId, c.id, c.link.boneId)
              }
            >
              <span className={styles.paramLabel} style={{ flexBasis: "100%" }}>
                {c.link.kind === "ikTarget"
                  ? t('inspector.bone.linkIk', '{name} → IK goal {bone}', { name: c.name ?? c.id, bone: c.link.boneId })
                  : t('inspector.bone.linkBone', '{name} → bone {bone}', { name: c.name ?? c.id, bone: c.link.boneId })}
              </span>
              <select
                value={c.shape}
                aria-label={t('inspector.bone.ctrlShapeAria', '{name} shape', { name: c.name ?? c.id })}
                onChange={(e) => {
                  void edit('Set Controller Shape', controllerFieldCommands(nodeId, c.id, 'shape', e.target.value as ControllerShape));
                }}
                className={styles.select}
              >
                {CONTROLLER_SHAPES.map((sh) => (<option key={sh} value={sh}>{sh}</option>))}
              </select>
              <select
                value={c.side}
                aria-label={t('inspector.bone.ctrlSideAria', '{name} side', { name: c.name ?? c.id })}
                onChange={(e) => {
                  void edit('Set Controller Side', controllerFieldCommands(nodeId, c.id, 'side', e.target.value as ControllerSide));
                }}
                className={styles.select}
              >
                {CONTROLLER_SIDES.map((sd) => (<option key={sd} value={sd}>{sd}</option>))}
              </select>
              <ValueField
                value={c.size}
                min={4}
                unit="px"
                aria-label={t('inspector.bone.ctrlSizeAria', '{name} size', { name: c.name ?? c.id })}
                {...eng.scrub('Set Controller Size')}
                onChange={(v) => eng.send('Set Controller Size', controllerFieldCommands(nodeId, c.id, 'size', Math.max(4, v)))}
              />
              <Button
                size="sm"
                variant="ghost"
                aria-label={t('inspector.bone.ctrlDeleteAria', 'Delete controller {name}', { name: c.name ?? c.id })}
                onClick={() => { void edit('Delete Controller', deleteControllerCommands(nodeId, c.id)); }}
              >
                <Icon name="trash" size="sm" />
              </Button>
            </div>
          ))}

          {/* One add per bone, and the LINK KIND is chosen here rather than
              edited afterwards: an IK controller and an FK controller drive
              different things, so the choice belongs at creation. */}
          <div className={styles.paramRow} style={{ flexWrap: "wrap", gap: 4 }}>
            <select
              value=""
              aria-label={t('inspector.bone.addControllerAria', 'Add controller')}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                const [kind, boneId] = v.split(":") as ["bone" | "ikTarget", string];
                // The engine mints the id; the defaults (shape by link kind, the bone's name) are the model's.
                void edit('Add Controller', addControllerCommands(nodeId, defaultControllerFor({ kind, boneId }, controllers, bones)));
                e.currentTarget.value = "";
              }}
              className={styles.select}
            >
              <option value="">{t('inspector.bone.addController', 'Add controller…')}</option>
              {bones.map((b) => (
                <option key={`fk-${b.id}`} value={`bone:${b.id}`}>
                  {t('inspector.bone.addControllerFk', '{name} (FK bone)', { name: b.name ?? b.id })}
                </option>
              ))}
              {ikTargets.map((tg) => (
                <option key={`ik-${tg.boneId}`} value={`ikTarget:${tg.boneId}`}>
                  {t('inspector.bone.addControllerIk', '{name} (IK goal)', { name: bones.find((b) => b.id === tg.boneId)?.name ?? tg.boneId })}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A bone's POSE rows (C2): Rotation, Position X / Y, Scale X / Y at the playhead
 * — the keyframeable `bone.<id>.*` tracks, each with its stopwatch and (once
 * animated) the ◀ ◆ ▶ navigator, like a Transform row. The values are the LIVE
 * ones (the mirror's `valueAt` samples the keys); a typed value follows the
 * one keying rule (`rigAutoKey`): a key when animated or under auto-keyframe,
 * else the static pose (the engine captures the bind pose first).
 */
function BonePoseRows({ nodeId, bone, seconds, eng }: { nodeId: string; bone: Bone; seconds: number; eng: ReturnType<typeof useEngineEdit> }): JSX.Element {
  const name = bone.name || bone.id;
  const shown = compTime(useThrottledTime());
  const rotation = numbersOfValue(useMirrorValueAt(nodeId, rigPaths.boneProp(bone.id, 'rotation'), shown))[0] ?? (bone.rotation * 180) / Math.PI;
  const position = numbersOfValue(useMirrorValueAt(nodeId, rigPaths.boneProp(bone.id, 'position'), shown));
  const scale = numbersOfValue(useMirrorValueAt(nodeId, rigPaths.boneProp(bone.id, 'scale'), shown));
  const px = position[0] ?? bone.x;
  const py = position[1] ?? bone.y;
  const sx = (scale[0] ?? (bone.scaleX ?? 1) * 100) / 100;
  const sy = (scale[1] ?? (bone.scaleY ?? 1) * 100) / 100;
  const label = 'Pose Bone';
  const track = (p: string): string => `bone.${bone.id}.${p}`;
  return (
    <>
      <div className={styles.paramRow}>
        <RigAnimToggle nodeId={nodeId} path={rigPaths.boneProp(bone.id, 'rotation')} tracks={[track('rotation')]} label={`${name} Rotation`} seconds={seconds} />
        <span className={styles.paramLabel}>{t('inspector.bone.poseRotation', 'Rotation')}</span>
        <ValueField
          value={rotation}
          unit="°"
          {...eng.scrub(label)}
          onChange={(v) => eng.send(label, bonePoseCommands(nodeId, bone.id, 'rotation', v, seconds))}
          aria-label={t('inspector.bone.poseRotationAria', '{name} pose rotation', { name })}
        />
      </div>
      <div className={styles.paramRow}>
        <RigAnimToggle nodeId={nodeId} path={rigPaths.boneProp(bone.id, 'position')} tracks={[track('x'), track('y')]} label={`${name} Position`} seconds={seconds} />
        <span className={styles.paramLabel}>{t('inspector.bone.posePosition', 'Position X / Y')}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <ValueField
            value={px}
            unit="px"
            {...eng.scrub(label)}
            onChange={(x) => eng.send(label, bonePoseCommands(nodeId, bone.id, 'position', { x, y: py }, seconds))}
            aria-label={t('inspector.bone.posePositionXAria', '{name} pose x', { name })}
          />
          <ValueField
            value={py}
            unit="px"
            {...eng.scrub(label)}
            onChange={(y) => eng.send(label, bonePoseCommands(nodeId, bone.id, 'position', { x: px, y }, seconds))}
            aria-label={t('inspector.bone.posePositionYAria', '{name} pose y', { name })}
          />
        </div>
      </div>
      <div className={styles.paramRow}>
        <RigAnimToggle nodeId={nodeId} path={rigPaths.boneProp(bone.id, 'scale')} tracks={[track('scaleX'), track('scaleY')]} label={`${name} Scale`} seconds={seconds} />
        <span className={styles.paramLabel}>{t('inspector.bone.poseScale', 'Scale X / Y')}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <ValueField
            value={sx}
            {...eng.scrub(label)}
            onChange={(v) => eng.send(label, bonePoseCommands(nodeId, bone.id, 'scale', { x: v, y: sy }, seconds))}
            aria-label={t('inspector.bone.poseScaleXAria', '{name} pose scale x', { name })}
          />
          <ValueField
            value={sy}
            {...eng.scrub(label)}
            onChange={(v) => eng.send(label, bonePoseCommands(nodeId, bone.id, 'scale', { x: sx, y: v }, seconds))}
            aria-label={t('inspector.bone.poseScaleYAria', '{name} pose scale y', { name })}
          />
        </div>
      </div>
    </>
  );
}

export default BoneControls;
