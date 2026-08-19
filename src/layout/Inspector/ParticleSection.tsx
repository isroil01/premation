/**
 * ParticleSection — controls for a particle emitter. The whole config is one
 * object on the layer's `fx` component (`setParticle`), so edits merge a field
 * and re-render. Every numeric field is keyframeable under `particle.<key>`
 * (stopwatch per row, sampled per frame by resolveParticleConfig); colors
 * keyframe via channel tracks through ColorKfRow, like fill/stroke.
 */

import { ValueField } from '@components/ValueField';
import { Checkbox } from '@components/Checkbox';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeParticle, DEFAULT_PARTICLE_CONFIG, particlePropPath, type ParticleConfig, type ParticleNumericKey } from '@core/particles/particleSim';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { useActiveWorkspace } from '@stores/projectStore';
import { useAnimationRevision } from '@hooks/useAnimationRevision';
import { ColorKfRow } from './ColorKfRow';
import { writeTransformProps } from '@core/scene/transformWrite';
import styles from './TransformSection.module.css';

export function ParticleSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  useAnimationRevision();
  const time = useActiveWorkspace()?.time ?? 0;
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const cfg = readNodeParticle(node) ?? DEFAULT_PARTICLE_CONFIG;
  // ONE axis for reads and writes: the canonical keyframe time (reads used to
  // be on the renderer axis while writes subtracted the first clip's start —
  // a moved/trimmed clip made every edit land beside the keyframe it showed).
  const layerT = compToKeyframeTime(nodeId, time);

  const set = <K extends keyof ParticleConfig>(key: K, value: ParticleConfig[K]): void => {
    defaultSceneGraph.setParticle(nodeId, { ...cfg, [key]: value });
    // The emitter box mirrors the layer's Transform size. Routed through
    // writeTransformProps so an emitter on a layer with animated width/height
    // keyframes rather than taking a base write the renderer discards.
    if (key === 'emitterWidth' && typeof value === 'number') {
      writeTransformProps(nodeId, [{ prop: 'width', value }], 'Emitter Width');
    } else if (key === 'emitterHeight' && typeof value === 'number') {
      writeTransformProps(nodeId, [{ prop: 'height', value }], 'Emitter Height');
    }
    bumpScene();
  };

  const Num = (key: ParticleNumericKey, label: string, unit = '', min?: number, max?: number): JSX.Element => {
    const prop = particlePropPath(key);
    const animated = defaultAnimation.isAnimated(nodeId, prop);
    const shown = animated
      ? defaultAnimation.sample(nodeId, prop, layerT) ?? (cfg[key] as number)
      : (cfg[key] as number);
    const toggle = (): void => {
      if (animated) {
        runAnimEdit(`Remove ${label} animation`, () => defaultAnimation.removeTrack(nodeId, prop));
      } else {
        runAnimEdit(`Animate ${label}`, () =>
          defaultAnimation.setKeyframe(nodeId, prop, layerT, cfg[key] as number));
      }
    };
    return (
      <div className={styles.popoverRow}>
        <Checkbox checked={animated} onChange={toggle} title="Toggle Keyframes" style={{ width: 13, height: 13 }} />
        <span className={styles.popoverLabel}>{label}</span>
        <ValueField
          value={shown}
          unit={unit}
          {...(min !== undefined ? { min } : {})}
          {...(max !== undefined ? { max } : {})}
          onChange={(v) => {
            if (animated) {
              // Editing an animated param writes a keyframe at the playhead —
              // writing the static config would change nothing on screen.
              runAnimEdit(`Set ${label}`, () =>
                defaultAnimation.setKeyframe(nodeId, prop, layerT, Number(v)),
                `particle:${nodeId}:${prop}`);
            } else {
              set(key, Number(v) as ParticleConfig[typeof key]);
            }
          }}
          aria-label={label}
        />
      </div>
    );
  };

  // Structural fields (particle cap, RNG seed) — not keyframeable: they change
  // the particle INDEXING itself, so animating them would reshuffle every
  // particle each frame.
  const StaticNum = (key: 'maxParticles' | 'seed', label: string, min?: number): JSX.Element => (
    <div className={styles.popoverRow}>
      <div style={{ width: 13 }} />
      <span className={styles.popoverLabel}>{label}</span>
      <ValueField
        value={cfg[key]}
        {...(min !== undefined ? { min } : {})}
        onChange={(v) => set(key, Number(v) as ParticleConfig[typeof key])}
        aria-label={label}
      />
    </div>
  );

  const Color = (key: 'colorStart' | 'colorEnd', label: string): JSX.Element => (
    <ColorKfRow
      nodeId={nodeId}
      propPrefix={particlePropPath(key)}
      label={label}
      value={cfg[key]}
      setValue={(hex) => set(key, hex)}
    />
  );

  return (
    <div className={styles.section}>
      <div className={styles.inlineRows}>
        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Emitter</span>
          <select className={styles.select} style={{ width: 110 }} value={cfg.emitterType} onChange={(e) => set('emitterType', e.target.value as ParticleConfig['emitterType'])} aria-label="Emitter type">
            <option value="point">Point</option>
            <option value="box">Box</option>
            <option value="circle">Circle</option>
          </select>
        </div>
        {cfg.emitterType !== 'point' && (
          <>
            {Num('emitterWidth', cfg.emitterType === 'circle' ? 'Diameter' : 'Width', 'px', 0)}
            {cfg.emitterType === 'box' && Num('emitterHeight', 'Height', 'px', 0)}
          </>
        )}
        {Num('birthRate', 'Birth Rate', '/s', 0)}
        {StaticNum('maxParticles', 'Max Particles', 1)}
        {Num('lifetime', 'Lifetime', 's', 0)}
        {Num('lifetimeRandom', 'Life Random', '', 0, 1)}

        {Num('speed', 'Speed', 'px/s')}
        {Num('speedRandom', 'Speed Random', '', 0, 1)}
        {Num('direction', 'Direction', '°')}
        {Num('spread', 'Spread', '°', 0, 360)}
        {Num('gravityX', 'Gravity X', 'px/s²')}
        {Num('gravityY', 'Gravity Y', 'px/s²')}
        {/* Wind is constant acceleration like gravity — a separate pair rather
            than "just add it to gravity" because wind is the thing you animate
            and zero out, and gravity is the thing you set once. */}
        {Num('windX', 'Wind X', 'px/s²')}
        {Num('windY', 'Wind Y', 'px/s²')}
        {/* One amplitude, two characters: ballistic mode wanders (closed-form,
            scrub-free), stateful mode swirls (real curl-noise force). Scale is
            stateful-only — the wander has no spatial field to scale. */}
        {Num('turbulence', 'Turbulence', cfg.simMode === 'stateful' ? 'px/s²' : 'px')}
        {cfg.simMode === 'stateful' && Num('turbulenceScale', 'Turb. Scale', 'px')}
        {Num('turbulenceSpeed', 'Turb. Speed', '×')}
        {Num('spin', 'Spin', '°/s')}

        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Shape</span>
          <select className={styles.select} style={{ width: 110 }} value={cfg.shape} onChange={(e) => set('shape', e.target.value as ParticleConfig['shape'])} aria-label="Particle shape">
            <option value="circle">Circle</option>
            <option value="square">Square</option>
            <option value="line">Line</option>
            <option value="star">Star</option>
          </select>
        </div>
        {Num('sizeStart', 'Size Birth', 'px', 0)}
        {Num('sizeEnd', 'Size Death', 'px', 0)}
        {Color('colorStart', 'Color Birth')}
        {Color('colorEnd', 'Color Death')}
        {Num('opacityStart', 'Opacity Birth', '', 0, 1)}
        {Num('opacityEnd', 'Opacity Death', '', 0, 1)}

        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Transfer</span>
          <select className={styles.select} style={{ width: 110 }} value={cfg.blend} onChange={(e) => set('blend', e.target.value as ParticleConfig['blend'])} aria-label="Transfer mode">
            <option value="add">Add (glow)</option>
            <option value="normal">Normal</option>
          </select>
        </div>
        {StaticNum('seed', 'Random Seed', 0)}

        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Sim</span>
          <select
            className={styles.select}
            style={{ width: 110 }}
            value={cfg.simMode ?? 'ballistic'}
            onChange={(e) => set('simMode', e.target.value as ParticleConfig['simMode'])}
            aria-label="Simulation mode"
          >
            <option value="ballistic">Ballistic</option>
            <option value="stateful">Stateful</option>
          </select>
        </div>
        {(cfg.simMode ?? 'ballistic') === 'stateful' && (
          <>
            <div className={styles.popoverRow}>
              <div style={{ width: 13 }} />
              <span className={styles.popoverLabel}>Floor Y</span>
              <ValueField
                value={cfg.bounceFloor ?? 160}
                onChange={(v) => set('bounceFloor', Number(v))}
                aria-label="Floor Y"
              />
            </div>
            <div className={styles.popoverRow}>
              <div style={{ width: 13 }} />
              <span className={styles.popoverLabel}>Bounce</span>
              <ValueField
                value={cfg.bounceRestitution ?? 0.65}
                min={0}
                max={1}
                onChange={(v) => set('bounceRestitution', Number(v))}
                aria-label="Bounce restitution"
              />
            </div>
            <div className={styles.popoverRow}>
              <div style={{ width: 13 }} />
              <span className={styles.popoverLabel}>Damping</span>
              <ValueField
                value={cfg.bounceDamping ?? 0.998}
                min={0}
                max={1}
                onChange={(v) => set('bounceDamping', Number(v))}
                aria-label="Air damping"
              />
            </div>
          </>
        )}

        <p style={{ margin: '6px 0 0', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
          {(cfg.simMode ?? 'ballistic') === 'stateful'
            ? 'Stateful emitter with floor bounce — scrubbing replays from snapshots, identical every time.'
            : 'Deterministic ballistic emitter — scrubbing is stable. Switch to Stateful for floor bounce.'}
          {' '}The layer transform moves the whole system.
        </p>
      </div>
    </div>
  );
}

export default ParticleSection;
