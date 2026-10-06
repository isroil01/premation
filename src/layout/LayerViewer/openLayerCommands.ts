/**
 * Layer ▸ Open Layer / Open Layer Source / Open Composition — After Effects'
 * three "open" commands, for the selected layer. They are the menu side of
 * what a double-click does (openLayer.ts): until now the Layer and Footage
 * viewers could only be reached by double-clicking, or by a tab that looked
 * disabled until a layer was selected.
 *
 *   • Open Layer        — the layer alone, in the Layer viewer.
 *   • Open Layer Source — the file the layer plays, in the Footage viewer.
 *   • Open Composition  — the composition a composition layer shows, where its
 *                         parts are separate, selectable layers.
 */

import type { Command } from '@core/commands/Command';
import { asCommandId } from '@app-types/common';
import { documentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import { canOpenInLayerPanel, canOpenLayerComposition, canOpenLayerSource, openLayerPanel, openLayerSource } from './openLayer';
import { openLayerComposition } from '@layout/Composition/compNavigationEdits';

/** The one selected layer, or null. */
function selectedLayer(): string | null {
  const ids = useSelectionStore.getState().ids;
  if (ids.length !== 1) return null;
  const id = ids[0]!;
  return documentMirror().layer(id) ? id : null;
}

export function buildOpenLayerCommands(): Command[] {
  return [
    {
      id: asCommandId('layer.openLayer'),
      label: 'Open Layer',
      description: 'Show the selected layer on its own in the Layer viewer (masks, paint, roto, tracking)',
      icon: 'layers',
      enabled: () => {
        const id = selectedLayer();
        return id !== null && canOpenInLayerPanel(id);
      },
      execute: () => {
        const id = selectedLayer();
        if (id) openLayerPanel(id);
      },
    },
    {
      id: asCommandId('layer.openLayerSource'),
      label: 'Open Layer Source',
      description: 'Show the file the selected layer plays in the Footage viewer',
      icon: 'media',
      enabled: () => {
        const id = selectedLayer();
        return id !== null && canOpenLayerSource(id);
      },
      execute: () => {
        const id = selectedLayer();
        if (id) openLayerSource(id);
      },
    },
    {
      id: asCommandId('layer.openComposition'),
      label: 'Open Composition',
      description: 'Open the composition the selected layer shows, where its parts are separate layers',
      icon: 'shape',
      enabled: () => {
        const id = selectedLayer();
        return id !== null && canOpenLayerComposition(id);
      },
      execute: () => {
        const id = selectedLayer();
        if (id) openLayerComposition(id);
      },
    },
  ];
}
