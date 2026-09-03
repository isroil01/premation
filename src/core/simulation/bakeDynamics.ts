/**
 * Bake dynamics to keyframes — turning a simulation into ordinary animation.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Rigid bodies and particles are LIVE SOLVE: `buildSnapshot` asks the solver
 * for a pose every frame and the answer is never written down. That is the
 * right default (it stays editable), and it is also the reason a simulation is
 * the one thing in this editor you cannot art-direct. You can change the
 * gravity; you cannot say "this box lands one frame later and half a pixel
 * left" — there is no keyframe to grab.
 *
 * Baking is the escape hatch every motion tool ships for exactly that: run the
 * sim once, write what it did as keyframes, switch the solver off. The
 * simulation becomes a starting point instead of a verdict.
 *
 * ── The one rule that makes a bake trustworthy ──────────────────────────────
 *
 * **The bake must play back identically to the viewport it replaced.** So this
 * file does NOT re-implement stepping. It calls `physicsPosesAt` — the same
 * function `buildSnapshot` calls, against the same `SimulationCache`, with the
 * same seeds, world and fps — once per sampled frame. If the bake and the
 * preview ever disagree, they disagree because the SEEDS differ, which is a
 * bug with one place to look, rather than because a second solver drifted.
 *
 * The particle bake follows the same discipline: `simulateParticles` for the
 * ballistic mode and `statefulParticleCache` for the stateful one, i.e. the
 * two entry points `particleSprites` itself uses.
 *
 * ── Linear, and hold at the end ─────────────────────────────────────────────
 *
 * Baked keys are frame-aligned samples of an already-curved motion, so they
 * interpolate LINEARLY — easing them again would ease the easing, exactly the
 * argument `set_spring`'s bake makes. The LAST key holds: a baked range that
 * ends before the composition does must not let the engine extrapolate the
 * final segment onward into motion the solver never produced.
 *
 * ── Undo ────────────────────────────────────────────────────────────────────
 *
 * A bake writes keyframes AND mutates the scene (it disables the component
 * that was driving the layer). Those are the two domains this app records
 * separately — `runAnimEdit` for tracks, the debounced snapshot store for the
 * scene — and left alone the pair produces two undo entries for one act. The
 * reconciliation is the one `TimelineController.splitLayerAtFrame` documents:
 * flush the pending snapshot, mutate inside `runRestoring` with the app history
 * suspended, then push ONE composite. See `commitBake`.
 */

import { defaultAnimation, type AnimSnapshot, type Keyframe } from '@motion/animation';
import { smoothTrackKeyframes } from '@core/animation/keyframeAssistants';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { StoreSnapshotCommand, useHistoryStore, type HistoryStore } from '@stores/historyStore';
import type { HistoryService } from '@core/commands/HistoryService';
import { sceneProjectIO } from '@core/scene/sceneProjectIO';
import { bumpScene } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { flattenComposition } from '@core/scene/sceneDerive';
import { enclosingCompRootOf } from '@core/scene/parenting';
import { activeCompRootId } from '@core/scene/activeComp';
import { useProjectStore } from '@stores/projectStore';
import { usePhysicsStore } from '@stores/physicsStore';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { makeNode } from '@core/scene/sceneInsert';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import {
  physicsPosesAt,
  readNodePhysics,
  readNodePhysicsRaw,
  PHYSICS_PROP,
} from './physicsBodies';
import type { BodySeed, PhysicsWorld } from './rigidBody';
import {
  readNodeParticle,
  resolveParticleConfig,
  simulateParticles,
  type Particle,
  type ParticleConfig,
} from '@core/particles/particleSim';
import { particlesFromSoA } from '@core/particles/statefulParticleSim';
import { statefulParticleCache } from '@core/particles/statefulParticleCache';
import type { ProjectFile, SceneNode } from '@core/types';

// ── Shared range / track plumbing ─────────────────────────────────────

