import { ValueField } from '@components/ValueField';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { useSceneRevision } from '@stores/sceneStore';
import { useUIStore } from '@stores/uiStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeSkeleton, updateBone, deleteBone, setIKTarget, updateSkeletonSettings } from '@core/rig/skeletonCommands';
import { readNodePuppet } from '@core/rig/puppet';
import styles from './BoneControls.module.css';

export function BoneControls({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;

  const skel = readNodeSkeleton(node);
  const bones = skel?.bones ?? [];
  const ikTargets = skel?.ikTargets ?? [];
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
                <span>{bone.id}</span>
                <span className={styles.subText}>
                  {bone.parentId ? `← ${bone.parentId}` : '(Root)'}
                </span>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => deleteBone(nodeId, bone.id)}
                aria-label={`Delete bone ${bone.id}`}
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
                aria-label={`${bone.id} length`}
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
                aria-label={`${bone.id} rotation`}
              />
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
                  })
                }
              >
                <Icon name="crosshair" size={12} />
                {hasIK ? 'IK Active' : 'Enable IK Target'}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default BoneControls;
