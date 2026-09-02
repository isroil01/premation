/**
 * PropertiesPanel — the inspector for whatever is selected, in four sub-tabs.
 *
 * ## History, because the shape has flipped twice
 *
 * This was once three dock tabs — Transform, Style, Settings — and each was an
 * accordion of property sections with its own search box that could not see
 * the other two. Picking a camera while Style was active showed nothing, so a
 * selection effect had to auto-switch tabs. They were merged into one panel
 * (2026-08-03) to end the guessing.
 *
 * The merge over-corrected: a plain shape then showed EIGHT section headers in
 * one column, and the section you wanted was below the fold behind a wall of
 * uppercase titles. So the sections are grouped again — but INSIDE the panel,
 * under one header and one search box, and with the two failure modes of the
 * old split designed out:
 *
 *   • a sub-tab is only offered when the selected layer has a section in it,
 *     and a remembered tab the new layer lacks falls back to the first it has,
 *     so a selection never lands on an empty screen;
 *   • the search box reads across every sub-tab, and each hit is badged with
 *     the tab it lives in — so "where is X" is answered by typing X.
 *
 * The panel is the SHELL only: the layer header, the tab strip, the search and
 * the scroller. Which sections exist, in what order and in which tab is
 * `inspectorSections.ts`; how they render is `InspectorContent`.
 */

import { useEffect, useState } from 'react';
import { Panel } from '@components/Panel';
import { SearchField } from '@components/SearchField';
import { Icon, type IconName } from '@components/Icon';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useTemplateStore } from '@stores/templateStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { getEventBus } from '@core/events/EventBus';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { splitKind } from '@core/plugins/layerKindSchema';
import { InspectorContent } from '@layout/Inspector/InspectorContent';
import {
  INSPECTOR_CATEGORIES,
  inspectorCategoriesFor,
  type InspectorCategory,
} from '@layout/Inspector/inspectorSections';
import { MographParamsSection } from '@layout/Inspector/MographParamsSection';
import { ActiveTemplateFields } from '@layout/Templates/TemplateFieldsPanel';
import { cn } from '@utils/cn';
import styles from './panels.module.css';

const LAYER_KIND_LABEL: Record<string, string> = {
  shape: 'Shape',
  text: 'Text',
  image: 'Image',
  video: 'Video',
  group: 'Group',
  null: 'Null',
  camera: 'Camera',
  light: 'Light',
  audio: 'Audio',
  svg: 'SVG',
  particle: 'Particle',
};

const LAYER_KIND_ICON: Record<string, IconName> = {
  shape: 'shape',
  text: 'type',
  image: 'image',
  video: 'video',
  group: 'folder',
  null: 'info',
  camera: 'camera',
  light: 'light',
  audio: 'audio',
  svg: 'shape',
  particle: 'sparkles',
};

function layerKindLabel(kind: string): string {
  const custom = splitKind(kind);
  if (custom) return custom.kindId;
  return LAYER_KIND_LABEL[kind] ?? kind;
}

/** The applied template's fields, or nothing when no template is applied. */
function TemplateFieldsSection(): JSX.Element | null {
  const active = useTemplateStore((s) => s.active);
  if (!active) return null;
  return <ActiveTemplateFields />;
}

export function PropertiesPanel(): JSX.Element {
  const selected = useSelectionStore((s) => s.ids);
  const primary = selected[0] ?? null;
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  useSceneRevision((s) => s.rev);
  const node = primary ? defaultSceneGraph.getNode(primary) : null;
  const kind = node ? readNodeKind(node) : null;
  const layerName = node?.name?.trim() || primary;
  const kindIcon = (kind && LAYER_KIND_ICON[kind]) || 'layers';
  const selectionCount = selected.length;

  // The remembered sub-tab, resolved against what THIS layer offers.
  const preferredTab = usePreferenceStore((s) => s.inspectorTab);
  const setPref = usePreferenceStore((s) => s.set);
  const available: InspectorCategory[] = primary && node ? inspectorCategoriesFor(primary) : [];
  const activeTab: InspectorCategory | null = available.length === 0
    ? null
    : available.includes(preferredTab) ? preferredTab : available[0]!;

  // Closing the search clears it; a hidden non-empty query would silently keep
  // the panel in search view with no field on screen to say so.
  useEffect(() => {
    if (!searchOpen) setQuery('');
  }, [searchOpen]);

  const searching = query.trim().length > 0;

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
        {primary && node && (
          <div className={styles.layerHead}>
            <span className={styles.layerGlyph}>
              <Icon name={kindIcon} size="sm" />
            </span>
            <span className={styles.layerName} title={layerName ?? undefined}>{layerName}</span>
            <span className={styles.layerKind}>
              {selectionCount > 1 ? `${layerKindLabel(kind ?? '')} +${selectionCount - 1}` : layerKindLabel(kind ?? '')}
            </span>
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
          </div>
        )}
        {primary && node && searchOpen && (
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
        {/* The sub-tabs. Hidden while a search is live: the results span every
            tab and are badged with their own, so a strip claiming one tab is
            active would be telling a lie about what is on screen. */}
        {primary && node && !searching && available.length > 1 && (
          <div className={styles.inspectorTabs} role="tablist" aria-label="Property groups">
            {INSPECTOR_CATEGORIES.filter((c) => available.includes(c.id)).map((c) => {
              const isActive = c.id === activeTab;
              return (
                <button
                  key={c.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={isActive ? 0 : -1}
                  className={cn(styles.inspectorTab, isActive && styles.inspectorTabActive)}
                  onClick={() => setPref('inspectorTab', c.id)}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
        )}
        <div className={styles.inspectorBody}>
          <InspectorContent nodeId={primary} query={query} category={activeTab ?? 'all'} />
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