export interface BakeRangeOptions {
  /** Range start, COMPOSITION seconds. */
  from: number;
  /** Range end, composition seconds (inclusive). */
  to: number;
  fps: number;
  /**
   * Sample every Nth frame. 1 = every frame (the faithful default). Larger
   * values thin the track by TIME, before any value-based simplification —
   * the two are different knobs and a caller may want either or both.
   */
  everyNFrames?: number;
  /**
   * Douglas-Peucker tolerance in value units (px for position, degrees for
   * rotation). 0 / omitted keeps every sample. Runs The Smoother's own
   * `smoothTrackKeyframes`, so a baked track thins by the same rule a hand-
   * authored one does.
   */
  simplifyTolerance?: number;
}

/** One baked scalar track. `t` is COMPOSITION seconds — the caller maps it
 *  onto the keyframe axis, because only the caller knows the node. */
export interface BakedTrack {
  nodeId: string;
  prop: string;
  keyframes: Keyframe[];
}

/**
 * The frames a bake samples.
 *
 * The END frame is always included even when it is not on the stride: the
 * last key is the one that holds, and a bake that stopped 3 frames short of
 * the range the user asked for would silently shorten the motion.
 */
export function bakeFrames(opts: BakeRangeOptions): number[] {
  const fps = opts.fps > 0 ? opts.fps : 30;
  const step = Math.max(1, Math.floor(opts.everyNFrames ?? 1));
  const f0 = Math.max(0, Math.round(opts.from * fps));
  const f1 = Math.max(f0, Math.round(opts.to * fps));
  const out: number[] = [];
  for (let f = f0; f <= f1; f += step) out.push(f);
  if (out[out.length - 1] !== f1) out.push(f1);
  return out;
}

/**
 * Samples → keyframes: simplify (optionally), then stamp interpolation.
 *
 * Easing is stamped AFTER simplification on purpose. `smoothTrackKeyframes`
 * hands back smoothed tangents — right for The Smoother, wrong here, where the
 * curve is already the motion and any added shape is invention.
 */
export function finishBakedTrack(
  samples: ReadonlyArray<{ t: number; value: number }>,
  tolerance = 0,
): Keyframe[] {
  if (samples.length === 0) return [];
  const raw: Keyframe[] = samples.map((s) => ({ t: s.t, value: s.value }));
  const thinned = tolerance > 0 ? smoothTrackKeyframes(raw, tolerance) : raw;
  return thinned.map((k, i) => ({
    t: k.t,
    value: k.value,
    easing: i === thinned.length - 1 ? ('hold' as const) : ('linear' as const),
  }));
}

// ── The one-undo-entry commit ─────────────────────────────────────────

interface DocState {
  scene: ProjectFile;
  anim: AnimSnapshot;
}

/** Both history mechanisms, or null in a headless context (tests, workers). */
function historyPair(): {
  history: HistoryService | null;
  store: Pick<HistoryStore, 'flush' | 'runRestoring'> | null;
} {
  let history: HistoryService | null = null;
  let store: Pick<HistoryStore, 'flush' | 'runRestoring'> | null = null;
  try {
    history = getCommandSystem().getHistory();
  } catch {
    history = null;
  }
  try {
    store = useHistoryStore.getState();
  } catch {
    store = null;
  }
  return { history, store };
}

function captureDoc(): DocState | null {
  try {
    return {
      scene: structuredClone(sceneProjectIO.capture()),
      anim: defaultAnimation.snapshot(),
    };
  } catch {
    // A document that cannot be captured is a document the bake cannot make
    // undoable — the mutation still happens, which is the honest trade: losing
    // the work is worse than losing one undo step.
    return null;
  }
}

/**
 * Apply `mutate` as ONE undo entry spanning scene + animation.
 *
 * `flush` commits whatever edit was mid-debounce so it keeps its own step;
 * `runRestoring` silences the auto-capture for the duration AND re-baselines it
 * afterwards, so the snapshot layer sees the post-bake document as the new
 * normal and has nothing left of its own to record.
 */
export function commitBake(label: string, mutate: () => void): void {
  const { history, store } = historyPair();
  store?.flush();
  const before = captureDoc();
  history?.suspend();
  try {
    if (store) store.runRestoring(mutate);
    else mutate();
  } finally {
    history?.resume();
  }
  const after = captureDoc();
  if (history && before && after) {
    history.push(new StoreSnapshotCommand(label, before, after));
  }
  bumpScene();
}

