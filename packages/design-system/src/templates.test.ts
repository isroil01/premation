/**
 * The acceptance test for Phase 2B.
 *
 * Criterion 2b says the design linter must pass with **zero errors on 100% of
 * output**, with no LLM in the loop. The only way that is true by construction
 * rather than by luck is if every authored template, in every pack it declares,
 * at every variant seed, is clean. So that is exactly what this runs — the full
 * cross product.
 *
 * When a template fails here the answer is never to relax the linter. The linter
 * encodes the reason the output looked generated; a template that trips it is a
 * template that would have produced generated-looking output.
 */

import { LAYOUT_TEMPLATES, candidates, layoutTemplate, layoutTemplateIds, templatesForPack } from './registry';
import { composeContext, type SlotContent } from './compose';
import { LOOK_PACKS, lookPack, resolvePack } from './packs';
import { lintDesign, designScore, type LintLayer, type LintScene } from './lint';
import { isPureBlackOrWhite } from './color';
import { isDisplaySize } from './type';
import type { ToolCall } from './toolcall';

const FRAME = { width: 1920, height: 1080 };

/** Content rich enough to fill every slot any template declares. */
const CONTENT: SlotContent = {
  overline: 'Introducing',
  headline: 'Build the thing you actually meant to build',
  subhead: 'A short supporting sentence that explains the promise without overselling it.',
  support: 'Trusted by teams who ship every day and cannot afford a rewrite.',
  quote: 'It replaced three tools and a standing meeting.',
  attribution: 'Dana Okafor, Head of Platform',
  cta: 'Start free',
  items: [
    { value: '4.2×', label: 'Faster builds', title: 'Faster builds', body: 'Incremental everywhere, cached across machines.' },
    { value: '99.99%', label: 'Uptime', title: 'Always on', body: 'Multi-region by default with automatic failover.' },
    { value: '12k', label: 'Teams', title: 'Proven', body: 'From two-person startups to public companies.' },
  ],
  mediaAssetId: 'asset_hero_01',
};

/**
 * Reconstruct the scene the linter sees from the emitted calls.
 *
 * This is the same reduction the caster performs before execution, which is the
 * point: the linter runs on `ToolCall[]`, so a defect is caught *before* anything
 * touches the document rather than after.
 */
