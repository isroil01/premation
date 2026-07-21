import { ValueField } from '@components/ValueField';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { useSceneRevision } from '@stores/sceneStore';
import { useUIStore } from '@stores/uiStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeSkeleton, updateBone, deleteBone, setIKTarget } from '@core/rig/skeletonCommands';
import styles from './BoneControls.module.css';

export function BoneControls({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;

  const skel = readNodeSkeleton(node);
  const bones = skel?.bones ?? [];
  const ikTargets = skel?.ikTargets ?? [];

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
              <ValueField
                value={bone.rotation}
                unit="°"
                onChange={(v) => updateBone(nodeId, bone.id, { rotation: v })}
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