// ── Reading a layer's seed pose ───────────────────────────────────────

/** The Transform component's raw props (the AUTHORED pose the solver seeds from). */
function transformProps(node: SceneNode): Record<string, unknown> {
  for (const c of node.components) {
    if (c.type === 'Transform') return c.props as Record<string, unknown>;
  }
  return {};
}

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/**
 * Every body that shares the target's simulation, as the renderer seeds them.
 *
 * ALL of them, not just the ones being baked: bodies collide, so a seed list
 * missing the floor is a different history, and the bake would record a box
 * falling through a wall the viewport shows it landing on.
 */
export function collectPhysicsSeeds(rootId: string): BodySeed[] {
  const seeds: BodySeed[] = [];
  for (const node of flattenComposition(defaultSceneGraph, rootId)) {
    const cfg = readNodePhysics(node);
    if (!cfg) continue;
    const p = transformProps(node);
    seeds.push({
      id: node.id,
      x: num(p.x, node.transform.position.x),
      y: num(p.y, node.transform.position.y),
      rotation: num(p.rotation, node.transform.rotation),
      width: num(p.width, 100),
      height: num(p.height, 100),
      cfg,
    });
  }
  return seeds;
}

/** The world the renderer would simulate this composition in. */
export function physicsWorldFor(rootId: string): PhysicsWorld {
  const w = usePhysicsStore.getState();
  const comp = useProjectStore.getState().comps[rootId];
  return {
    gravityX: w.gravityX,
    gravityY: w.gravityY,
    bounds: w.useCompBounds
      ? { left: 0, top: 0, right: comp?.width ?? 1920, bottom: comp?.height ?? 1080 }
      : null,
    iterations: w.iterations,
  };
}

// ── Physics: sampling (pure, given seeds) ─────────────────────────────

/**
 * Step the shared solver over the range and read back each target's pose.
 *
 * Pure with respect to the scene: seeds and world come in, tracks come out,
 * with `t` in composition seconds. That is what makes the interesting half
 * testable without a scene graph, a timeline or a store.
 *
 * `rotation` appears only for bodies that opted into spin — `physicsPosesAt`
 * reports an angle only for those, and writing a constant 0 for the rest would
 * turn a rotation-lock into a rotation FREEZE, overwriting whatever the layer's
 * own rotation track was doing.
 */
export function samplePhysicsTracks(
  seeds: ReadonlyArray<BodySeed>,
  world: PhysicsWorld,
  targetIds: ReadonlyArray<string>,
  opts: BakeRangeOptions,
  compKey = 'bake',
): BakedTrack[] {
  const fps = opts.fps > 0 ? opts.fps : 30;
  const frames = bakeFrames({ ...opts, fps });
  const wanted = new Set(targetIds);

  const samples = new Map<string, { x: Array<{ t: number; value: number }>; y: Array<{ t: number; value: number }>; rotation: Array<{ t: number; value: number }> }>();
  for (const id of wanted) samples.set(id, { x: [], y: [], rotation: [] });

  for (const frame of frames) {
    const poses = physicsPosesAt(compKey, seeds, world, fps, frame);
    const t = frame / fps;
    for (const id of wanted) {
      const pose = poses.get(id);
      if (!pose) continue;
      const bucket = samples.get(id)!;
      bucket.x.push({ t, value: pose.x });
      bucket.y.push({ t, value: pose.y });
      if (pose.rotation !== undefined) bucket.rotation.push({ t, value: pose.rotation });
    }
  }

  const out: BakedTrack[] = [];
  for (const id of targetIds) {
    const bucket = samples.get(id);
    if (!bucket) continue;
    // x and y are SEPARATE scalar tracks in this engine — there is no combined
    // position property to write.
    for (const prop of ['x', 'y', 'rotation'] as const) {
      const list = bucket[prop];
      if (list.length === 0) continue;
      out.push({ nodeId: id, prop, keyframes: finishBakedTrack(list, opts.simplifyTolerance ?? 0) });
    }
  }
  return out;
}

// ── Physics: the scene-level action ───────────────────────────────────

