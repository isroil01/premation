import { ValueField } from '@components/ValueField';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { useSceneRevision } from '@stores/sceneStore';
import { useUIStore } from '@stores/uiStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeSkeleton, updateBone, deleteBone, setIKTarget, updateSkeletonSettings, setChainMode } from '@core/rig/skeletonCommands';
import { chainModeOf } from '@core/rig/liveIkTargets';
import { applyRigPreset } from '@core/rig/skeletonCommands';
import { RIG_PRESETS, RIG_PRESET_LABELS, type RigPresetId } from '@core/rig/rigPresets';
import { readGeometry } from '@core/workspace/geometry';
import { chainModePropPath, type ChainMode } from '@core/rig/ikfk';
import { defaultAnimation } from '@motion/animation';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { addController, deleteController, updateController } from '@core/rig/skeletonCommands';
import {
  defaultControllerFor, CONTROLLER_SHAPES, CONTROLLER_SIDES,
  type ControllerShape, type ControllerSide,
} from '@core/rig/controllers';
import { readNodePuppet } from '@core/rig/puppet';
import styles from './BoneControls.module.css';

/** Shared <select> chrome — matches PuppetControls so the two rig panels agree. */
const selectStyle: React.CSSProperties = {
  padding: '3px 8px',
  fontSize: 11,
  borderRadius: 4,
  background: 'var(--color-surface, #1e1e1e)',
  color: 'var(--color-text-primary, #fff)',
  border: '1px solid var(--color-border, #333)',
};

