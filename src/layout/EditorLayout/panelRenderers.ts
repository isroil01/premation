/**
 * Panel id → the component that renders it.
 *
 * The dock resolves what to draw through this map, and so does `PopoutRoute`:
 * a panel detached into its own window never runs the shell's registration
 * effect, so this map is the ONLY thing both windows agree on. That is why it
 * is a plain data map in its own module rather than something assembled inside
 * a renderer — a panel present in one window and absent from the other is the
 * class of bug this shape rules out.
 *
 * Kept in step with `panelDefs.ts`, which holds the same ids' titles, icons,
 * regions and weights. A def with no renderer draws an empty tab; a renderer
 * with no def draws an untitled one.
 */

import { createElement, type ComponentType, type ReactNode } from 'react';
import { AiChatPanel } from '@layout/AiChat/AiChatPanel';
import { aiEnabled } from '@core/config/edition';
import { HistoryPanel } from '@layout/History/HistoryPanel';
import { MotionEditorPanel } from '@layout/Motion/MotionEditorPanel';
import { MotionPresetsPanel } from '@layout/Motion/MotionPresetsPanel';
import { EffectsPanel } from '@layout/Effects/EffectsPanel';
import { EffectControlsPanel } from '@layout/Effects/EffectControlsPanel';
import { RenderQueuePanel } from '@layout/RenderQueue/RenderQueuePanel';
import { PluginsDockPanel, pluginPanelRenderers } from '@layout/Plugins/PluginPanel';
import { PluginsMarketplacePanel } from '@layout/Plugins/PluginsMarketplacePanel';
import { SwatchesPanel } from '@layout/Swatches';
import { ScopesPanel } from '@layout/Scopes';
// Imported from the barrel deliberately: it also registers the transcript's
// commands on load. See `layout/Transcript/index.ts`.
import { TranscriptPanel } from '@layout/Transcript';
import { SourceMonitorPanel } from '@layout/SourceMonitor/SourceMonitorPanel';
import { CharacterPanel } from '@layout/Inspector/CharacterPanel';
import { ParagraphPanel } from '@layout/Inspector/ParagraphPanel';
import { AlignPanel } from '@layout/Inspector/AlignPanel';
import { InfoAudioPanel } from '@layout/Inspector/InfoAudioPanel';
import { PreviewPanel } from '@layout/Inspector/PreviewPanel';
import { TrackerPanel } from '@layout/Inspector/TrackerPanel';
import { ScenePanel } from '@layout/Scene/ScenePanel';
import { AssetsPanel } from '@layout/Assets/AssetsPanel';
import { PropertiesPanel } from './PropertiesPanel';
import { RigPanel } from './RigPanel';
import { LibraryPanel } from './LibraryPanel';

/**
 * The static half of the map — everything known at build time.
 *
 * `components`, `shapes` and `text` used to be listed here as standalone
 * panels too. They were never registered in PANEL_DEFS and nothing opened
 * them, while the SAME three components already render as sections inside
 * LibraryPanel — so the entries were unreachable copies of live UI.
 *
 * `style` and `misc` are gone for the same reason (2026-08-03): they were two
 * more accordions of properties for the selected layer, which is what
 * `properties` already is. Their sections now render inside it. DockPanel drops
 * panelOrder ids that no longer register, so persisted layouts and saved
 * workspaces holding the old ids simply lose the dead tabs.
 */
export const PANEL_COMPONENTS: Readonly<Record<string, ComponentType>> = {
  scene: ScenePanel,
  assets: AssetsPanel,
  transcript: TranscriptPanel,
  presets: MotionPresetsPanel,
  properties: PropertiesPanel,
  character: CharacterPanel,
  paragraph: ParagraphPanel,
  align: AlignPanel,
  swatches: SwatchesPanel,
  info: InfoAudioPanel,
  scopes: ScopesPanel,
  preview: PreviewPanel,
  sourceMonitor: SourceMonitorPanel,
  tracker: TrackerPanel,
  rig: RigPanel,
  motion: MotionEditorPanel,
  effects: EffectsPanel,
  effectControls: EffectControlsPanel,
  history: HistoryPanel,
  renderQueue: RenderQueuePanel,
  plugins: PluginsDockPanel,
  marketplace: PluginsMarketplacePanel,
  // ── Asset Library (one tab, sections inside) ─────────────────────────
  library: LibraryPanel,
};

/**
 * Every panel this build can draw, as thunks.
 *
 * Two entries are resolved at CALL time rather than listed above, because
 * neither is known statically:
 *
 *  • the assistant is spread conditionally so a future `aiEnabled()` flip still
 *    keeps PopoutRoute honest — it resolves renderers by id straight from this
 *    map, so a pop-out at /popout/ai must not remount the panel around a gate
 *    that says the surface is absent;
 *  • plugin panels that earned a rail tab of their own depend on what the user
 *    installed. Both sidebars and `PopoutRoute` read this map, so a plugin panel
 *    detached into its own window resolves here exactly like Scene does.
 */
export function getAllPanelRenderers(): Record<string, () => ReactNode> {
  const out: Record<string, () => ReactNode> = {};
  if (aiEnabled()) out.ai = () => createElement(AiChatPanel);
  for (const [id, Component] of Object.entries(PANEL_COMPONENTS)) {
    out[id] = () => createElement(Component);
  }
  return { ...out, ...pluginPanelRenderers() };
}