function sceneFromCalls(
  calls: readonly ToolCall[],
  scene: Omit<LintScene, 'layers'>,
  surfaces: Record<string, string> = {},
): LintScene {
  const byId = new Map<string, LintLayer>();

  for (const c of calls) {
    const a = c.args;
    switch (c.name) {
      case 'create_layer': {
        const id = String(a.id ?? '');
        byId.set(id, {
          id,
          name: String(a.name ?? id),
          kind: String(a.kind ?? 'shape'),
          x: Number(a.x ?? 0),
          y: Number(a.y ?? 0),
          ...(a.width !== undefined ? { width: Number(a.width) } : {}),
          ...(a.height !== undefined ? { height: Number(a.height) } : {}),
          ...(a.fill !== undefined ? { fill: String(a.fill) } : {}),
          effects: [],
        });
        break;
      }
      case 'create_gradient': {
        // A gradient backdrop is full-frame by construction and carries a
        // gradient — which is what keeps it out of FLAT_FILL.
        const gid = String(a.id ?? '__gradient');
        byId.set(gid, {
          id: gid,
          name: String(a.name ?? 'Gradient'),
          kind: 'solid',
          x: scene.grid.width / 2,
          y: scene.grid.height / 2,
          width: scene.grid.width,
          height: scene.grid.height,
          fill: Array.isArray(a.stops) ? String((a.stops as string[])[0]) : undefined,
          hasGradient: true,
          effects: ['gradient-ramp'],
        });
        break;
      }
      case 'add_surface_treatment': {
        const sid = String(a.id ?? '__surface');
        byId.set(sid, {
          id: sid,
          name: 'Surface',
          kind: 'adjustment',
          x: scene.grid.width / 2,
          y: scene.grid.height / 2,
          width: scene.grid.width,
          height: scene.grid.height,
          isTreatment: true,
          effects: ['noise'],
        });
        break;
      }
      case 'create_media': {
        // The `id` handle is what a later update_layer in the same batch targets.
        const mid = String(a.id ?? '__media');
        byId.set(mid, {
          id: mid,
          name: 'Media',
          kind: 'image',
          x: Number(a.x ?? 0),
          y: Number(a.y ?? 0),
          isAsset: true,
          effects: [],
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
      case 'set_shadow_stack': {
        const l = byId.get(String(a.nodeId ?? ''));
        if (l) l.shadowCount = Array.isArray(a.shadows) ? a.shadows.length : 0;
        break;
      }
      default:
        break;
    }
  }
  // Text on a button or a card is measured against THAT surface, not the frame.
  for (const [layerId, fill] of Object.entries(surfaces)) {
    const l = byId.get(layerId);
    if (l) l.onSurface = fill;
  }
  return { ...scene, layers: [...byId.values()] };
}

/** Every (template, pack, seed) the library can produce. */
function* everyComposition(): Generator<{ templateId: string; packId: string; seed: number }> {
  for (const t of LAYOUT_TEMPLATES) {
    for (const packId of t.packs) {
      for (let seed = 0; seed < t.variants; seed++) {
        yield { templateId: t.id, packId, seed };
      }
    }
  }
}

function compose(templateId: string, packId: string, seed: number) {
  const t = layoutTemplate(templateId)!;
  const pack = resolvePack(packId);
  const ctx = composeContext(pack, FRAME.width, FRAME.height, { idPrefix: `t${seed}` });
  const result = t.compose(ctx, CONTENT, seed);
  const scene = sceneFromCalls(result.calls, {
    grid: ctx.grid,
    background: pack.palette.bg,
    accent: pack.palette.accent,
    negativeSpaceTarget: t.negativeSpaceRatio,
  }, result.surfaces ?? {});
  return { t, pack, ctx, result, scene };
}

describe('every template × every pack × every variant', () => {
  const all = [...everyComposition()];

  it('covers a meaningful number of compositions', () => {
    // If this drops, a template lost its pack list and the sweep below silently
    // stopped testing it.
    expect(all.length).toBeGreaterThanOrEqual(60);
  });

  it('passes the design linter with ZERO errors', () => {
    const failures: string[] = [];
    for (const c of all) {
      const { scene } = compose(c.templateId, c.packId, c.seed);
      const errors = lintDesign(scene).filter((f) => f.severity === 'error');
      if (errors.length) {
        failures.push(
          `${c.templateId} / ${c.packId} / seed ${c.seed}: ` +
          errors.map((e) => `${e.rule} (${e.nodeIds.join(',') || 'scene'})`).join('; '),
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it('never emits pure black or pure white', () => {
    for (const c of all) {
      const { scene } = compose(c.templateId, c.packId, c.seed);
      for (const l of scene.layers) {
        if (l.fill) {
          expect(`${c.templateId}/${l.id}: ${l.fill}`).toBe(
            isPureBlackOrWhite(l.fill) ? '(never pure black/white)' : `${c.templateId}/${l.id}: ${l.fill}`,
          );
        }
      }
    }
  });

  it('always tracks display-size type', () => {
    // DEFAULT_TRACKING as a standalone assertion: it is the single biggest
    // "looks typeset" lever, and a template that emits create_layer directly
    // instead of going through emitText would silently lose it.
    for (const c of all) {
      const { scene } = compose(c.templateId, c.packId, c.seed);
      for (const l of scene.layers) {
        if (l.fontSizePx !== undefined && isDisplaySize(l.fontSizePx)) {
          expect(Math.abs(l.letterSpacingPx ?? 0)).toBeGreaterThan(0.5);
        }
      }
    }
  });

  it('never emits a single-layer shadow', () => {
    for (const c of all) {
      const { scene } = compose(c.templateId, c.packId, c.seed);
      for (const l of scene.layers) {
        if (l.shadowCount !== undefined) expect(l.shadowCount).not.toBe(1);
      }
    }
  });

  it('scores well on the design linter overall', () => {
    for (const c of all) {
      const { scene } = compose(c.templateId, c.packId, c.seed);
      expect(designScore(lintDesign(scene))).toBeGreaterThan(0.8);
    }
  });
});

describe('determinism', () => {
  it('same template + same seed → byte-identical calls', () => {
    for (const t of LAYOUT_TEMPLATES) {
      const packId = t.packs[0]!;
      const a = compose(t.id, packId, 1).result.calls;
      const b = compose(t.id, packId, 1).result.calls;
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it('different seeds produce genuinely different output', () => {
    // The reason variants exist. A template whose seeds all produce the same
    // calls is a template with one variant that claims several.
    for (const t of LAYOUT_TEMPLATES) {
      if (t.variants < 2) continue;
      const packId = t.packs[0]!;
      const outputs = new Set<string>();
      for (let s = 0; s < t.variants; s++) {
        outputs.add(JSON.stringify(compose(t.id, packId, s).result.calls));
      }
      expect(outputs.size).toBeGreaterThan(1);
    }
  });
});

describe('slots', () => {
  it('fills every REQUIRED slot it declares', () => {
    for (const t of LAYOUT_TEMPLATES) {
      const { result } = compose(t.id, t.packs[0]!, 0);
      for (const slot of t.slots) {
        if (!slot.required) continue;
        expect(`${t.id}.${slot.role}`).toBe(
          (result.slots[slot.role]?.length ?? 0) > 0 ? `${t.id}.${slot.role}` : `${t.id}.${slot.role} MISSING`,
        );
      }
    }
  });

  it('produces ids that are unique within one composition', () => {
    // Two layers sharing an id means the second update_layer silently retargets
    // the first — a class of bug that looks like "the style didn't apply".
    for (const t of LAYOUT_TEMPLATES) {
      const { result } = compose(t.id, t.packs[0]!, 0);
      const created = result.calls
        .filter((c) => c.name === 'create_layer')
        .map((c) => String(c.args.id));
      expect(new Set(created).size).toBe(created.length);
    }
  });
});

describe('candidate query', () => {
  it('only offers templates the pack allows', () => {
    for (const pack of LOOK_PACKS) {
      for (const c of candidates({ packId: pack.id, content: CONTENT })) {
        expect(c.template.packs).toContain(pack.id);
        expect(pack.forbid).not.toContain(c.template.id);
      }
    }
  });

  it('never offers a template whose required slots cannot be filled', () => {
    // `split_asymmetric` needs media; with no asset it must not be offered, or it
    // would render a half-empty frame.
    const noMedia: SlotContent = { headline: 'Only a headline' };
    for (const c of candidates({ packId: 'swiss_editorial', content: noMedia })) {
      for (const slot of c.template.slots) {
        if (slot.required) {
          expect(['headline', 'mark', 'rule']).toContain(slot.role);
        }
      }
    }
    expect(candidates({ packId: 'swiss_editorial', content: noMedia }).map((c) => c.template.id))
      .not.toContain('editorial.split_asymmetric');
  });

  it('caps the list so the caster is not handed everything', () => {
    // Handing a model 100 options is worse than handing it 12 — it picks from the
    // top of a long list.
    expect(candidates({ packId: 'saas_explainer', content: CONTENT, limit: 5 })).toHaveLength(5);
    for (const pack of LOOK_PACKS) {
      expect(candidates({ packId: pack.id, content: CONTENT }).length).toBeLessThanOrEqual(12);
    }
  });

  it('ranks the pack preference list first', () => {
    const pack = lookPack('luxury_film');
    const list = candidates({ packId: pack.id, content: CONTENT });
    if (list.length && pack.layoutPrefer.length) {
      expect(pack.layoutPrefer).toContain(list[0]!.template.id);
    }
  });
});

describe('pack coverage', () => {
  it('every pack has at least three usable layouts — INCLUDING the product packs', () => {
    // Below three, every piece in that pack repeats visibly.
    //
    // This test used to skip the product packs, on the assumption that their
    // frames lived in `@motion/product-motion`. They did not: `saas_product` and
    // `mobile_app` named four templates in `layoutPrefer` that did not exist
    // anywhere, so both packs had techniques and components and nowhere to put
    // them — and the skip is exactly why nothing caught it. A sweep with an
    // exemption is a sweep with a blind spot.
    for (const pack of LOOK_PACKS) {
      const count = templatesForPack(pack).length;
      expect(`${pack.id}: ${count} layouts`).toBe(`${pack.id}: ${Math.max(count, 3)} layouts`);
    }
  });

  it('every id a pack PREFERS actually exists', () => {
    // The dangling-reference check. `layoutPrefer` is a ranking hint, so a name
    // that resolves to nothing degrades silently to "no preference" rather than
    // failing — which is precisely how four missing templates went unnoticed.
    const ids = new Set(layoutTemplateIds());
    for (const pack of LOOK_PACKS) {
      for (const id of pack.layoutPrefer) {
        expect(`${pack.id} prefers ${id}: ${ids.has(id)}`).toBe(`${pack.id} prefers ${id}: true`);
      }
    }
  });

  it('every editorial pack can build a hero, a middle and an end card', () => {
    for (const pack of LOOK_PACKS) {
      // Product packs are shaped differently — a device frame IS the hero — so
      // the hero/middle/endcard structure genuinely does not apply to them.
      if (pack.vocabulary === 'product') continue;
      const ids = templatesForPack(pack).map((t) => t.id);
      expect(ids.some((id) => id.startsWith('hero.') || id.startsWith('editorial.'))).toBe(true);
      expect(ids.some((id) => id.startsWith('stat.') || id.startsWith('grid.') || id.startsWith('quote.') || id.startsWith('list.') || id.startsWith('data.') || id.startsWith('lowerthird.'))).toBe(true);
    }
  });
});
