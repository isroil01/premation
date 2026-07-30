/**
 * The layout-template registry, and the query the caster uses.
 *
 * The query matters as much as the library. Handing a model 100 template
 * descriptions is worse than handing it 12: attention degrades, and a list long
 * enough to be comprehensive is long enough that the model picks from the top.
 * So `candidates()` pre-filters hard — by pack, by which slots the content can
 * actually fill — and returns a short list with one line each.
 */

import { HERO_TEMPLATES } from './templates/hero';
import { CONTENT_TEMPLATES } from './templates/content';
import { EDITORIAL_TEMPLATES_2 } from './templates/editorial2';
import { EDITORIAL_TEMPLATES_3 } from './templates/editorial3';
import { EDITORIAL_TEMPLATES_4 } from './templates/editorial4';
import { DEVICE_TEMPLATES } from './templates/device';
import { DEVICE_TEMPLATES_2 } from './templates/device2';
import type { LayoutTemplate, SlotContent, SlotRole } from './compose';
import { lookPack, type LookPack } from './packs';

export const LAYOUT_TEMPLATES: readonly LayoutTemplate[] = [
  ...HERO_TEMPLATES,
  ...CONTENT_TEMPLATES,
  ...EDITORIAL_TEMPLATES_2,
  ...EDITORIAL_TEMPLATES_3,
  ...EDITORIAL_TEMPLATES_4,
  // Device frames and product-UI layouts. Without these the two product packs
  // named four templates in `layoutPrefer` that did not exist, so they had
  // techniques and components but nowhere to put them.
  ...DEVICE_TEMPLATES,
  // The second product set. Measured before it: `mobile_app` could use THREE
  // templates in total and `saas_product` six, against eleven to thirty for
  // every editorial pack — so the caster's structural choice for a product
  // prompt was made before the model was asked.
  ...DEVICE_TEMPLATES_2,
];

const BY_ID = new Map(LAYOUT_TEMPLATES.map((t) => [t.id, t]));

export function layoutTemplate(id: string): LayoutTemplate | undefined {
  return BY_ID.get(id);
}

/** Every template id, for validation. */
export function layoutTemplateIds(): string[] {
  return [...BY_ID.keys()];
}

/** Which slot roles this content can fill. */
export function availableRoles(content: SlotContent): Set<SlotRole> {
  const roles = new Set<SlotRole>();
  if (content.headline) roles.add('headline');
  if (content.subhead) roles.add('subhead');
  if (content.support) roles.add('support');
  if (content.overline) roles.add('overline');
  if (content.quote) roles.add('quote');
  if (content.cta) roles.add('cta');
  if (content.mediaAssetId) roles.add('media');
  if (content.items?.length) {
    // Items serve both roles; which one a template wants is its business.
    roles.add('stat');
    roles.add('list');
  }
  // A mark and a rule are drawn, not supplied — a template can always produce
  // them, so they never gate candidacy.
  roles.add('mark');
  roles.add('rule');
  return roles;
}

export interface CandidateQuery {
  packId: string;
  content: SlotContent;
  /** Cap the list. 12 is a good ceiling — see the file docstring. */
  limit?: number;
  /** Prefer templates carrying any of these tags. */
  tags?: readonly string[];
}

export interface Candidate {
  template: LayoutTemplate;
  /** One line for the caster. Short and evocative, never the full definition. */
  brief: string;
}

/**
 * Templates a caster may choose from, ranked.
 *
 * Filtering is strict on two things and soft on everything else:
 *  • the pack must allow the template (`packs` list and the pack's `forbid`), and
 *  • every REQUIRED slot must be fillable by the content.
 *
 * The second is what stops a `split_asymmetric` being cast with no media and
 * quietly rendering a half-empty frame.
 */
export function candidates(q: CandidateQuery): Candidate[] {
  const pack = lookPack(q.packId);
  const roles = availableRoles(q.content);

  const eligible = LAYOUT_TEMPLATES.filter((t) => {
    if (!t.packs.includes(pack.id)) return false;
    if (pack.forbid.includes(t.id)) return false;
    return t.slots.every((s) => !s.required || roles.has(s.role));
  });

  const scored = eligible.map((t) => {
    let score = 0;
    // The pack's own preference list dominates — it is the curated answer.
    const preferIndex = pack.layoutPrefer.indexOf(t.id);
    if (preferIndex >= 0) score += 100 - preferIndex;
    if (q.tags?.length) score += t.tags.filter((tag) => q.tags!.includes(tag)).length * 8;
    // A template that uses MORE of the available content is a better fit than one
    // that discards half of it.
    score += t.slots.filter((s) => roles.has(s.role)).length * 2;
    return { t, score };
  });

  scored.sort((a, b) => b.score - a.score || a.t.id.localeCompare(b.t.id));

  return scored.slice(0, q.limit ?? 12).map(({ t }) => ({
    template: t,
    brief: briefFor(t),
  }));
}

/** The one-line form the caster sees. */
export function briefFor(t: LayoutTemplate): string {
  const required = t.slots.filter((s) => s.required).map((s) => s.role);
  const optional = t.slots.filter((s) => !s.required).map((s) => s.role);
  return (
    `${t.id} — ${t.intent}\n` +
    `  tags: ${t.tags.join(', ')}\n` +
    `  needs: ${required.join(', ') || '(nothing)'}` +
    (optional.length ? ` | optional: ${optional.join(', ')}` : '') +
    ` | space ${Math.round(t.negativeSpaceRatio[0] * 100)}–${Math.round(t.negativeSpaceRatio[1] * 100)}% empty` +
    ` | ${t.variants} variants`
  );
}

/** Templates a pack can use at all — for coverage reporting. */
export function templatesForPack(pack: LookPack): readonly LayoutTemplate[] {
  return LAYOUT_TEMPLATES.filter((t) => t.packs.includes(pack.id) && !pack.forbid.includes(t.id));
}