export interface PhysicsBakeResult {
  /** Layers whose physics was baked and switched off. */
  nodeIds: string[];
  /** Frames sampled (before value simplification). */
  frames: number;
  /** Tracks written. */
  tracks: number;
  /** Keyframes written across all tracks. */
  keyframes: number;
}

/**
 * Bake the rigid-body simulation on `nodeIds` into keyframes and switch their
 * physics off, as one undo entry.
 *
 * Returns null when none of the ids carries an ENABLED dynamic body — a static
 * body has no simulated pose to bake (the renderer never overrides it), and
 * baking a disabled one would write the keyframes of a sim that is not running.
 */
export function bakePhysicsToKeyframes(
  nodeIds: ReadonlyArray<string>,
  opts: BakeRangeOptions,
): PhysicsBakeResult | null {
  const first = nodeIds[0];
  if (!first) return null;
  const rootId = enclosingCompRootOf(first) ?? activeCompRootId();

  const seeds = collectPhysicsSeeds(rootId);
  // Only DYNAMIC bodies get a simulated pose; `physicsPosesAt` deliberately
  // omits static ones, so asking for their tracks would silently produce none.
  const targets = nodeIds.filter((id) =>
    seeds.some((s) => s.id === id && s.cfg.kind === 'dynamic'),
  );
  if (targets.length === 0) return null;

  const world = physicsWorldFor(rootId);
  const tracks = samplePhysicsTracks(seeds, world, targets, opts, rootId);
  if (tracks.length === 0) return null;

  // Map composition time onto each node's keyframe axis BEFORE mutating: the
  // axis depends on clip geometry and layer time, and reading it after the
  // scene changed would be reading a different document than the one sampled.
  const placed = tracks.map((tr) => ({
    ...tr,
    keyframes: tr.keyframes.map((k) => ({ ...k, t: compToKeyframeTime(tr.nodeId, k.t, tr.prop) })),
  }));

  commitBake('Bake physics to keyframes', () => {
    defaultAnimation.batch(() => {
      for (const tr of placed) defaultAnimation.setKeyframes(tr.nodeId, tr.prop, tr.keyframes);
    });
    // Switch the solver off LAST. `readNodePhysics` returns null for a
    // disabled body, so from here the keyframes are the only thing moving the
    // layer — which is the whole point of a bake, and the reason it has to be
    // in the same undo entry as the keyframes that replaced it.
    for (const id of targets) {
      const node = defaultSceneGraph.getNode(id);
      if (!node) continue;
      defaultSceneGraph.setFxKey(id, PHYSICS_PROP, { ...readNodePhysicsRaw(node), enabled: false });
    }
  });

  return {
    nodeIds: [...targets],
    frames: bakeFrames(opts).length,
    tracks: placed.length,
    keyframes: placed.reduce((a, t) => a + t.keyframes.length, 0),
  };
}

// ── Particles ─────────────────────────────────────────────────────────

export interface ParticleBakeOptions extends BakeRangeOptions {
  /**
   * Hard cap on layers created. A particle field is routinely thousands of
   * particles and a layer each is a document nobody can open, let alone edit —
   * so the cap is a REFUSAL, not a truncation hint: the caller is told how many
   * there were and decides.
   */
  maxParticles?: number;
}

export const DEFAULT_PARTICLE_BAKE_CAP = 200;

/** One particle's whole life, as tracks in composition seconds. */
export interface BakedParticle {
  index: number;
  /** Base size in px the layer is built at; scale keys are relative to it. */
  baseSize: number;
  x: Array<{ t: number; value: number }>;
  y: Array<{ t: number; value: number }>;
  /** Layer scale multiplier (1 = `baseSize`). */
  scale: Array<{ t: number; value: number }>;
  /** Layer opacity, 0..100. */
  opacity: Array<{ t: number; value: number }>;
}

export interface ParticleSampleResult {
  particles: BakedParticle[];
  /** Distinct particles seen in the range, before the cap. */
  seen: number;
  /** True when `seen` exceeded the cap and the list was trimmed. */
  capped: boolean;
}

/**
 * All particles alive anywhere in the range, grouped by identity.
 *
 * Identity is `Particle.index` — the birth index, which is why that field
 * exists at all (see its docstring). Grouping by array position instead would
 * re-assign every particle to a different layer the moment one of them died.
 *
 * Which particles survive the cap: the EARLIEST-born ones, so a capped bake is
 * the front of the emission rather than an arbitrary slice. Sorting by index
 * also makes the layer order stable across re-bakes.
 */
