/**
 * EMIT + VALIDATE — the deterministic half of the pipeline.
 *
 * Takes a sequence plus a casting and produces `ToolCall[]`, then runs all three
 * linters over the result and repairs what it can without asking anyone.
 *
 * ## The repair pass is deterministic on purpose
 *
 * "Add an overshoot", "widen that stagger", "tighten the tracking" are not
 * judgements — they are corrections with exactly one right answer, and sending
 * them to a model costs a turn and sometimes gets them wrong. So a linter error
 * triggers a **re-emit with corrected parameters**, in code. The only thing left
 * for an LLM is "does this serve the brief", which is the one question here it can
 * actually answer.
 *
 * ## Order matters
 *
 * Layout composes first and motion second, always. Motion animates a design; a
 * technique cast against nothing has no targets, and a technique cast against
 * primitives encodes the assumption that what is being moved is a rectangle.
 *
 * Pure.
 */

import {
  composeContext,
  designScore as computeDesignScore,
  COMPOSITION_BACKDROP_ID,
  deviceFor,
  emitCompositionBackdrop,
  emitDepth,
  emitTypeMask,
  layoutTemplate,
  lintDesign,
  resolvePack,
  type ComposeResult,
  type LintLayer,
  type LintScene,
  type ResolvedPack,
  type SlotRole,
  type ToolCall,
} from '@motion/design-system';
import {
  CURVES,
  coerceParams,
  compositionShutter,
  craftScore as computeCraftScore,
  lintTiming,
  staggerAt,
  technique,
  track,
  tracksFromCalls,
  type AnimatableRole,
  type EmitContext,
} from '@motion/technique-library';
import { PRODUCT_TECHNIQUES, lintUiMotion, uiMotionScore as computeUiScore } from '@motion/product-motion';
import { GENERATED_MEDIA } from './types';
import type { CastMetrics, CastReport, Casting, Sequence } from './types';

const PRODUCT_BY_ID = new Map(PRODUCT_TECHNIQUES.map((t) => [t.id, t]));

/** Editorial library first, then the product library. Ids never collide. */
function anyTechnique(id: string) {
  return technique(id) ?? PRODUCT_BY_ID.get(id);
}

export interface EmitOptions {
  sequence: Sequence;
  casting: Casting;
  lookPackId: string;
  accent?: string;
  mode?: 'dark' | 'light';
  width: number;
  height: number;
  fps: number;
  /**
   * Cap on repair rounds.
   *
   * Two, not five. Each round is deterministic, so a problem that survives two
   * corrections is not going to yield to a third — it is a technique/layout
   * mismatch the caster should be told about rather than ground down.
   */
  maxRepairs?: number;
}

interface EmitPass {
  calls: ToolCall[];
  /** Per-beat layout results, for role → layer id resolution. */
  layouts: Map<number, ComposeResult>;
  /** Which ids came from a library technique, for `techniqueCoverage`. */
  techniqueLayerIds: Set<string>;
  /** Layer ids belonging to the product vocabulary. */
  uiLayerIds: Set<string>;
  /** Ids exempt from the UI travel limit. */
  offFrameLayerIds: Set<string>;
  heroLayerIds: Set<string>;
  /** Ids created by the composition's graphic device. See `LintLayer.isAmbient`. */
  ambientLayerIds: Set<string>;
  instances: { id: string; startMs: number; durationMs: number; minDurationMs?: number; neverWith?: readonly string[] }[];
  surfaces: Record<string, string>;
}

/**
 * Techniques whose elements legitimately move further than the UI limit.
 *
 * A sheet rising from below the screen edge, a list flinging under a finger, an
 * indicator travelling the distance the layout put between two tabs. None is
 * in-place UI motion, and capping them at 24px would break all three.
 */
const OFF_FRAME_TECHNIQUES = new Set(['ui.sheet_present', 'ui.momentum_scroll', 'ui.tab_switch']);

/** Roles that count as hero content for the overshoot rule. */
const HERO_ROLES: readonly SlotRole[] = ['headline', 'mark', 'stat', 'quote'];

/**
 * Back-to-front z order for a beat's roles.
 *
 * Imagery is the furthest thing away and the headline is nearest the viewer.
 * That is both the physical reading and the one that keeps type sharp: a layer
 * pushed away from the camera is scaled up to compensate, and doing that to
 * text is how a headline goes soft under a camera push.
 */
const DEPTH_ORDER: readonly SlotRole[] = ['media', 'rule', 'mark', 'support', 'subhead', 'overline', 'stat', 'list', 'quote', 'cta', 'headline'];

/**
 * Backdrop gradient angles, indexed by the first layout's seed.
 *
 * A constant angle would make the largest area in the frame identical across
 * every piece a pack ever produces — the kind of invariant that reads as a
 * template even when everything in front of it varies.
 */
