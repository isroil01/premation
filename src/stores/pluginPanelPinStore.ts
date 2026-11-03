/**
 * Which effect plugin panels are pinned to one effect instance (the dock tab's
 * ≡ ▸ "Pin to <effect> on “<layer>”"), by panel id. A panel without a pin
 * follows the selection (PluginEffectHomePanel.tsx).
 *
 * Editor state on this machine — never the project document (CLAUDE.md:
 * editor state never enters the scene). Persisted to localStorage like the
 * dock layout, every access wrapped; a pin whose layer or effect is gone is
 * dropped by the panel (pluginDockRules.ts `pinStatus`).
 */

import { create } from 'zustand';

/** An effect panel pinned to one effect instance on one layer. */
export interface PluginPanelPin {
  readonly layerId: string;
  readonly effectId: string;
}

export const PLUGIN_PANEL_PINS_KEY = 'premation.pluginPanels.pins.v1';

function load(): Record<string, PluginPanelPin> {
  try {
    const raw = globalThis.localStorage?.getItem(PLUGIN_PANEL_PINS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const out: Record<string, PluginPanelPin> = {};
    if (parsed && typeof parsed === 'object') {
      for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
        const pin = v as Partial<PluginPanelPin> | null;
        if (pin && typeof pin.layerId === 'string' && typeof pin.effectId === 'string') out[id] = { layerId: pin.layerId, effectId: pin.effectId };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function save(pins: Record<string, PluginPanelPin>): void {
  try {
    globalThis.localStorage?.setItem(PLUGIN_PANEL_PINS_KEY, JSON.stringify(pins));
  } catch {
    // A blocked store: the pin lasts this session only.
  }
}

interface PluginPanelPinState {
  pins: Record<string, PluginPanelPin>;
  pin(panelId: string, pin: PluginPanelPin): void;
  unpin(panelId: string): void;
}

export const usePluginPanelPinStore = create<PluginPanelPinState>()((set, get) => ({
  pins: load(),
  pin: (panelId, pin) => {
    const pins = { ...get().pins, [panelId]: { layerId: pin.layerId, effectId: pin.effectId } };
    set({ pins });
    save(pins);
  },
  unpin: (panelId) => {
    if (!get().pins[panelId]) return;
    const { [panelId]: _gone, ...pins } = get().pins;
    set({ pins });
    save(pins);
  },
}));