export function sampleParticleLayers(
  configAt: (frame: number) => ParticleConfig,
  opts: ParticleBakeOptions,
  cacheKey = 'bake',
): ParticleSampleResult {
  const fps = opts.fps > 0 ? opts.fps : 30;
  const frames = bakeFrames({ ...opts, fps });
  const cap = Math.max(1, Math.floor(opts.maxParticles ?? DEFAULT_PARTICLE_BAKE_CAP));

  const byIndex = new Map<number, BakedParticle>();
  for (const frame of frames) {
    const cfg = configAt(frame);
    const t = frame / fps;
    for (const p of particlesAtFrame(cfg, frame, fps, cacheKey)) {
      if (p.index === undefined) continue;
      let rec = byIndex.get(p.index);
      if (!rec) {
        // The size at FIRST sighting is the layer's base size, so the layer is
        // built at the particle's real size and its scale track starts at 1.
        rec = { index: p.index, baseSize: Math.max(1, p.size), x: [], y: [], scale: [], opacity: [] };
        byIndex.set(p.index, rec);
      }
      rec.x.push({ t, value: p.x });
      rec.y.push({ t, value: p.y });
      rec.scale.push({ t, value: p.size / rec.baseSize });
      rec.opacity.push({ t, value: Math.max(0, Math.min(1, p.opacity)) * 100 });
    }
  }

  const all = [...byIndex.values()].sort((a, b) => a.index - b.index);
  return { particles: all.slice(0, cap), seen: all.length, capped: all.length > cap };
}

/** The renderer's own two entry points, chosen by sim mode — never a third. */
function particlesAtFrame(
  cfg: ParticleConfig,
  frame: number,
  fps: number,
  cacheKey: string,
): Particle[] {
  if (cfg.simMode === 'stateful') {
    const cache = statefulParticleCache(cacheKey, cfg, fps);
    const state = cache.stateAt(Math.max(0, frame));
    return particlesFromSoA(state, cfg, { frame, fps });
  }
  return simulateParticles(cfg, frame / fps);
}

export interface ParticleBakeResult {
  /** The null every baked particle is parented under. */
  containerId: string;
  /** Layers created, one per particle. */
  layerIds: string[];
  seen: number;
  capped: boolean;
  keyframes: number;
}

/**
 * Bake an emitter's particles into one layer each, parented under a new null,
 * and hide the emitter.
 *
 * ── Where the layers live ───────────────────────────────────────────────────
 *
 * The container null is parented to the EMITTER, at local (0, 0). Particle
 * positions are emitter-local px with the emitter at the field's centre (see
 * `particleSprites`), so a child of the emitter at (px, py) lands exactly where
 * the sprite was — including when the emitter layer is itself animated, which
 * a container copied into comp space would not follow.
 *
 * The emitter keeps its config and its transform; only `visible` goes false, so
 * the rig stays intact, the bake stays re-runnable, and un-hiding one layer is
 * the whole undo of "disable the emitter's rendering".
 *
 * Returns null when the layer is not an emitter or the range contains no
 * particles at all.
 */