const BACKDROP_ANGLES = [100, 115, 145, 75, 165, 200, 285, 15] as const;

/** An opacity this close to zero counts as "already hidden". */
const HIDDEN_EPS = 1;

/**
 * Most generated images one composition may contain.
 *
 * A hard cap in code, not a request in the prompt. The brief prompt asks the
 * model to reserve art direction for the beats that carry the piece, and a model
 * asked "would five stock photographs in a five-beat piece be lazy?" says yes
 * and then art-directs all five. Every other composition-wide guard in this
 * pipeline — per-technique caps, clash rules, energy ceilings — is enforced here
 * for the same reason.
 *
 * Two is also the editorial answer independently of cost: a piece with an image
 * on every beat is a slideshow of pictures, and the contrast between a beat that
 * has one and a beat that is pure type is itself a compositional device.
 */
const MAX_GENERATED_IMAGES = 2;

function emitPass(o: EmitOptions, pack: ResolvedPack, repairs: readonly string[]): EmitPass {
  const pass: EmitPass = {
    calls: [],
    layouts: new Map(),
    techniqueLayerIds: new Set(),
    uiLayerIds: new Set(),
    offFrameLayerIds: new Set(),
    heroLayerIds: new Set(),
    ambientLayerIds: new Set(),
    instances: [],
    surfaces: {},
  };

  // ── Composition-level shutter, once ─────────────────────────────────────
  // Per-layer motion blur is only an opt-in switch; the shutter that decides
  // whether a fast move reads as rendered lives on the composition. Emitting it
  // per technique would be N redundant calls that fight each other.
  const shutterCtx: EmitContext = {
    startMs: 0, durationMs: o.sequence.totalDurationMs, frameMs: 1000 / o.fps,
    width: o.width, height: o.height, pack, targets: {}, idPrefix: 'comp',
  };
  pass.calls.push(...compositionShutter(shutterCtx));

  // ── ONE backdrop, before any beat ───────────────────────────────────────
  // Paint order is creation order, so a template that emits its own full-frame
  // gradient inside a multi-beat piece covers every beat composed before it.
  // Emitting the backdrop here — first, once — is what makes a five-beat piece
  // render as five beats rather than as the last beat over a stack of opaque
  // gradients.
  //
  // The angle comes from the first layout's seed rather than a constant: the
  // backdrop is the largest single area in the frame, and a fixed angle across
  // every piece in a pack is exactly the kind of invariant that reads as a
  // template.
  const backdropSeed = o.casting.layouts[0]?.seed ?? 0;
  const backdropCtx = composeContext(pack, o.width, o.height, {
    durationMs: o.sequence.totalDurationMs,
    idPrefix: 'comp',
  });
  pass.calls.push(
    ...emitCompositionBackdrop(backdropCtx, {
      angle: BACKDROP_ANGLES[backdropSeed % BACKDROP_ANGLES.length]!,
      ...(backdropSeed % 5 === 0 ? { kind: 'radial' as const } : {}),
    }).calls,
  );

  // ── ONE graphic device, above the backdrop and behind everything else ────
  // The same leverage as the backdrop: attaching this here reaches every
  // composition without editing forty templates, and it is what puts a curve, a
  // diagonal or a repeated mark into a frame whose every other element is an
  // axis-aligned rectangle. `deviceFor` returns nothing for the product
  // vocabularies, so a dashboard stays a dashboard.
  const device = deviceFor(pack, backdropSeed + o.sequence.beats.length);
  if (device) {
    const deviceCalls = device.emit(
      { pack, grid: backdropCtx.grid, width: o.width, height: o.height, idPrefix: 'comp' },
      backdropSeed * 31 + 7,
    );
    pass.calls.push(...deviceCalls);
    for (const c of deviceCalls) {
      const id = c.args.id;
      if (typeof id === 'string') pass.ambientLayerIds.add(id);
    }
  }

  // Which beats may actually spend an image, decided ONCE for the whole
  // composition. Longest beats win: a beat holds the frame in proportion to its
  // duration, so that is where a picture earns its cost. Ties break on index so
  // the choice is deterministic and a re-emit during repair cannot drift.
  const imageBeats = new Set(
    [...o.sequence.beats]
      .filter((b) => b.art)
      .sort((a, b) => b.durationMs - a.durationMs || a.index - b.index)
      .slice(0, MAX_GENERATED_IMAGES)
      .map((b) => b.index),
  );

  // ── Layout first, motion second ─────────────────────────────────────────
  for (const beat of o.sequence.beats) {
    const cast = o.casting.layouts.find((l) => l.beatIndex === beat.index);
    if (!cast) continue;
    const template = layoutTemplate(cast.templateId);
    if (!template) continue;

    const ctx = composeContext(pack, o.width, o.height, {
      startMs: beat.startMs,
      durationMs: beat.durationMs,
      // Per-beat prefix, so two beats using the same template cannot collide on
      // layer ids — the class of bug where beat 2's `update_layer` silently
      // retargets beat 1's headline.
      idPrefix: `b${beat.index}`,
      hasCompositionBackdrop: true,
    });
    const result = template.compose(ctx, beat.content, cast.seed);
    pass.calls.push(...withGeneratedMedia(result.calls, beat, pack, imageBeats.has(beat.index)));
    pass.layouts.set(beat.index, result);
    Object.assign(pass.surfaces, result.surfaces ?? {});

    for (const role of HERO_ROLES) {
      for (const id of result.slots[role] ?? []) pass.heroLayerIds.add(id);
    }

    // ── Stage the beat ────────────────────────────────────────────────────
    // Depth first. A camera technique cast onto a beat whose every layer sits at
    // z=0 produces a move with no parallax — the frame slides as one plane,
    // which reads as a slide transition rather than a camera. The library has
    // shipped `camera.push_in_slow` and `camera.drift_parallax` all along with
    // nothing arranged for them to work on.
    //
    // Back-to-front order is media → support → headline: imagery is the
    // furthest thing away and the headline is closest to the viewer, which is
    // both the physical reading and the one that keeps type sharp under a push.
    // …unless a camera technique cast on this beat owns the depth. Those
    // techniques write their own z TRACK on their targets with their own role
    // scheme and spread, and a track beats a static prop — so emitting both
    // leaves one beat carrying two disagreeing depth systems, and whichever
    // layers the technique did not claim keep the other one.
    const cameraOwnsDepth = o.casting.motion.some(
      (m) => m.beatIndex === beat.index && anyTechnique(m.techniqueId)?.category === 'camera',
    );
    const depthOrder = DEPTH_ORDER.flatMap((role) => result.slots[role] ?? []);
    if (depthOrder.length >= 2 && !cameraOwnsDepth) {
      pass.calls.push(...emitDepth(ctx, depthOrder));
    }

    // A mask on the headline, so a technique can uncover it rather than fade it.
    // Emitted at rest; the technique animates the type underneath.
    for (const id of result.slots.headline ?? []) {
      pass.calls.push(...emitTypeMask(ctx, id));
    }
  }

  // ── Motion ──────────────────────────────────────────────────────────────
  for (const cast of o.casting.motion) {
    const beat = o.sequence.beats.find((b) => b.index === cast.beatIndex);
    const def = anyTechnique(cast.techniqueId);
    const layout = pass.layouts.get(cast.beatIndex);
    if (!beat || !def || !layout) continue;

    // Only the roles the technique DECLARES and the layout actually produced.
    // This is the constrained match: casting motion onto a layout is a bounded
    // choice rather than free invention.
    const targets: EmitContext['targets'] = {};
    for (const role of def.roles) {
      const ids = layout.slots[role as SlotRole];
      if (ids?.length) targets[role as AnimatableRole] = ids;
    }
    // The composition's backdrop is a real layer at a known id, created before
    // any beat — so a technique that animates `background` has something to
    // animate. No layout produces a background slot (templates discard the ids
    // `emitBackdrop` hands back), which is why this has to be supplied here.
    if (def.roles.includes('background')) {
      targets.background = [COMPOSITION_BACKDROP_ID];
    }
    if (!Object.keys(targets).length) continue;

    const params = coerceParams(def.params, applyRepairs(cast.params, cast.techniqueId, repairs));
    const ctx: EmitContext = {
      startMs: beat.startMs,
      durationMs: beat.durationMs,
      frameMs: 1000 / o.fps,
      width: o.width,
      height: o.height,
      pack,
      targets,
      idPrefix: `b${beat.index}_${cast.techniqueId.replace(/\W/g, '_')}`,
    };
    const calls = def.emit(ctx, params.value, cast.seed);
    pass.calls.push(...calls);

    for (const ids of Object.values(targets)) {
      for (const id of ids ?? []) {
        pass.techniqueLayerIds.add(id);
        if (PRODUCT_BY_ID.has(cast.techniqueId)) pass.uiLayerIds.add(id);
        if (OFF_FRAME_TECHNIQUES.has(cast.techniqueId)) pass.offFrameLayerIds.add(id);
      }
    }
    pass.instances.push({
      id: def.id,
      startMs: beat.startMs,
      durationMs: beat.durationMs,
      minDurationMs: def.minDurationMs,
      ...(def.antipatterns.neverWith ? { neverWith: def.antipatterns.neverWith } : {}),
    });
  }

  // ── Lifecycle, last ─────────────────────────────────────────────────────
  pass.calls.push(...beatLifecycle(o, pack, pass));

  return pass;
}

