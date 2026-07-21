/**
 * LightSection — curated light controls (color / intensity / radius) replacing
 * the raw generic prop dump. Intensity and radius are keyframeable: the
 * renderer already samples their tracks (buildSnapshot reads av.get('intensity')
 * / av.get('radius')), so each row carries the standard keyframe toggle.
 */

import { useMemo } from 'react';
import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';
import { Checkbox } from '@components/Checkbox';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import { useActiveWorkspace } from '@stores/projectStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { getTimelineController } from '@core/timeline/TimelineController';
import styles from './TransformSection.module.css';

function KfRow({
  nodeId,
  prop,
  label,
  value,
  unit,
  min,
  onStatic,
}: {
  nodeId: string;
  prop: string;
  label: string;
  value: number;
  unit: string;
  min?: number;
  onStatic: (v: number) => void;
}): JSX.Element {
  const time = useActiveWorkspace()?.time ?? 0;
  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);
  const animated = defaultAnimation.isAnimated(nodeId, prop);
  const layerT = getTimelineController().toLayerTime(nodeId, time);
  const display = animated ? defaultAnimation.sample(nodeId, prop, layerT) ?? value : value;

  const handleChange = (v: number) => {
    if (animated || autoKeyframe) {
      runAnimEdit(
        `Set ${prop}`,
        () => defaultAnimation.setKeyframe(nodeId, prop, layerT, v),
        `set:${nodeId}:${prop}:${time}`,
      );
    } else {
      onStatic(v);
    }
  };

  return (
    <div className={styles.popoverRow}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
        <Checkbox
          checked={animated}
          onChange={() => {
            if (animated) runAnimEdit(`Remove ${prop} animation`, () => defaultAnimation.removeTrack(nodeId, prop));
            else runAnimEdit(`Animate ${prop}`, () => defaultAnimation.setKeyframe(nodeId, prop, layerT, value));
          }}
          title="Toggle Keyframes"
          style={{ width: 13, height: 13 }}
        />
        <span className={styles.popoverLabel}>{label}</span>
      </div>
      <ValueField value={Math.round(display ?? 0)} unit={unit} {...(min !== undefined ? { min } : {})} onChange={(v) => handleChange(Number(v))} aria-label={label} />
    </div>
  );
}

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
