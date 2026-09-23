/**
 * PropertiesPanel — the inspector for whatever is selected, as one list.
 *
 * ## History, because the shape has flipped three times
 *
 * This was once three dock tabs — Transform, Style, Settings — and each was an
 * accordion of property sections with its own search box that could not see
 * the other two. Picking a camera while Style was active showed nothing, so a
 * selection effect had to auto-switch tabs. They were merged into one panel
 * (2026-08-03) to end the guessing.
 *
 * The merge over-corrected: a plain shape then showed EIGHT section headers in
 * one column, so sub-tabs came back inside the panel (Transform · Style ·
 * Layer · Animation, plus Pinned). Measured with a plain shape selected, those
 * tabs mostly held what did not apply — "Layer" opened on a disabled
 * Pathfinder, "Animation" held two advanced tools — and the header above them
 * was nine unlabelled switch icons squeezing the title to "PR…".
 *
 * ## One list, done properly (2026-09-15)
 *
 *   • ONE scrolling accordion, in the registry's editing order, with
 *     sentence-case names;
 *   • a section that does not apply to the selection is not drawn at all —
 *     including whole-selection rules, so Pathfinder appears only once two
 *     shapes are selected;
 *   • only the sections about what the layer IS and how it looks open by
 *     default; everything else starts collapsed;
 *   • the first row names the selection (`SelectionHeader`), and the six layer
 *     switches are labelled checkbox rows in the ⋯ menu instead of glyphs in
 *     the dock header. The dock header keeps its title and only the search
 *     toggle is portalled into it;
 *   • two or more layers selected puts align / distribute on a row above the
 *     sections; nothing selected shows the composition summary.
 *
 * ## The selection, not the first selected layer (2026-09-04)
 *
 * Every section is drawn for the PRIMARY layer and edits ALL selected layers,
 * through `InspectorSelectionProvider`: a row whose values disagree shows `—`,
 * a drag offsets every layer, a typed `+10` is evaluated per layer, and every
 * gesture is one undo entry (`core/inspector/multiSelection.ts`). A section
 * only some of the selection has is badged "2 of 3" in its header.
 *
 * ## What re-renders when
 *
 * The shell reads the document MIRROR (B4) and subscribes to the SELECTION's
 * mirror keys only — each selected layer's header, property tree and keyframe
 * lists (`useMirrorLayersWatch`): a scrub on an unselected layer does not
 * re-render this panel at all, and a value scrub on a selected one re-renders
 * only the rows that read that property. Each section sits
 * in a memoised host (`InspectorContent`), so a keystroke in the search box
 * does not run twenty section renders.
 *
 * The panel is the SHELL only: the identity row, the search, the align row and
 * the scroller. Which sections exist and in what order is
 * `inspectorSections.ts`; how they render is `InspectorContent`.
 */

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Panel } from '@components/Panel';
import { SearchField } from '@components/SearchField';
import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { useDockPanelHeader } from '@components/DockPanel';
import { useSelectionStore } from '@stores/selectionStore';
import { useTemplateStore } from '@stores/templateStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useLayoutStore } from '@stores/layoutStore';
import { getEventBus } from '@core/events/EventBus';
import { getCommandRegistry } from '@core/commands/Command';
import { asCommandId } from '@app-types/common';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorLayersWatch } from '@hooks/useMirror';
import { InspectorContent } from '@layout/Inspector/InspectorContent';
import { InspectorSelectionProvider } from '@layout/Inspector/inspectorSelection';
import {
  SelectionHeader,
  layerSwitchMenuItems,
  layerSwitchSignature,
} from '@layout/Inspector/SelectionHeader';
import { SelectionAlignRow } from '@layout/Inspector/SelectionAlignRow';
import { MographParamsSection } from '@layout/Inspector/MographParamsSection';
import { ActiveTemplateFields } from '@layout/Templates/TemplateFieldsPanel';
import { cn } from '@utils/cn';
import styles from './panels.module.css';

/** The applied template's fields, or nothing when no template is applied. */
function TemplateFieldsSection(): JSX.Element | null {
  const active = useTemplateStore((s) => s.active);
  if (!active) return null;
  return <ActiveTemplateFields />;
}

/**
 * Open the Properties panel with the Pinned section expanded. There is no tab
 * to switch to any more, so "show pinned" means writing the section's
 * remembered open state — the same preference a click on its header writes.
 */
function showPinnedSection(): void {
  const prefs = usePreferenceStore.getState();
  prefs.set('inspectorSections', { ...prefs.inspectorSections, pinned: true });
  useLayoutStore.getState().openPanel('properties');
}

/**
 * Commands, registered once at module load — the same lazy pattern as the
 * tour command: on a pre-boot route the registry is not there yet and
 * Providers registers during boot.
 *
 * Menu rows wanted (menuModel.ts is not this file's to edit):
 *   View ▸ Inspector ▸ Keyframe Lanes             → inspector.toggleKeyframeLanes
 *   Window ▸ Properties ▸ Pinned / Effect Controls → inspector.showPinned / inspector.showEffects
 */
function registerInspectorCommands(): void {
  try {
    const reg = getCommandRegistry();
    reg.register({
      id: asCommandId('inspector.toggleKeyframeLanes'),
      label: 'Toggle Keyframe Lanes in Properties',
      description: 'Draw a mini keyframe strip under every animated property row',
      icon: 'keyframe',
      enabled: () => true,
      isChecked: () => usePreferenceStore.getState().inspectorShowLane,
      execute: () => {
        const s = usePreferenceStore.getState();
        s.set('inspectorShowLane', !s.inspectorShowLane);
      },
    });
    reg.register({
      id: asCommandId('inspector.showPinned'),
      label: 'Properties: Show Pinned',
      description: 'Open Properties with the selected layer’s pinned and essential properties expanded',
      icon: 'push-pin',
      enabled: () => true,
      execute: showPinnedSection,
    });
    reg.register({
      id: asCommandId('inspector.showEffects'),
      label: 'Open Effect Controls Panel',
      description: 'Show the selected layer’s effect stack in the Effect Controls panel',
      icon: 'sparkles',
      enabled: () => true,
      execute: () => useLayoutStore.getState().openPanel('effectControls'),
    });
  } catch {
    /* no registry yet (a pre-boot route) */
  }
}

