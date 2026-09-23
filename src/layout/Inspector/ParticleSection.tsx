/**
 * ParticleSection — controls for a particle emitter. The whole config is one
 * object on the layer's `fx` component. Through the engine API (B3z):
 *
 *   • every keyframeable number is the property `layer/particle.<key>`
 *     (particleProps.ts) — a typed value / scrub sets its static value, or keys
 *     it at the playhead when animated (auto-keyframe as elsewhere); the
 *     stopwatch is `setAnimated`; a scrub is ONE gesture;
 *   • the colours are `layer/particle.<colour>` colour properties (ColorKfRow);
 *   • every other setting (emitter type, shape, sim mode, trails, sub-emit,
 *     caps, seed…) is the json field `layer/particle`: the whole next config.
 */

import { useState } from 'react';
import { ValueField } from '@components/ValueField';
import { AnimToggle } from './AnimToggle';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeParticle, DEFAULT_PARTICLE_CONFIG, particlePropPath, type ParticleConfig, type ParticleNumericKey } from '@core/particles/particleSim';
import { defaultAnimation } from '@motion/animation';
import { keyAxisTimeForDisplay } from '@core/engine/displayTime';
import { edit } from '@core/engine/uiEdits';
import { useActiveWorkspace } from '@stores/projectStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useAssetStore } from '@stores/assetStore';
import { useAnimationRevision } from '@hooks/useAnimationRevision';
import { ColorKfRow } from './ColorKfRow';
import { useEngineEdit } from './useEngineEdit';
import { useGesture } from '@hooks/useGesture';
import { jsonFieldCommands } from './layerFieldEdits';
import { stopwatchCommands, valueCommands } from './inspectorEdits';
// Same registration-by-import as PhysicsSection: loading this module is what
// puts `dynamics.bakeParticles` in the command registry.
import { runParticleBake } from '@core/simulation/bakeCommands';
import { BakeDialog } from './BakeDialog';
import styles from './TransformSection.module.css';

