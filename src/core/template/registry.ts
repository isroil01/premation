/**
 * Template registry — the catalog the gallery lists and the store applies from.
 * Add a template here and it shows up everywhere automatically.
 */

import type { TemplateDefinition } from './templateTypes';
import { titleCardTemplate } from './templates/titleCard';
import { reelIntroTemplate } from './templates/reelIntro';
import { lowerThirdTemplate } from './templates/lowerThird';
import { photoPromoTemplate } from './templates/photoPromo';
import { gradientHeroTemplate } from './templates/gradientHero';
import { quoteCardTemplate } from './templates/quoteCard';

export const TEMPLATES: readonly TemplateDefinition[] = [
  gradientHeroTemplate,
  titleCardTemplate,
  lowerThirdTemplate,
  photoPromoTemplate,
  quoteCardTemplate,
  reelIntroTemplate,
];

export function getTemplate(id: string): TemplateDefinition | null {
  return TEMPLATES.find((t) => t.id === id) ?? null;
}
