/**
 * InspectorContent — the property sections for the selection, as ONE ordered
 * accordion; with nothing selected, the composition summary.
 *
 * This file is only the MECHANISM: which sections apply comes from
 * `inspectorSections.ts` (per layer through `appliesTo`, per selection through
 * `appliesToSelection`), their order is that registry's array order, which
 * section is open comes from the preference store, and what a section draws
 * comes from the section. What is left here is the search filter, the
 * remembered open/closed state, the coverage badges and the empty states.
 *
 * Section headers carry no icons. Five of the registry's sections shared the
 * same `sparkles` glyph and three shared `shape`, so the column of icons the
 * accordion used to draw said nothing a reader could use — it only made each
 * header longer. The rail already identifies the panel; the header's job is
 * the section's NAME.
 *
 * `InspectorAccordion` is exported because the Rigging panel is the same
 * mechanism over a different (much shorter) list: one accordion, one search
 * box, the same persisted open/closed behaviour.
 */

import { memo, useCallback, type ComponentType } from 'react';
import { Accordion, type AccordionItem } from '@components/Accordion';
import { EmptyState } from '@components/EmptyState';
import { usePreferenceStore } from '@stores/preferenceStore';
import { documentMirror } from '@stores/documentMirror';
import { InspectorSection } from './InspectorSection';
import { CompositionSummary } from './CompositionSummary';
import {
  inspectorSectionsForSelection,
  resolve,
  sectionCoverage,
  type InspectorSectionDef,
} from './inspectorSections';
import styles from '@layout/EditorLayout/panels.module.css';

/**
 * Filter sections by a search query; matches are forced open.
 *
 * The title alone is not enough — searching "color" has to reach Appearance and
 * "shadow" has to reach Layer styles — so each section carries `keywords`.
 * Those used to live in a `SECTION_KEYWORDS` map in another file entirely,
 * which meant a new section was searchable only if someone remembered to edit
 * two places.
 */
function matchesQuery(def: InspectorSectionDef, nodeId: string, q: string): boolean {
  const title = resolve(def.title, nodeId).toLowerCase();
  return title.includes(q) || (def.keywords ?? '').includes(q);
}

/**
 * The shell around ONE section, memoised on (component, node).
 *
 * The panel re-renders for reasons that are none of a section's business — a
 * keystroke in the search box, a rename in the selection header, the ⋯ menu
 * hand-off — and every re-render used to rebuild every section's element tree
 * and run every section's render. With the host memoised, a section renders
 * again only when a mirror record it subscribes to changes (its own
 * `useMirror*` hooks) or when the node it is drawn for changes.
 */
const SectionHost = memo(function SectionHost({
  Component,
  nodeId,
}: {
  Component: ComponentType<{ nodeId: string }>;
  nodeId: string;
}): JSX.Element {
  return (
    <InspectorSection>
      <Component nodeId={nodeId} />
    </InspectorSection>
  );
});

/**
 * One registry row → one accordion item, drawn in the shared section shell.
 *
 * With several layers selected, a section that only some of them have is
 * badged "2 of 3" — the rows inside edit every layer that has the property,
 * and the badge says how many that is.
 */
function toAccordionItem(
  def: InspectorSectionDef,
  nodeId: string,
  searching: boolean,
  nodeIds: ReadonlyArray<string>,
): AccordionItem {
  const { Component, actions: ActionsComponent } = def;
  const coverage = nodeIds.length > 1 ? sectionCoverage(def, nodeIds) : nodeIds.length;
  const badge = nodeIds.length > 1 && coverage < nodeIds.length ? `${coverage} of ${nodeIds.length}` : undefined;
  return {
    id: def.id,
    title: resolve(def.title, nodeId),
    defaultOpen: def.defaultOpen === undefined ? undefined : resolve(def.defaultOpen, nodeId),
    mountOnOpen: def.mountOnOpen,
    actions: ActionsComponent ? <ActionsComponent nodeId={nodeId} nodeIds={nodeIds} /> : undefined,
    // `forceOpen`, not `defaultOpen`: a remembered "closed" for this section
    // outranks defaultOpen, and would otherwise hide the hit you searched for.
    ...(searching ? { forceOpen: true } : {}),
    ...(badge !== undefined ? { badge } : {}),
    content: <SectionHost Component={Component} nodeId={nodeId} />,
  };
}

/**
 * Shared accordion render for the Properties and Rigging panels, applying the
 * user's remembered open/closed sections.
 */
export function InspectorAccordion({ items }: { items: AccordionItem[] }): JSX.Element {
  // Remembered per section id and persisted, so the Inspector reopens the way
  // you left it. Local `useState` could not do this: the panel unmounts
  // whenever the selection is cleared, which is why Transform sprang back open
  // however often you collapsed it.
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
  /** The primary selected layer; `null` draws the composition summary. */
  nodeId: string | null;
  /** A non-empty query filters the sections by title and keywords. */
  query?: string;
  /**
   * The whole selection, primary first. Read for `appliesToSelection` and the
   * coverage badges; the rows reach it through `InspectorSelectionProvider`.
   */
  nodeIds?: ReadonlyArray<string>;
}

export function InspectorContent({ nodeId, query = '', nodeIds }: InspectorContentProps): JSX.Element {
  if (!nodeId) return <CompositionSummary />;

  if (!documentMirror().layer(nodeId)) return <div className={styles.empty}>No node data</div>;

  // Primary first whatever order the caller passed — the registry reads the
  // first id as the layer the sections are drawn for.
  const selection = [nodeId, ...(nodeIds ?? []).filter((id) => id !== nodeId)];
  const all = inspectorSectionsForSelection(selection);
  if (all.length === 0) {
    return <EmptyState icon="info" message="This layer type has no editable properties." />;
  }

  const q = query.trim().toLowerCase();
  const matched = q ? all.filter((def) => matchesQuery(def, nodeId, q)) : all;
  if (q && matched.length === 0) {
    return <EmptyState compact icon="search" message={`No properties match “${query.trim()}”.`} />;
  }

  return <InspectorAccordion items={matched.map((def) => toAccordionItem(def, nodeId, q.length > 0, selection))} />;
}

export default InspectorContent;
