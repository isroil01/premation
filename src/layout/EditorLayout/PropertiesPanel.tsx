/**
 * PropertiesPanel — the single inspector for whatever is selected.
 *
 * This used to be three tabs: Transform (`properties`), Style (`style`) and
 * Settings (`misc`). All three were the same thing — an accordion of property
 * sections for the selected layer — so the split only ever asked the user to
 * guess which tab owned the property they wanted, and each tab carried its own
 * search box that could not see the other two.
 *
 * The split also forced a workaround elsewhere: a selection effect in App.tsx
 * had to auto-switch tabs for cameras and lights, because picking one while
 * the wrong tab was active showed nothing at all. Merging removed the need for
 * that entirely.
 *
 * Rigging, Graph, Effects, Presets, Render and Plugins stay separate tabs on
 * purpose — those are editors and modes, not properties of the selection.
 *
 * The panel is the SHELL only: the layer header, the search box and the
 * scroller. Which sections exist and in what order is `inspectorSections.ts`;
 * how they are rendered is `InspectorContent`.
 */

import { useState } from 'react';
import { Panel } from '@components/Panel';
import { SearchField } from '@components/SearchField';
import { Icon, type IconName } from '@components/Icon';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useTemplateStore } from '@stores/templateStore';
import { getEventBus } from '@core/events/EventBus';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { splitKind } from '@core/plugins/layerKindSchema';
import { InspectorContent } from '@layout/Inspector/InspectorContent';
import { MographParamsSection } from '@layout/Inspector/MographParamsSection';
import { ActiveTemplateFields } from '@layout/Templates/TemplateFieldsPanel';
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
  useSceneRevision((s) => s.rev);
  const node = primary ? defaultSceneGraph.getNode(primary) : null;
  const kind = node ? readNodeKind(node) : null;
  const layerName = node?.name?.trim() || primary;
  const kindIcon = (kind && LAYER_KIND_ICON[kind]) || 'layers';

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
            <span className={styles.layerKind}>{layerKindLabel(kind ?? '')}</span>
            <span className={styles.layerName} title={layerName ?? undefined}>{layerName}</span>
          </div>
        )}
        {primary && (
          <div className={styles.searchRow}>
            <SearchField
              placeholder="Search properties…"
              ariaLabel="Search properties"
              value={query}
              onChange={setQuery}
            />
          </div>
        )}
        <div className={styles.inspectorBody}>
          <InspectorContent nodeId={primary} query={query} />
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