/**
 * Give every beat's content a beginning and an end.
 *
 * The renderer has no per-layer time range — a layer is visible whenever
 * `visible !== false`, and the only lever on "is this on screen right now" is
 * its opacity track. So without this pass a five-beat piece is cumulative:
 * beat 0's headline is still sitting there while beat 4 plays over it, because
 * the technique cast on beat 0 animated it IN and nothing ever animated it out.
 *
 * Two rules, both deterministic:
 *
 *  • **Entrance.** A layer belonging to a beat that starts after t=0 and
 *    carrying no opacity track of its own is pinned to 0 until its beat. The
 *    engine holds the first keyframe's value backwards, so a layer whose
 *    technique already fades it in needs nothing here.
 *  • **Exit.** A layer whose beat has a successor leaves at the boundary,
 *    unless a technique already took it out.
 *
 * ## Where `survival` finally does something
 *
 * The sequencer computes a survivor for every boundary, validates that one
 * exists, and — until now — nothing read it. Here it selects the exit SHAPE:
 * the surviving role cross-dissolves ACROSS the boundary, overlapping its
 * counterpart in the next beat, while everything else is gone before the cut.
 * That overlap is the difference between a cut the eye tracks through and five
 * unrelated cards.
 */
function beatLifecycle(o: EmitOptions, pack: ResolvedPack, pass: EmitPass): ToolCall[] {
  const out: ToolCall[] = [];
  const frameMs = 1000 / o.fps;
  // Bounded: on a fast pack the fade must not eat the beat it belongs to, and on
  // a slow one a 760ms dissolve on a supporting element is a smear.
  const packFadeMs = Math.max(160, Math.min(420, Math.round(pack.pack.pacing.baseBeatMs * 0.55)));
  /**
   * The floor on an exit's length.
   *
   * Without it a beat whose technique animates opacity nearly to its own end
   * leaves no room, the exit collapses toward a single frame, and 100 → 0 inside
   * one frame is a POP — which is precisely the defect the timing linter exists
   * to catch, introduced by the pass meant to improve the piece.
   */
  const minExitMs = Math.max(120, Math.round(frameMs * 4));

  // What the techniques already did, so this pass never fights them.
  const opacity = new Map<string, { last: number; lastValue: number }>();
  for (const t of tracksFromCalls(pass.calls)) {
    if (t.prop !== 'opacity' || !t.keys.length) continue;
    const last = t.keys[t.keys.length - 1]!;
    opacity.set(t.nodeId, { last: last.t, lastValue: last.value });
  }

  // Static opacity a template set deliberately — `emitMedia`'s placeholder sits
  // at 82. Fading such a layer to 100 would override a design decision with a
  // default, so the entrance targets what the template asked for.
  const staticOpacity = new Map<string, number>();
  for (const c of pass.calls) {
    if (c.name !== 'update_layer') continue;
    const id = String(c.args.nodeId ?? '');
    if (id && c.args.opacity !== undefined) staticOpacity.set(id, Number(c.args.opacity));
  }

  for (const b of o.sequence.beats) {
    const layout = pass.layouts.get(b.index);
    if (!layout) continue;

    const endMs = b.startMs + b.durationMs;
    const isLast = endMs >= o.sequence.totalDurationMs - 1;
    const survivingRole = b.survival?.role;
    // Scaled to THIS beat, not just to the pack. A pack fade of 286ms inside a
    // 700ms beat leaves no room for an entrance, a hold and an exit — and the
    // hold is the part that makes content readable.
    const fadeMs = Math.max(120, Math.min(packFadeMs, Math.round(b.durationMs * 0.28)));

    // Flatten the beat's layers ONCE, in template order, so both stagger runs
    // below index into the same stable sequence.
    const members: { id: string; survives: boolean }[] = [];
    for (const [role, ids] of Object.entries(layout.slots)) {
      for (const id of ids ?? []) members.push({ id, survives: role === survivingRole });
    }

    const ctx: EmitContext = {
      startMs: b.startMs, durationMs: b.durationMs, frameMs: 1000 / o.fps,
      width: o.width, height: o.height, pack, targets: {}, idPrefix: `b${b.index}_life`,
    };

    // ── Entrances ───────────────────────────────────────────────────────
    // Only for layers nothing else established one for. A technique that
    // animates position but not opacity leaves its layer fully visible from
    // frame 0, sitting in the frame through every beat before its own.
    //
    // No keyframe at t=0: the engine holds the first keyframe's value backwards,
    // so one at `startMs` already hides the layer for the whole run-up. Adding
    // the t=0 key changes nothing visually and makes every such layer report an
    // entry time of 0 to the timing linter — which then, correctly by its own
    // logic, calls a five-element beat five elements entering at once.
    const entering = members.filter((m) => !opacity.has(m.id) && b.startMs > 0);
    entering.forEach((m, i) => {
      const at = b.startMs + staggerAt(ctx, i, entering.length, Math.round(fadeMs * 1.4));
      out.push(
        track(m.id, 'opacity', [
          { t: at, value: 0, bezier: CURVES.settle },
          { t: at + fadeMs, value: staticOpacity.get(m.id) ?? 100, bezier: CURVES.settle },
        ]),
      );
      // Keep the map authoritative: a layer that just gained an entrance must
      // not also be treated as "no opacity track" by the exit pass below.
      opacity.set(m.id, { last: at + fadeMs, lastValue: staticOpacity.get(m.id) ?? 100 });
    });

    // ── Exits ───────────────────────────────────────────────────────────
    // The last beat holds to the end of the piece; a composition that fades
    // everything out before its final frame ends on an empty frame.
    if (isLast) continue;

    const leaving = members.filter((m) => {
      const e = opacity.get(m.id);
      // A technique already took it out.
      return !e || e.lastValue > HIDDEN_EPS;
    });
    const exitSpan = Math.round(fadeMs * 0.6);

    leaving.forEach((m, i) => {
      const e = opacity.get(m.id);
      // A survivor overlaps the boundary; everything else has cleared it. The
      // overlap is capped at the next beat's own length so a short beat is never
      // spent entirely under an outgoing element.
      const nextMs = o.sequence.beats[b.index + 1]?.durationMs ?? 0;
      const overlap = m.survives ? Math.min(fadeMs, Math.round(nextMs * 0.5)) : 0;
      const outEnd = endMs + overlap;
      // Stagger the departures too. Everything leaving on the same frame is the
      // same defect as everything arriving on it, and the boundary is where it
      // is most visible.
      const base = outEnd - fadeMs - exitSpan;
      const outStart = Math.min(
        Math.max(
          // Prefer not to start the exit before the entrance has finished, or
          // the two tracks describe a layer that leaves while it is arriving.
          e ? e.last : b.startMs,
          base + staggerAt(ctx, i, leaving.length, exitSpan),
        ),
        // …but the exit's minimum length wins over that preference. Overlapping
        // the tail of a long entrance reads as a quick in-and-out; a one-frame
        // exit reads as a glitch.
        outEnd - minExitMs,
      );
      if (outEnd <= outStart || outStart < b.startMs) return;

      out.push(
        track(m.id, 'opacity', [
          // Start from where the layer actually is, not from an assumed 100 —
          // a technique whose opacity track settles at 55 would otherwise get a
          // jump to 100 on the frame its exit begins.
          { t: outStart, value: e?.lastValue ?? staticOpacity.get(m.id) ?? 100, bezier: CURVES.exit },
          { t: outEnd, value: 0, bezier: CURVES.exit },
        ]),
      );
    });
  }

  return out;
}