export function ParticleSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  useAnimationRevision();
  const time = useActiveWorkspace()?.time ?? 0;
  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);
  const eng = useEngineEdit();
  const picking = useGesture();
  const [bakeOpen, setBakeOpen] = useState(false);
  // Image assets for the sprite picker — a hook, so it sits above the early return.
  const imageAssets = useAssetStore((s) => s.assets).filter((a) => a.type === 'image');
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const cfg = readNodeParticle(node) ?? DEFAULT_PARTICLE_CONFIG;
  // DISPLAY only: where to sample an animated param for the playhead (the
  // layer's keyframe axis). Writes send comp time; the engine converts.
  const layerT = keyAxisTimeForDisplay(nodeId, time);

  /**
   * A non-keyframeable setting: the json field `layer/particle` with that key
   * changed (the whole config, as the editor always stored it). Inside a scrub
   * it goes into the open gesture.
   */
  const set = <K extends keyof ParticleConfig>(key: K, value: ParticleConfig[K], label = 'Edit Particle Emitter'): void => {
    eng.send(label, jsonFieldCommands(nodeId, 'layer/particle', { ...cfg, [key]: value }));
  };
  const scrub = eng.scrub('Edit Particle Emitter');

  const Num = (key: ParticleNumericKey, label: string, unit = '', min?: number, max?: number): JSX.Element => {
    const prop = particlePropPath(key);
    const animated = defaultAnimation.isAnimated(nodeId, prop);
    const shown = animated
      ? defaultAnimation.sample(nodeId, prop, layerT) ?? (cfg[key] as number)
      : (cfg[key] as number);
    const toggle = (): void => {
      void edit(animated ? `Remove ${label} animation` : `Animate ${label}`, stopwatchCommands([nodeId], [prop], time));
    };
    // `layer/particle.<key>` (a key at the playhead when animated or under
    // auto-keyframe, else the static value). The emitter box mirrors the
    // layer's Width / Height: a static emitter size writes both in ONE entry.
    const write = (v: number): void => {
      const values: Record<string, number> = { [prop]: v };
      if (!animated && key === 'emitterWidth') values.width = v;
      if (!animated && key === 'emitterHeight') values.height = v;
      eng.send(`Set ${label}`, valueCommands([{ nodeId, values }], { seconds: time, autoKeyframe }));
    };
    return (
      <div className={styles.popoverRow}>
        <AnimToggle nodeId={nodeId} tracks={[prop]} label={label} animated={animated} onToggle={toggle} values={() => [shown]} />
        <span className={styles.popoverLabel}>{label}</span>
        <ValueField
          value={shown}
          unit={unit}
          {...(min !== undefined ? { min } : {})}
          {...(max !== undefined ? { max } : {})}
          {...eng.scrub(`Set ${label}`)}
          onChange={(v) => write(Number(v))}
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
        {...scrub}
        onChange={(v) => set(key, Number(v) as ParticleConfig[typeof key])}
        aria-label={label}
      />
    </div>
  );

  const Color = (key: 'colorStart' | 'colorEnd' | 'colorMid', label: string): JSX.Element => (
    <ColorKfRow
      nodeId={nodeId}
      propPrefix={particlePropPath(key)}
      label={label}
      value={cfg[key] ?? cfg.colorStart}
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
            <option value="sphere">Sphere</option>
          </select>
        </div>
        {cfg.emitterType !== 'point' && (
          <>
            {Num('emitterWidth', cfg.emitterType === 'circle' || cfg.emitterType === 'sphere' ? 'Diameter' : 'Width', 'px', 0)}
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
        {/* Linear drag, folded into the closed form exactly — scrubs free. */}
        {Num('drag', 'Drag', '/s', 0)}
        {/* Velocity streaks: a fraction of the comp shutter, applied only when
            this layer's motion-blur switch is on (buildSnapshot hands the
            shutter to the field). */}
        {Num('motionBlur', 'Motion Blur', '', 0, 1)}
        {/* One amplitude, two characters: ballistic mode wanders (closed-form,
            scrub-free), stateful mode swirls (real curl-noise force). Scale is
            stateful-only — the wander has no spatial field to scale. */}
        {Num('turbulence', 'Turbulence', cfg.simMode === 'stateful' ? 'px/s²' : 'px')}
        {/* Depth axis — simulated always, PROJECTED only when Perspective is
            on, so flipping perspective changes the look, never the motion. */}
        {Num('emitterDepth', 'Depth', 'px')}
        {Num('speedZ', 'Speed Z', 'px/s')}
        {Num('perspective', 'Perspective', 'px')}
        {/* Collisions and sub-emit are plain rows like the bounce params —
            both shape the stateful HISTORY, and their toggles/selects have no
            meaningful in-between to keyframe anyway. */}
        {cfg.simMode === 'stateful' && (
          <div className={styles.popoverRow}>
            <div style={{ width: 13 }} />
            <span className={styles.popoverLabel}>Collide</span>
            <input
              type="checkbox"
              checked={cfg.collide ?? false}
              onChange={(e) => set('collide', e.target.checked)}
              aria-label="Particle collisions"
            />
          </div>
        )}
        <div className={styles.popoverRow}>
          <div style={{ width: 13 }} />
          <span className={styles.popoverLabel}>Sub-Emit</span>
          <select
            className={styles.select}
            style={{ width: 110 }}
            value={cfg.subEmit ?? 'off'}
            onChange={(e) => set('subEmit', e.target.value as ParticleConfig['subEmit'])}
            aria-label="Sub-emitter trigger"
          >
            <option value="off">Off</option>
            <option value="death">On Death</option>
            {/* A bounce is history — the closed-form emitter has none;
                continuous shedding is a closed form and so ballistic-only. */}
            {cfg.simMode === 'stateful' && <option value="bounce">On Bounce</option>}
            {cfg.simMode !== 'stateful' && <option value="continuous">Continuous</option>}
          </select>
        </div>
        {cfg.subEmit === 'continuous' && Num('subRate', 'Sub Rate', '/s', 0)}
        {(cfg.subEmit ?? 'off') !== 'off' && (
          <>
            {cfg.subEmit !== 'continuous' && (
              <div className={styles.popoverRow}>
                <div style={{ width: 13 }} />
                <span className={styles.popoverLabel}>Burst</span>
                <ValueField value={cfg.subCount ?? 8} min={0} max={16} precision={0} {...scrub} onChange={(v) => set('subCount', Number(v))} aria-label="Children per burst" />
              </div>
            )}
            <div className={styles.popoverRow}>
              <div style={{ width: 13 }} />
              <span className={styles.popoverLabel}>Burst Speed</span>
              <ValueField value={cfg.subSpeed ?? 120} min={0} precision={0} unit="px/s" {...scrub} onChange={(v) => set('subSpeed', Number(v))} aria-label="Child speed" />
            </div>
            <div className={styles.popoverRow}>
              <div style={{ width: 13 }} />
              <span className={styles.popoverLabel}>Burst Life</span>
              <ValueField value={cfg.subLifetime ?? 0.6} min={0.05} precision={2} unit="s" {...scrub} onChange={(v) => set('subLifetime', Number(v))} aria-label="Child lifetime" />
            </div>
          </>
        )}
        {/* Trails are plain rows, not Num rows, on purpose: Num makes a param
            KEYFRAMEABLE, and in stateful mode the trail ring is part of the
            state shape — animating its length would rebuild the sim on every
            frame of the ramp. Same reasoning as the bounce params above. */}
        <div className={styles.popoverRow}>
          <div style={{ width: 13 }} />
          <span className={styles.popoverLabel}>Trail</span>
          <ValueField
            value={cfg.trailLength ?? 0}
            min={0}
            max={24}
            precision={0}
            {...scrub}
            onChange={(v) => set('trailLength', Number(v))}
            aria-label="Trail points"
          />
        </div>
        {(cfg.trailLength ?? 0) > 0 && (
          <div className={styles.popoverRow}>
            <div style={{ width: 13 }} />
            <span className={styles.popoverLabel}>Trail Gap</span>
            <ValueField
              value={cfg.trailSpacing ?? 1 / 30}
              min={1 / 240}
              precision={3}
              unit="s"
              {...scrub}
              onChange={(v) => set('trailSpacing', Number(v))}
              aria-label="Trail spacing seconds"
            />
          </div>
        )}
        {cfg.simMode === 'stateful' && Num('turbulenceScale', 'Turb. Scale', 'px')}
        {Num('turbulenceSpeed', 'Turb. Speed', '×')}
        {Num('spin', 'Spin', '°/s')}
        {/* Plexus over the live particles: 0 distance = off. */}
        {Num('plexusDistance', 'Plexus Dist.', 'px', 0)}
        {(cfg.plexusDistance ?? 0) > 0 && (
          <>
            {Num('plexusWidth', 'Plexus Width', 'px', 0)}
            {Num('plexusOpacity', 'Plexus Opacity', '', 0, 1)}
            <div className={styles.popoverRow}>
              <div style={{ width: 13 }} />
              <span className={styles.popoverLabel}>Plexus Color</span>
              <input
                type="color"
                value={cfg.plexusColor ?? DEFAULT_PARTICLE_CONFIG.plexusColor}
                // The OS picker fires on every move: one gesture until it closes (blur).
                onChange={(e) => {
                  if (!picking.isActive()) picking.begin('Set Plexus Color');
                  picking.send(jsonFieldCommands(nodeId, 'layer/particle', { ...cfg, plexusColor: e.target.value }));
                }}
                onBlur={() => { void picking.end(); }}
                aria-label="Plexus line colour"
              />
            </div>
            <div className={styles.popoverRow}>
              <div style={{ width: 13 }} />
              <span className={styles.popoverLabel}>Triangles</span>
              <input
                type="checkbox"
                checked={cfg.plexusTriangles ?? false}
                onChange={(e) => set('plexusTriangles', e.target.checked)}
                aria-label="Plexus triangles"
              />
            </div>
            {cfg.plexusTriangles && Num('plexusTriangleOpacity', 'Tri. Opacity', '', 0, 1)}
          </>
        )}

        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Shape</span>
          <select className={styles.select} style={{ width: 110 }} value={cfg.shape} onChange={(e) => set('shape', e.target.value as ParticleConfig['shape'])} aria-label="Particle shape">
            <option value="circle">Circle</option>
            <option value="square">Square</option>
            <option value="line">Line</option>
            <option value="star">Star</option>
            <option value="sprite">Sprite (image)</option>
          </select>
        </div>
        {cfg.shape === 'sprite' && (
          <>
            <div className={styles.popoverRow}>
              <div style={{ width: 13 }} />
              <span className={styles.popoverLabel}>Image</span>
              <select
                className={styles.select}
                style={{ width: 110 }}
                value={cfg.spriteAssetId ?? ''}
                onChange={(e) => set('spriteAssetId', e.target.value)}
                aria-label="Sprite image asset"
              >
                <option value="">(none — circles)</option>
                {imageAssets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div className={styles.popoverRow}>
              <div style={{ width: 13 }} />
              <span className={styles.popoverLabel}>Sheet Frames</span>
              <ValueField value={cfg.spriteFrames ?? 1} min={1} max={256} precision={0} {...scrub} onChange={(v) => set('spriteFrames', Number(v))} aria-label="Sprite sheet frames" />
            </div>
            {(cfg.spriteFrames ?? 1) > 1 && (
              <div className={styles.popoverRow}>
                <div style={{ width: 13 }} />
                <span className={styles.popoverLabel}>Sheet FPS</span>
                <ValueField value={cfg.spriteFps ?? 0} min={0} max={120} precision={0} unit="fps" {...scrub} onChange={(v) => set('spriteFps', Number(v))} aria-label="Sprite sheet frames per second (0 = by age)" />
              </div>
            )}
          </>
        )}
        {Num('sizeStart', 'Size Birth', 'px', 0)}
        {/* The mid-point rows: unset until touched, so old systems keep their
            straight two-point ramps byte for byte. */}
        {Num('sizeMid', 'Size Mid', 'px', 0)}
        {Num('sizeEnd', 'Size Death', 'px', 0)}
        {Num('midAge', 'Mid Age', '', 0.01, 0.99)}
        {Color('colorStart', 'Color Birth')}
        {Color('colorMid', 'Color Mid')}
        {Color('colorEnd', 'Color Death')}
        {Num('opacityStart', 'Opacity Birth', '', 0, 1)}
        {Num('opacityMid', 'Opacity Mid', '', 0, 1)}
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
                {...scrub}
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
                {...scrub}
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
                {...scrub}
                onChange={(v) => set('bounceDamping', Number(v))}
                aria-label="Air damping"
              />
            </div>
          </>
        )}

        {/* Bake: one layer per particle. A refusal above the cap rather than a
            silent trim — see `bakeParticlesToLayers`. */}
        <div className={styles.popoverRow}>
          <div style={{ width: 13 }} />
          <span className={styles.popoverLabel}>Bake</span>
          <button
            type="button"
            className={styles.select}
            style={{ width: 110, textAlign: 'left', cursor: 'pointer' }}
            onClick={() => setBakeOpen(true)}
            title="Convert each particle into its own keyframed layer and hide the emitter"
          >
            Bake to keyframes…
          </button>
        </div>

        {bakeOpen && (
          <BakeDialog
            open
            onClose={() => setBakeOpen(false)}
            title="Bake Particles to Layers"
            withParticleCap
            onBake={(opts) => runParticleBake(nodeId, opts)}
          />
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
