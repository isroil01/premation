/**
 * The dashboard→editor handoff for "start a project from a library item"
 * (a template, a Lottie animation or a sound).
 *
 * The dashboard's Library page creates a project (sized to a scene template)
 * and parks the catalog row here; the editor's ProjectLoader collects it right
 * after the project opens and inserts it through the same path the editor's
 * Library uses (a scene adopts the new project's pristine comp).
 *
 * A one-shot, like `pendingFootage`: `take` clears, so a reload or a different
 * project can never replay the template into the wrong document.
 */

import type { PremiumCatalogItem } from '@core/library/premium/packFormat';

let pending: PremiumCatalogItem | null = null;

export function setPendingTemplate(item: PremiumCatalogItem): void {
  pending = item;
}

export function takePendingTemplate(): PremiumCatalogItem | null {
  const item = pending;
  pending = null;
  return item;
}