/**
 * Turn a template's placeholder media into a real generated picture.
 *
 * The template already emitted `create_media { id, assetId, x, y }` followed by
 * `update_layer { nodeId: id, width, height }`. Rewriting the FIRST call in
 * place — same `id`, same position — is what makes this cost nothing elsewhere:
 * `slots.media` already names that id, the sizing call already targets it, and a
 * technique cast against the media role already animates it. Forty templates
 * stay untouched, and none of them has to know that imagery exists.
 *
 * Only calls carrying the sentinel are rewritten. A beat holding a real asset id
 * from the user's library still places that asset — generating a picture over
 * imagery someone supplied would be both wrong and billable.
 */
function withGeneratedMedia(
  calls: readonly ToolCall[],
  beat: Sequence['beats'][number],
  pack: ResolvedPack,
  allowed: boolean,
): ToolCall[] {
  // Over the composition's image budget: fall back to the template's own
  // placeholder panel rather than emitting a `create_media` for an asset id that
  // does not exist. The layout still balances — a hole where the media was is
  // worse than a deliberate panel, which is why `emitMedia` has that branch.
  if (!beat.art || !allowed) {
    return calls.flatMap((c) =>
      c.name === 'create_media' && c.args.assetId === GENERATED_MEDIA
        ? [{ name: 'create_layer', args: { id: c.args.id, kind: 'shape', shape: 'rect', name: 'Media', x: c.args.x, y: c.args.y } },
           { name: 'update_layer', args: { nodeId: c.args.id, fill: pack.palette.surface, opacity: 82 } }]
        : [c],
    );
  }

  return calls.map((c) => {
    if (c.name !== 'create_media' || c.args.assetId !== GENERATED_MEDIA) return c;
    const id = String(c.args.id ?? '');
    // The paired sizing call is the only place the slot's shape is known, and
    // the aspect has to match it or the image arrives letterboxed inside its own
    // frame.
    const sizing = calls.find(
      (s) => s.name === 'update_layer' && s.args.nodeId === id && s.args.width !== undefined,
    );
    const w = Number(sizing?.args.width ?? 0);
    const h = Number(sizing?.args.height ?? 0);
    const aspect = !w || !h ? 'landscape' : w / h > 1.2 ? 'landscape' : h / w > 1.2 ? 'portrait' : 'square';

    return {
      name: 'generate_image',
      args: {
        id,
        // The pack's own language is appended to the model's subject. A look
        // pack already decides the palette, the surface and the shape
        // vocabulary for everything else in the frame; an image generated
        // without them is the one element that does not belong to the piece.
        prompt: `${beat.art}. ${artDirectionFor(pack)}`,
        aspect,
        x: c.args.x,
        y: c.args.y,
      },
    };
  });
}