registerInspectorCommands();

export function PropertiesPanel(): JSX.Element {
  const selected = useSelectionStore((s) => s.ids);
  const primary = selected[0] ?? null;
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  // The SELECTION's revisions, not the scene's — see the module note.
  useMirrorLayersWatch(selected);
  const mirror = documentMirror();
  const hasLayer = !!(primary && mirror.layer(primary));
  const liveCount = hasLayer ? selected.filter((id) => mirror.hasLayer(id)).length : 0;

  const showLane = usePreferenceStore((s) => s.inspectorShowLane);
  const setPref = usePreferenceStore((s) => s.set);

  // Closing the search clears it; a hidden non-empty query would silently keep
  // the panel in search view with no field on screen to say so.
  useEffect(() => {
    if (!searchOpen) setQuery('');
  }, [searchOpen]);

  const searching = query.trim().length > 0;

  // The switch rows' every input, flattened to a string. Re-read each render
  // (a toggle bumps the selection's revision, which re-renders this), but a
  // string compares by value, so the memo below only rebuilds when a row's
  // checked state or the applicable set actually moved.
  const switchSig = hasLayer ? layerSwitchSignature(selected) : '';

  // Memoised, and it has to be: the effect below hands this list to the
  // DockPanel header, which is a state update THERE and so a re-render HERE. A
  // fresh array per render re-ran the effect on every pass — the v0.8.1
  // "Maximum update depth exceeded" loop, hundreds of warnings a second.
  const menuItems: DropdownItem[] = useMemo(() => {
    const switches = hasLayer ? layerSwitchMenuItems(selected) : [];
    return [
      ...switches,
      ...(switches.length > 0 ? [{ type: 'separator' } as const] : []),
      {
        type: 'checkbox',
        id: 'lanes',
        label: 'Keyframe lanes under animated rows',
        checked: showLane,
        onChange: (v) => setPref('inspectorShowLane', v),
      },
      { type: 'separator' },
      {
        type: 'item',
        id: 'effect-controls',
        label: 'Open Effect Controls panel',
        icon: 'sparkles',
        onSelect: () => useLayoutStore.getState().openPanel('effectControls'),
      },
    ];
    // `switchSig` is listed because it IS the switch rows' input: the layers'
    // switch states live on scene nodes, which no other dependency here tracks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasLayer, selected, switchSig, showLane, setPref]);

  const dockHeader = useDockPanelHeader();
  const setCustomMenuItems = dockHeader?.setCustomMenuItems;

  useEffect(() => {
    if (!setCustomMenuItems) return;
    setCustomMenuItems(menuItems);
    return () => setCustomMenuItems([]);
  }, [setCustomMenuItems, menuItems]);

  const searchButton = (
    <button
      type="button"
      className={cn(styles.layerHeadBtn, searchOpen && styles.layerHeadBtnActive)}
      aria-label={searchOpen ? 'Close property search' : 'Search properties'}
      aria-pressed={searchOpen}
      title="Search properties"
      onClick={() => setSearchOpen((v) => !v)}
    >
      <Icon name="search" size="sm" />
    </button>
  );

  // Outside a dock (a standalone mount, a test) there is no dock header to
  // carry search and ⋯, so they sit at the end of the identity row instead.
  const fallbackActions = dockHeader?.target ? undefined : (
    <>
      {searchButton}
      <Dropdown
        items={menuItems}
        placement="bottom-end"
        trigger={
          <button type="button" className={styles.layerHeadBtn} aria-label="Properties panel options" title="Options">
            <Icon name="more-horizontal" size="sm" />
          </button>
        }
      />
    </>
  );

  return (
    <Panel
      id="properties"
      title="Properties"
      icon="settings"
      hideHeader
      noScroll
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'properties' })}
    >
      <div className={styles.inspectorShell}>
        {/* Only the search toggle rides in the dock header, beside the panel's
            own title and ⋯ — one glyph, so the title is never truncated. */}
        {hasLayer && dockHeader?.target && createPortal(searchButton, dockHeader.target)}
        {hasLayer && (
          <div className={styles.layerHead}>
            <SelectionHeader nodeIds={selected} actions={fallbackActions} />
          </div>
        )}
        {hasLayer && searchOpen && (
          <div className={styles.searchRow}>
            <SearchField
              placeholder="Search all properties…"
              ariaLabel="Search properties"
              value={query}
              onChange={setQuery}
              autoFocus
            />
          </div>
        )}
        <div className={styles.inspectorBody}>
          {liveCount > 1 && !searching && <SelectionAlignRow nodeIds={selected} />}
          <InspectorSelectionProvider nodeIds={selected}>
            <InspectorContent nodeId={primary} nodeIds={selected} query={query} />
          </InspectorSelectionProvider>
          {/* Not sections of the SELECTION: mograph parameters belong to the
              mograph player and template fields to the applied template, so
              neither can live in a registry keyed on the selected layer. */}
          <div className={styles.inspectorExtras}>
            <MographParamsSection />
            <TemplateFieldsSection />
          </div>
        </div>
      </div>
    </Panel>
  );
}

export default PropertiesPanel;