export function BoneControls({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  // EVERY hook above the `!node` guard. React counts hooks per render, so a
  // hook below an early return runs on one pass and not the next — "Rendered
  // fewer hooks than expected", which unmounts the tree and takes the editor
  // down. Deleting a selected layer with this panel open is the ordinary way to
  // hit it; `conditionalHooks.test.tsx` exists because it has happened before.
  const workspaceTime = useActiveWorkspace()?.time ?? 0;
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;

  const skel = readNodeSkeleton(node);
  const bones = skel?.bones ?? [];
  const ikTargets = skel?.ikTargets ?? [];
  const controllers = skel?.controllers ?? [];
  // The canonical keyframe axis for this layer — the same forward map the
  // renderer samples, so a mode keyframe lands where the pose does.
  const layerT = compToKeyframeTime(nodeId, workspaceTime);
  const hasPuppet = ((readNodePuppet(node)?.pins ?? []).length ?? 0) > 0;

  return (
    <div className={styles.root}>
      {/* Skeleton summary card */}
      <div className={styles.headerCard}>
        <div className={styles.headerTitle}>
          <Icon name="bone" size={14} />
          <span>Skeleton Hierarchy</span>
          <span className={styles.badge}>{bones.length} bones</span>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => useUIStore.getState().setActiveTool('bone')}
        >
          <Icon name="plus" size={12} /> Add Joint
        </Button>
      </div>

      {/* Auto-rig. Offered whether or not bones exist, but the destructive
          case is stated on the control itself: applying a preset REPLACES the
          rig, because merging two skeletons produces duplicate bone ids and a
          duplicate id silently couples two bones onto one animation track. */}
      <div className={styles.paramRow}>
        <span className={styles.paramLabel} title="Generates bones, IK chains and controllers scaled to this layer. Replaces any existing rig.">
          Auto-Rig
        </span>
        <select
          value=""
          aria-label="Auto-rig preset"
          onChange={(e) => {
            const id = e.target.value as RigPresetId;
            if (!id) return;
            const geom = readGeometry(node);
            const problems = applyRigPreset(
              nodeId,
              RIG_PRESETS[id]({ width: geom?.width ?? 200, height: geom?.height ?? 200 }),
              `Auto-Rig ${RIG_PRESET_LABELS[id]}`,
            );
            if (problems.length > 0) {
              // Never silently: a refused rig with no message reads as a dead
              // control, which is worse than the error.
              console.error("Auto-rig refused:", problems);
            }
            e.currentTarget.value = "";
          }}
          style={selectStyle}
        >
          <option value="">Generate…</option>
          {(Object.keys(RIG_PRESETS) as RigPresetId[]).map((id) => (
            <option key={id} value={id}>{RIG_PRESET_LABELS[id]}</option>
          ))}
        </select>
      </div>
      {bones.length === 0 && (
        <div className={styles.card} style={{ textAlign: 'center', padding: '16px 12px' }}>
          <span className={styles.subText}>No bones added to this layer.</span>
          <Button
            size="sm"
            variant="primary"
            onClick={() => useUIStore.getState().setActiveTool('bone')}
            style={{ marginTop: 8 }}
          >
            <Icon name="bone" size={12} /> Draw Bones with Bone Tool (Ctrl+B)
          </Button>
        </div>
      )}

      {bones.length > 0 && hasPuppet && (
        <div className={styles.card} style={{ padding: '10px 12px' }}>
          <span className={styles.subText}>
            This layer also has puppet pins — the two rigs compose: the puppet
            refines the mesh first, then the skeleton pose carries it. The
            skinning mesh below follows the puppet's mesh settings.
          </span>
        </div>
      )}

      {bones.length > 0 && !hasPuppet && (
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <div className={styles.cardTitle}>
              <Icon name="grid" size={13} style={{ opacity: 0.7 }} />
              <span>Skinning Mesh</span>
            </div>
          </div>
          <div className={styles.paramRow}>
            <span className={styles.paramLabel}>Density</span>
            <ValueField
              value={skel?.meshDensity ?? 15}
              min={2}
              max={50}
              onChange={(v) => updateSkeletonSettings(nodeId, { meshDensity: Math.round(v) })}
              aria-label="Skinning mesh density"
            />
          </div>
          <div className={styles.paramRow}>
            <span className={styles.paramLabel}>Expansion</span>
            <ValueField
              value={skel?.meshExpansion ?? 8}
              min={0}
              max={100}
              unit="px"
              onChange={(v) => updateSkeletonSettings(nodeId, { meshExpansion: Math.round(v) })}
              aria-label="Skinning mesh expansion"
            />
          </div>
        </div>
      )}

      {/* Bone list cards */}
      {bones.map((bone) => {
        const ik = ikTargets.find((t) => t.boneId === bone.id);
        const hasIK = ik?.enabled !== false && !!ik;

        return (
          <div key={bone.id} className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardTitle}>
                <Icon name="bone" size={13} style={{ opacity: 0.7 }} />
                {/* Editable label. The card used to print the raw generated id
                    (`bone_x8f2a1`), which is unreadable on a real character. */}
                <input
                  value={bone.name ?? ''}
                  placeholder={bone.id}
                  aria-label={`${bone.name || bone.id} name`}
                  onChange={(e) =>
                    updateBone(nodeId, bone.id, { name: e.target.value || undefined })
                  }
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 11,
                    padding: '2px 4px',
                    borderRadius: 4,
                    background: 'transparent',
                    color: 'var(--color-text-primary, #fff)',
                    border: '1px solid transparent',
                  }}
                  onFocus={(e) => (e.currentTarget.style.border = '1px solid var(--color-border, #333)')}
                  onBlur={(e) => (e.currentTarget.style.border = '1px solid transparent')}
                />
                <span className={styles.subText}>
                  {bone.parentId
                    ? `← ${bones.find((b) => b.id === bone.parentId)?.name ?? bone.parentId}`
                    : '(Root)'}
                </span>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => deleteBone(nodeId, bone.id)}
                aria-label={`Delete bone ${bone.name || bone.id}`}
                title="Delete bone"
              >
                <Icon name="trash" size={12} />
              </Button>
            </div>

            <div className={styles.paramRow}>
              <span className={styles.paramLabel}>Bone Length</span>
              <ValueField
                value={bone.length}
                min={1}
                unit="px"
                onChange={(v) => updateBone(nodeId, bone.id, { length: Math.max(1, v) })}
                aria-label={`${bone.name || bone.id} length`}
              />
            </div>

            <div className={styles.paramRow}>
              <span className={styles.paramLabel}>Rest Angle</span>
              {/* `Bone.rotation` is stored in RADIANS (skeleton.ts). This field
                  displayed the raw radian value under a ° label and wrote whatever
                  you typed straight back — so typing "45" set 45 radians ≈ 2578°
                  and folded the limb into itself. Convert at the display boundary. */}
              <ValueField
                value={(bone.rotation * 180) / Math.PI}
                unit="°"
                onChange={(v) => updateBone(nodeId, bone.id, { rotation: (v * Math.PI) / 180 })}
                aria-label={`${bone.name || bone.id} rotation`}
              />
            </div>

            <div className={styles.paramRow}>
              <span className={styles.paramLabel}>Scale X / Y</span>
              <div style={{ display: 'flex', gap: 4 }}>
                <ValueField
                  value={bone.scaleX ?? 1}
                  onChange={(v) => updateBone(nodeId, bone.id, { scaleX: v })}
                  aria-label={`${bone.name || bone.id} scale x`}
                />
                <ValueField
                  value={bone.scaleY ?? 1}
                  onChange={(v) => updateBone(nodeId, bone.id, { scaleY: v })}
                  aria-label={`${bone.name || bone.id} scale y`}
                />
              </div>
            </div>

            <div className={styles.paramRow} style={{ marginTop: 2 }}>
              <span className={styles.paramLabel}>Inverse Kinematics</span>
              <Button
                size="sm"
                variant={hasIK ? 'primary' : 'secondary'}
                onClick={() =>
                  setIKTarget(nodeId, {
                    boneId: bone.id,
                    x: bone.length,
                    y: 0,
                    enabled: !hasIK,
                    ...(ik?.pole ? { pole: ik.pole } : {}),
                    ...(ik?.chainLength ? { chainLength: ik.chainLength } : {}),
                  })
                }
              >
                <Icon name="crosshair" size={12} />
                {hasIK ? 'IK Active' : 'Enable IK Target'}
              </Button>
            </div>

            {/* IK/FK mode. Only meaningful where a chain exists, so it appears
                with the IK target rather than on every bone. Switching converts
                the pose so the limb does not move — see `ikfk.ts`. */}
            {hasIK && (
              <div className={styles.paramRow}>
                <span
                  className={styles.paramLabel}
                  title="IK poses the chain from its goal; FK poses it from the bones. Switching preserves the pose."
                >
                  Chain Mode
                </span>
                <select
                  value={chainModeOf({ boneId: bone.id, ikMode: ik?.ikMode }, nodeId, layerT)}
                  aria-label={`${bone.name || bone.id} chain mode`}
                  onChange={(e) =>
                    setChainMode(nodeId, bone.id, e.target.value as ChainMode, {
                      layerT,
                      keyframe:
                        usePreferenceStore.getState().timelineAutoKeyframe ||
                        defaultAnimation.isAnimated(nodeId, chainModePropPath(bone.id)),
                    })
                  }
                  style={selectStyle}
                >
                  <option value="ik">IK (pose from the goal)</option>
                  <option value="fk">FK (pose from the bones)</option>
                </select>
              </div>
            )}
            {hasIK && (
              <div className={styles.paramRow}>
                <span
                  className={styles.paramLabel}
                  title="The side the joint bends toward. Without a pole the solver only preserves the current side and can never flip it."
                >
                  Pole Vector
                </span>
                <Button
                  size="sm"
                  variant={ik?.pole ? 'primary' : 'secondary'}
                  onClick={() =>
                    setIKTarget(nodeId, {
                      boneId: bone.id,
                      x: ik!.x,
                      y: ik!.y,
                      enabled: true,
                      chainLength: ik!.chainLength,
                      // Seed the pole perpendicular to the bone so it starts on
                      // one clear side; drag the handle on canvas to choose.
                      ...(ik?.pole ? {} : { pole: { x: 0, y: -bone.length } }),
                    })
                  }
                >
                  {ik?.pole ? 'Pole Set' : 'Add Pole'}
                </Button>
              </div>
            )}
          </div>
        );
      })}

      {/* ── Controllers ────────────────────────────────────────────
          The grab handles. Listed after the bones because a controller is
          defined BY the bone it drives — the link is picked from the bones
          above, so there is nothing to configure before one exists. */}
      {bones.length > 0 && (
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <div className={styles.cardTitle}>
              <Icon name="puppet-pin" size={13} style={{ opacity: 0.7 }} />
              <span>Controllers</span>
              <span className={styles.badge}>{controllers.length}</span>
            </div>
          </div>

          {controllers.length === 0 && (
            <div className={styles.subText} style={{ margin: "2px 0 8px" }}>
              Add a handle to pose a bone or an IK goal without grabbing the joint.
            </div>
          )}

          {controllers.map((c) => (
            <div key={c.id} className={styles.paramRow} style={{ flexWrap: "wrap", gap: 4 }}>
              <span className={styles.paramLabel} style={{ flexBasis: "100%" }}>
                {c.name ?? c.id} → {c.link.kind === "ikTarget" ? "IK goal" : "bone"} {c.link.boneId}
              </span>
              <select
                value={c.shape}
                aria-label={`${c.name ?? c.id} shape`}
                onChange={(e) => updateController(nodeId, c.id, { shape: e.target.value as ControllerShape })}
                style={selectStyle}
              >
                {CONTROLLER_SHAPES.map((sh) => (<option key={sh} value={sh}>{sh}</option>))}
              </select>
              <select
                value={c.side}
                aria-label={`${c.name ?? c.id} side`}
                onChange={(e) => updateController(nodeId, c.id, { side: e.target.value as ControllerSide })}
                style={selectStyle}
              >
                {CONTROLLER_SIDES.map((sd) => (<option key={sd} value={sd}>{sd}</option>))}
              </select>
              <ValueField
                value={c.size}
                min={4}
                unit="px"
                aria-label={`${c.name ?? c.id} size`}
                onChange={(v) => updateController(nodeId, c.id, { size: Math.max(4, v) })}
              />
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Delete controller ${c.name ?? c.id}`}
                onClick={() => deleteController(nodeId, c.id)}
              >
                <Icon name="trash" size={12} />
              </Button>
            </div>
          ))}

          {/* One add per bone, and the LINK KIND is chosen here rather than
              edited afterwards: an IK controller and an FK controller drive
              different things, so the choice belongs at creation. */}
          <div className={styles.paramRow} style={{ flexWrap: "wrap", gap: 4 }}>
            <select
              value=""
              aria-label="Add controller"
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                const [kind, boneId] = v.split(":") as ["bone" | "ikTarget", string];
                addController(nodeId, defaultControllerFor({ kind, boneId }, controllers, bones));
                e.currentTarget.value = "";
              }}
              style={selectStyle}
            >
              <option value="">Add controller…</option>
              {bones.map((b) => (
                <option key={`fk-${b.id}`} value={`bone:${b.id}`}>
                  {b.name ?? b.id} (FK bone)
                </option>
              ))}
              {ikTargets.map((t) => (
                <option key={`ik-${t.boneId}`} value={`ikTarget:${t.boneId}`}>
                  {bones.find((b) => b.id === t.boneId)?.name ?? t.boneId} (IK goal)
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}

export default BoneControls;