/** The look pack, restated as image-generation direction. */
function artDirectionFor(pack: ResolvedPack): string {
  const p = pack.pack;
  const surface =
    p.surfaceStyle === 'film' ? 'shot on film, visible grain, soft halation'
    : p.surfaceStyle === 'print' ? 'flat printed litho texture, no lens effects'
    : p.surfaceStyle === 'crt' ? 'CRT phosphor glow, scanlines, heavy chromatic fringing'
    : p.surfaceStyle === 'screen' ? 'clean digital capture, faint screen glow'
    : 'clean studio capture, softbox lighting';
  return (
    `${p.intent} ${surface}. Dominant colour ${pack.palette.accent} against ` +
    `${pack.palette.bg}; ${p.mode} key. Composition must leave room for type — ` +
    `no lettering, no watermark, no logo, no user interface in the image.`
  );
}

/**
 * The deterministic repair table.
 *
 * Each entry is a linter rule and the parameter change that fixes it. These are
 * corrections, not judgements — which is why they run in code rather than costing
 * a model turn. A rule with no entry here is one that cannot be fixed by
 * re-parameterising, and the caster reports it instead.
 */
const REPAIRS: Record<string, (params: Record<string, unknown>) => Record<string, unknown>> = {
  // A stagger too tight for the elements it has: widen the span.
  SIMULTANEOUS_ENTRY: (p) => ({ ...p, spanMs: Math.round(Number(p.spanMs ?? 400) * 1.8) }),
  // A metronome: widen the span so the pack's curve has room to bend.
  UNIFORM_STAGGER: (p) => ({ ...p, spanMs: Math.round(Number(p.spanMs ?? 400) * 1.5) }),
  // Too fast to read: the technique was given a slot it cannot fill.
  SUB_MINIMUM_DURATION: (p) => p,
  // UI travel over budget: halve it.
  UI_TRAVEL_TOO_FAR: (p) => ({
    ...p,
    ...(p.travelPx !== undefined ? { travelPx: Math.round(Number(p.travelPx) / 2) } : {}),
    ...(p.distancePx !== undefined ? { distancePx: Math.round(Number(p.distancePx) / 2) } : {}),
  }),
  // A UI stagger past the 60ms ceiling.
  UI_STAGGER_TOO_WIDE: (p) => ({ ...p, staggerMs: 35 }),
};

