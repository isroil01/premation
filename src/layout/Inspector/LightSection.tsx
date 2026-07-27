/**
 * LightSection — curated light controls (color / intensity / radius) replacing
 * the raw generic prop dump. Intensity and radius are keyframeable: the
 * renderer already samples their tracks (buildSnapshot reads av.get('intensity')
 * / av.get('radius')), so each row carries the standard keyframe toggle.
 */

import { useMemo } from 'react';
import { ColorPicker } from '@components/ColorPicker';
import { Checkbox } from '@components/Checkbox';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import styles from './TransformSection.module.css';
import { KeyframeRow as KfRow } from './KeyframeRow';

export function LightSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  const tComp = useMemo(() => node?.components.find((c) => c.type === 'Transform'), [node]);
  const sComp = useMemo(() => node?.components.find((c) => c.type === 'Style'), [node]);
  const [intensityRaw, setIntensity] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'intensity');
  const [radiusRaw, setRadius] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'radius');
  const [typeRaw, setType] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'lightType');
  const [angleRaw, setAngle] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'lightAngle');
  const [coneRaw, setCone] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'lightCone');
  const [fillRaw, setFill] = useNodeComponentProp(defaultSceneGraph, nodeId, sComp?.id, 'fill');
  const [shadowsRaw, setShadows] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'castShadows');
  if (!node || !tComp) return null;

  const intensity = typeof intensityRaw === 'number' ? intensityRaw : 100;
  const radius = typeof radiusRaw === 'number' ? radiusRaw : 500;
  const color = typeof fillRaw === 'string' ? fillRaw : '#fff3c0';
  const type = typeRaw === 'ambient' || typeRaw === 'spot' || typeRaw === 'parallel' ? typeRaw : 'point';
  const angle = typeof angleRaw === 'number' ? angleRaw : 0;
  const cone = typeof coneRaw === 'number' ? coneRaw : 45;

  return (
    <div className={styles.section}>
      <h4 className={styles.title}>Light</h4>
      <div className={styles.inlineRows}>
        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Type</span>
          <select
            className={styles.select}
            style={{ width: 110 }}
            value={type}
            onChange={(e) => setType(e.target.value)}
            aria-label="Light type"
          >
            <option value="point">Point (glow)</option>
            <option value="ambient">Ambient (lift)</option>
            <option value="spot">Spot (cone)</option>
            <option value="parallel">Parallel (directional)</option>
          </select>
        </div>
        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Color</span>
          <ColorPicker value={color} onChange={(hex) => setFill(hex)} aria-label="Light color" />
        </div>
        <KfRow nodeId={nodeId} prop="intensity" label="Intensity" value={intensity} unit="%" min={0} onStatic={(v) => setIntensity(v)} />
        {type !== 'ambient' && (
          <KfRow nodeId={nodeId} prop="radius" label="Radius" value={radius} unit="px" min={1} onStatic={(v) => setRadius(v)} />
        )}
        {(type === 'spot' || type === 'parallel') && (
          <KfRow nodeId={nodeId} prop="lightAngle" label="Direction" value={angle} unit="°" onStatic={(v) => setAngle(v)} />
        )}
        {type === 'spot' && (
          <KfRow nodeId={nodeId} prop="lightCone" label="Cone" value={cone} unit="°" min={1} onStatic={(v) => setCone(v)} />
        )}
        {type !== 'ambient' && (
          <div className={styles.popoverRow}>
            <span className={styles.popoverLabel}>Cast shadows</span>
            <Checkbox
              checked={shadowsRaw === true || shadowsRaw === 1}
              onChange={() => setShadows(shadowsRaw === true || shadowsRaw === 1 ? false : true)}
              title="Content layers drop a soft shadow away from this light"
            />
          </div>
        )}
        <p style={{ margin: '6px 0 0', fontSize: 10, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
          {type === 'ambient'
            ? 'A uniform lift brightening the whole frame (screen blend).'
            : type === 'spot'
              ? 'A cone of light along its direction, fading over the radius.'
              : type === 'parallel'
                ? 'A directional wash across the frame (like sunlight), brighter on the source side.'
                : 'A point light brightening the layers beneath it (screen blend).'}
          {' '}Numeric parameters are keyframeable.
        </p>
      </div>
    </div>
  );
}

export default LightSection;