export function bakeParticlesToLayers(
  emitterNodeId: string,
  opts: ParticleBakeOptions,
): ParticleBakeResult | null {
  const emitter = defaultSceneGraph.getNode(emitterNodeId);
  if (!emitter) return null;
  const stored = readNodeParticle(emitter);
  if (!stored) return null;

  const p = transformProps(emitter);
  const emitterW = num(p.width, stored.emitterWidth);
  const emitterH = num(p.height, stored.emitterHeight);

  // The config the RENDERER would use at each frame: emitter box synced to the
  // layer's geometry, then every `particle.<key>` track sampled — the same two
  // steps `buildSnapshot` performs before handing the config to the sim.
  const configAt = (frame: number): ParticleConfig => {
    const t = compToKeyframeTime(emitterNodeId, frame / (opts.fps > 0 ? opts.fps : 30));
    return resolveParticleConfig(
      { ...stored, emitterWidth: emitterW, emitterHeight: emitterH },
      (path) => defaultAnimation.sample(emitterNodeId, path, t),
    );
  };

  const sampled = sampleParticleLayers(configAt, opts, emitterNodeId);
  if (sampled.particles.length === 0) return null;

  const tol = opts.simplifyTolerance ?? 0;
  const layerIds: string[] = [];
  let containerId = '';
  let keyframes = 0;

  commitBake('Bake particles to layers', () => {
    const container = makeNode('null', `${emitter.name ?? 'Emitter'} Baked`);
    const ct = transformProps(container);
    ct.x = 0;
    ct.y = 0;
    container.transform.position = { x: 0, y: 0 };
    defaultSceneGraph.addChild(emitterNodeId, container);
    containerId = container.id;

    defaultAnimation.batch(() => {
      for (const part of sampled.particles) {
        const node = makeNode('shape', `Particle ${part.index}`);
        const props = transformProps(node);
        props.x = 0;
        props.y = 0;
        props.width = part.baseSize;
        props.height = part.baseSize;
        props[SCENE_KIND_PROP] = 'shape';
        // A round particle is the only shape the emitter can draw that a
        // rectangle would misread at a glance; the rest are close enough that
        // guessing per-shape geometry would be inventing detail the bake does
        // not have.
        props.shapeType = stored.shape === 'square' ? 'rect' : 'ellipse';
        node.transform.position = { x: 0, y: 0 };
        // Fill from the config's START colour, written onto the Style component
        // BEFORE the node joins the graph — `readBase` reads `fill` there, and
        // that is the property the shape actually paints with.
        //
        // The start colour and not the ramp: the per-frame colour ramp is a
        // property of the emitter's renderer, and animating a fill per particle
        // would be a colour track per baked layer for a gradient nobody asked
        // to keyframe.
        for (const c of node.components) {
          if (c.type === 'Style') (c.props as Record<string, unknown>).fill = stored.colorStart;
        }
        defaultSceneGraph.addChild(container.id, node);

        const write = (prop: string, list: BakedParticle['x'], holdBefore: number | null): void => {
          const kfs = finishBakedTrack(list, tol);
          if (kfs.length === 0) return;
          // A particle exists for part of the range only. Without a zero-
          // opacity hold on either side the layer would sit frozen at its
          // birth pose for every frame before it was born.
          const framed = holdBefore === null
            ? kfs
            : padLife(kfs, holdBefore, opts);
          defaultAnimation.setKeyframes(
            node.id,
            prop,
            framed.map((k) => ({ ...k, t: compToKeyframeTime(node.id, k.t, prop) })),
          );
          keyframes += framed.length;
        };
        write('x', part.x, null);
        write('y', part.y, null);
        write('scaleX', part.scale, null);
        write('scaleY', part.scale, null);
        write('opacity', part.opacity, 0);

        layerIds.push(node.id);
      }
    });

    // The emitter stops drawing; it stays as the rig the container hangs from.
    // Re-read rather than reusing the view captured before the mutation —
    // `visible` writes through the engine node, and the node the graph holds is
    // the one that has to change.
    const live = defaultSceneGraph.getNode(emitterNodeId);
    if (live) live.visible = false;
  });

  return {
    containerId,
    layerIds,
    seen: sampled.seen,
    capped: sampled.capped,
    keyframes,
  };
}

/**
 * Bracket a track with `value` one frame outside its own span, held.
 *
 * Only meaningful for opacity, which is why it is applied there alone: a
 * particle that is born at frame 40 must be INVISIBLE at 39, not merely
 * un-animated, and the engine clamps a track to its first key before it.
 */
function padLife(kfs: Keyframe[], value: number, opts: BakeRangeOptions): Keyframe[] {
  const fps = opts.fps > 0 ? opts.fps : 30;
  const dt = 1 / fps;
  const first = kfs[0]!;
  const last = kfs[kfs.length - 1]!;
  const out: Keyframe[] = [];
  if (first.t - dt >= 0) out.push({ t: first.t - dt, value, easing: 'hold' });
  out.push(...kfs);
  out.push({ t: last.t + dt, value, easing: 'hold' });
  return out;
}