function applyRepairs(
  params: Record<string, unknown>,
  techniqueId: string,
  repairs: readonly string[],
): Record<string, unknown> {
  let out = params;
  for (const entry of repairs) {
    const [id, rule] = entry.split('::');
    if (id !== techniqueId) continue;
    const fix = rule && REPAIRS[rule];
    if (fix) out = fix(out);
  }
  return out;
}

/** Reduce a call batch to the flat scene description the design linter reads. */
export function sceneFromCalls(
  calls: readonly ToolCall[],
  frame: { width: number; height: number },
  surfaces: Record<string, string>,
  ambientIds: ReadonlySet<string> = new Set(),
  /** Layer id → the set of co-visible layers it belongs to. See `LintLayer.group`. */
  groupOf: ReadonlyMap<string, string> = new Map(),
): LintLayer[] {
  const byId = new Map<string, LintLayer>();
  for (const c of calls) {
    const a = c.args;
    switch (c.name) {
      case 'create_layer': {
        const id = String(a.id ?? '');
        if (!id) break;
        byId.set(id, {
          id,
          name: String(a.name ?? id),
          kind: String(a.kind ?? 'shape'),
          x: Number(a.x ?? 0),
          y: Number(a.y ?? 0),
          ...(a.width !== undefined ? { width: Number(a.width) } : {}),
          ...(a.height !== undefined ? { height: Number(a.height) } : {}),
          ...(a.fill !== undefined ? { fill: String(a.fill) } : {}),
          // Carried so `RECT_ONLY` can tell a box from an arc. Dropping it here
          // was what made that rule unwritable in the first place.
          ...(a.shape !== undefined ? { shape: String(a.shape) } : {}),
          effects: [],
        });
        break;
      }
      case 'add_repeater': {
        const l = byId.get(String(a.nodeId ?? ''));
        if (l) l.hasRepeater = true;
        break;
      }
      case 'import_svg': {
        // A hand-written vector is an asset in every sense the linter cares
        // about: it is not a rectangle and it did not come from the shape
        // primitives.
        const id = String(a.id ?? '__svg');
        byId.set(id, {
          id, name: String(a.name ?? 'Vector'), kind: 'svg',
          x: Number(a.x ?? 0), y: Number(a.y ?? 0), isAsset: true, effects: [],
        });
        break;
      }
      case 'create_gradient': {
        const id = String(a.id ?? '__gradient');
        byId.set(id, {
          id, name: String(a.name ?? 'Gradient'), kind: 'solid',
          x: frame.width / 2, y: frame.height / 2, width: frame.width, height: frame.height,
          fill: Array.isArray(a.stops) ? String((a.stops as string[])[0]) : undefined,
          hasGradient: true, effects: ['gradient-ramp'],
        });
        break;
      }
      case 'add_surface_treatment': {
        const id = String(a.id ?? '__surface');
        byId.set(id, {
          id, name: 'Surface', kind: 'adjustment',
          x: frame.width / 2, y: frame.height / 2, width: frame.width, height: frame.height,
          isTreatment: true, effects: ['noise'],
        });
        break;
      }
      case 'create_media':
      case 'generate_image': {
        const id = String(a.id ?? '__media');
        // Both are assets as far as the design linter is concerned, and that is
        // the whole point of `PRIMITIVE_ONLY`: it asks whether anything in the
        // frame is a picture rather than a drawn rectangle. A generated image is
        // as much a picture as an imported one — omitting this case would leave
        // the rule firing on exactly the output that fixed it.
        byId.set(id, {
          id, name: 'Media', kind: 'image',
          x: Number(a.x ?? 0), y: Number(a.y ?? 0), isAsset: true, effects: [],
        });
        break;
      }
      case 'update_layer': {
        const l = byId.get(String(a.nodeId ?? ''));
        if (!l) break;
        if (a.fill !== undefined) l.fill = String(a.fill);
        if (a.width !== undefined) l.width = Number(a.width);
        if (a.height !== undefined) l.height = Number(a.height);
        if (a.fontSize !== undefined) l.fontSizePx = Number(a.fontSize);
        if (a.fontWeight !== undefined) l.fontWeight = Number(a.fontWeight);
        if (a.letterSpacing !== undefined) l.letterSpacingPx = Number(a.letterSpacing);
        if (a.cornerRadius !== undefined) l.cornerRadius = Number(a.cornerRadius);
        if (a.align !== undefined) l.align = String(a.align);
        if (a.backdropBlur !== undefined) l.effects = [...(l.effects ?? []), 'backdrop-blur'];
        break;
      }
      case 'add_effect': {
        const l = byId.get(String(a.nodeId ?? ''));
        if (l) l.effects = [...(l.effects ?? []), String(a.type ?? '')];
        break;
      }
      case 'set_shadow_stack': {
        const l = byId.get(String(a.nodeId ?? ''));
        if (l) l.shadowCount = Array.isArray(a.shadows) ? a.shadows.length : 0;
        break;
      }
      default:
        break;
    }
  }
  for (const [id, fill] of Object.entries(surfaces)) {
    const l = byId.get(id);
    if (l) l.onSurface = fill;
  }
  for (const id of ambientIds) {
    const l = byId.get(id);
    if (l) l.isAmbient = true;
  }
  for (const [id, group] of groupOf) {
    const l = byId.get(id);
    if (l) l.group = group;
  }
  return [...byId.values()];
}

