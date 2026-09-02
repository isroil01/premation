/**
 * InspectorContent — every property section for the selected layer, in one
 * ordered accordion.
 *
 * This file is now only the MECHANISM: which sections apply comes from
 * `inspectorSections.ts`, which section is open comes from the preference
 * store, and what a section draws comes from the section. What is left here is
 * the search filter, the remembered open/closed state, and the empty states.
 *
 * `InspectorAccordion` is exported because the Rigging panel is the same
 * mechanism over a different (much shorter) list: one accordion, one search
 * box, the same persisted open/closed behaviour.
 */

import { useCallback } from 'react';
import { Accordion, type AccordionItem } from '@components/Accordion';
import { EmptyState } from '@components/EmptyState';
import { usePreferenceStore } from '@stores/preferenceStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { InspectorSection } from './InspectorSection';
import { inspectorSectionsFor, resolve, type InspectorSectionDef, type InspectorCategory } from './inspectorSections';
import styles from '@layout/EditorLayout/panels.module.css';

/**
 * Filter sections by a search query; matches are forced open.
 *
 * The title alone is not enough — searching "color" has to reach Appearance and
 * "shadow" has to reach Layer Styles — so each section carries `keywords`.
 * Those used to live in a `SECTION_KEYWORDS` map in another file entirely,
 * which meant a new section was searchable only if someone remembered to edit
 * two places.
 */
function matchesQuery(def: InspectorSectionDef, nodeId: string, q: string): boolean {
  const title = resolve(def.title, nodeId).toLowerCase();
  return title.includes(q) || (def.keywords ?? '').includes(q);
}

/** One registry row → one accordion item, drawn in the shared section shell. */
function toAccordionItem(def: InspectorSectionDef, nodeId: string, forceOpen: boolean): AccordionItem {
  const { Component } = def;
  return {
    id: def.id,
    title: resolve(def.title, nodeId),
    icon: def.icon === undefined ? undefined : resolve(def.icon, nodeId),
    defaultOpen: def.defaultOpen === undefined ? undefined : resolve(def.defaultOpen, nodeId),
    mountOnOpen: def.mountOnOpen,
    // `forceOpen`, not `defaultOpen`: a remembered "closed" for this section
    // outranks defaultOpen, and would otherwise hide the hit you searched for.
    ...(forceOpen ? { forceOpen: true } : {}),
    content: (
      <InspectorSection>
        <Component nodeId={nodeId} />
      </InspectorSection>
    ),
  };
}

/**
 * Shared accordion render for the Properties and Rigging panels, applying the
 * user's remembered open/closed sections.
 */
export function InspectorAccordion({ items }: { items: AccordionItem[] }): JSX.Element {
  // Remembered per section id and persisted, so the Inspector reopens the way
  // you left it. Local `useState` could not do this: the panel unmounts on
  // every tab switch and whenever the selection is cleared, which is why
  // Transform sprang back open however often you collapsed it.
  const sections = usePreferenceStore((s) => s.inspectorSections);
  const setPref = usePreferenceStore((s) => s.set);
  const onToggle = useCallback(
    (id: string, open: boolean) => {
      setPref('inspectorSections', { ...usePreferenceStore.getState().inspectorSections, [id]: open });
    },
    [setPref],
  );
  // No `key={query}` upstream: keying on the search text REMOUNTED the whole
  // Accordion on every keystroke, throwing away every section's DOM (and any
  // in-flight edit inside one) on each character typed.
  //
  // No wrapper padding: a 4px inset stopped the section hairlines short of the
  // panel edge and pushed each section's gutter to 16px, while the search box
  // above sat at 8px — three different left edges down one narrow column.
  return <Accordion items={items} openOverrides={sections} onToggle={onToggle} />;
}

/** Legacy signature kept for the Rigging panel's kind-branch call sites. */
export function renderInspector(items: AccordionItem[], query: string): JSX.Element {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? items
        .filter((it) => (typeof it.title === 'string' ? it.title.toLowerCase().includes(q) : false))
        .map((it) => ({ ...it, forceOpen: true }))
    : items;
  if (q && filtered.length === 0) {
    return <EmptyState compact icon="search" message={`No properties match “${query.trim()}”.`} />;
  }
  return <InspectorAccordion items={filtered} />;
}

export interface InspectorContentProps {
  nodeId: string | null;
  query?: string;
  category?: InspectorCategory;
}

export function InspectorContent({ nodeId, query = '', category = 'all' }: InspectorContentProps): JSX.Element {
  if (!nodeId) {
    return (
      <EmptyState
        icon="mouse-pointer"
        title="Properties: No Selection"
        message="Select a layer to view and adjust its transform, appearance, and effects."
      />
    );
  }

  if (!defaultSceneGraph.getNode(nodeId)) return <div className={styles.empty}>No node data</div>;

  const all = inspectorSectionsFor(nodeId, category);
  if (all.length === 0) {
    if (category !== 'all') {
      return (
        <EmptyState
          compact
          icon="info"
          message={`No ${category} properties available for this layer.`}
        />
      );
    }
    return <EmptyState icon="info" message="This layer type has no editable properties." />;
  }

  const q = query.trim().toLowerCase();
  const matched = q ? all.filter((def) => matchesQuery(def, nodeId, q)) : all;
  if (q && matched.length === 0) {
    return <EmptyState compact icon="search" message={`No properties match “${query.trim()}”.`} />;
  }

  return <InspectorAccordion items={matched.map((def) => toAccordionItem(def, nodeId, q.length > 0))} />;
}

export default InspectorContent;