function metricsFor(pass: EmitPass, casting: Casting, beats: number): CastMetrics {
  const layerCount = new Set(
    pass.calls.filter((c) => c.name === 'create_layer').map((c) => String(c.args.id ?? '')),
  ).size;
  const techniqueIds = casting.motion.map((m) => m.techniqueId);
  const templateIds = casting.layouts.map((l) => l.templateId);
  const seeds = [...casting.motion.map((m) => m.seed), ...casting.layouts.map((l) => l.seed)];

  return {
    techniqueCoverage: layerCount > 0 ? pass.techniqueLayerIds.size / layerCount : 0,
    techniqueDiversity: techniqueIds.length ? new Set(techniqueIds).size / techniqueIds.length : 0,
    templateDiversity: beats > 0 ? new Set(templateIds).size / Math.max(1, templateIds.length) : 0,
    // Distinct seeds over total. Catches "always variant 0", which is how a
    // library with 20 techniques still produces 20 identical pieces.
    variantEntropy: seeds.length ? new Set(seeds).size / seeds.length : 0,
  };
}

/**
 * Run the pipeline's deterministic half: emit, lint, repair, re-emit.
 *
 * Returns the calls plus a report carrying every finding and every metric, so the
 * caller never has to re-derive them.
 */
export function emitAndValidate(o: EmitOptions): { calls: ToolCall[]; report: CastReport } {
  const pack = resolvePack(o.lookPackId, {
    ...(o.accent ? { accent: o.accent } : {}),
    ...(o.mode ? { mode: o.mode } : {}),
  });
  const maxRepairs = o.maxRepairs ?? 2;

  const repairs: string[] = [];
  let pass = emitPass(o, pack, repairs);
  let findings = lintAll(pass, o, pack);

  for (let round = 0; round < maxRepairs; round++) {
    const fixable = findings.filter((f) => f.severity === 'error' && f.rule in REPAIRS);
    if (!fixable.length) break;

    // Attribute each fixable error to the technique instance whose parameters can
    // change it. Without the attribution a repair would re-parameterise every
    // technique in the piece to fix one.
    let added = false;
    for (const f of fixable) {
      for (const inst of pass.instances) {
        const entry = `${inst.id}::${f.rule}`;
        if (!repairs.includes(entry)) {
          repairs.push(entry);
          added = true;
        }
      }
    }
    if (!added) break;

    pass = emitPass(o, pack, repairs);
    findings = lintAll(pass, o, pack);
  }

  const design = findings.filter((f) => f.source === 'design');
  const timing = findings.filter((f) => f.source === 'timing');
  const ui = findings.filter((f) => f.source === 'ui');

  return {
    calls: pass.calls,
    report: {
      lookPackId: o.lookPackId,
      beats: o.sequence.beats.length,
      techniques: o.casting.motion.map((m) => m.techniqueId),
      templates: o.casting.layouts.map((l) => l.templateId),
      seeds: [...o.casting.layouts.map((l) => l.seed), ...o.casting.motion.map((m) => m.seed)],
      metrics: metricsFor(pass, o.casting, o.sequence.beats.length),
      findings,
      designScore: computeDesignScore(design.map((f) => ({ rule: f.rule as never, severity: f.severity, nodeIds: [], message: f.message }))),
      craftScore: computeCraftScore(timing.map((f) => ({ rule: f.rule as never, severity: f.severity, nodeIds: [], message: f.message }))),
      uiMotionScore: computeUiScore(ui.map((f) => ({ rule: f.rule as never, severity: f.severity, nodeIds: [], message: f.message }))),
      repairs,
    },
  };
}

type Finding = CastReport['findings'][number];

/** All three linters, merged. */
function lintAll(pass: EmitPass, o: EmitOptions, pack: ResolvedPack): Finding[] {
  const out: Finding[] = [];
  // Every beat is its own set of co-visible layers. Without this the type ladder
  // spans the whole timeline — see `LintLayer.group`.
  const groupOf = new Map<string, string>();
  for (const [beatIndex, layout] of pass.layouts) {
    for (const ids of Object.values(layout.slots)) {
      for (const id of ids ?? []) groupOf.set(id, `b${beatIndex}`);
    }
  }
  const layers = sceneFromCalls(
    pass.calls, { width: o.width, height: o.height }, pass.surfaces, pass.ambientLayerIds, groupOf,
  );

  const designScene: LintScene = {
    grid: composeContext(pack, o.width, o.height).grid,
    background: pack.palette.bg,
    accent: pack.palette.accent,
    layers,
  };
  for (const f of lintDesign(designScene)) {
    out.push({ source: 'design', rule: f.rule, severity: f.severity, message: f.message });
  }

  for (const f of lintTiming({
    calls: pass.calls,
    fps: o.fps,
    durationMs: o.sequence.totalDurationMs,
    instances: pass.instances,
    beatBoundaries: o.sequence.boundaries,
    heroNodeIds: [...pass.heroLayerIds],
    uiNodeIds: [...pass.uiLayerIds],
  })) {
    out.push({ source: 'timing', rule: f.rule, severity: f.severity, message: f.message });
  }

  // The UI linter only runs when there IS product-vocabulary content. Running it
  // on a purely editorial piece would report correct editorial craft as a defect.
  if (pass.uiLayerIds.size) {
    for (const f of lintUiMotion({
      calls: pass.calls,
      fps: o.fps,
      uiNodeIds: [...pass.uiLayerIds],
      offFrameNodeIds: [...pass.offFrameLayerIds],
    })) {
      out.push({ source: 'ui', rule: f.rule, severity: f.severity, message: f.message });
    }
  }

  return out;
}
