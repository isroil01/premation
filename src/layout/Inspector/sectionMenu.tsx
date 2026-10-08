/**
 * Section menus — a section's actions, offered in the Properties panel's ≡
 * menu instead of as buttons in the section's header (2026-10-08).
 *
 * ## Why
 *
 * The panel grammar (typography.css, "Panel type roles"): a group row only
 * opens and closes — it never holds a checkbox or a button. Transform, Text,
 * Contents and Material each carried a "Presets ⌄" text button in their
 * accordion header, and the light's preset picker was a select above its
 * rows. Those are actions on the SECTION, not properties of the layer, and
 * After Effects keeps actions of that kind in the panel menu. So a section
 * names its actions as Dropdown rows and the Properties panel lists them in
 * its ≡ menu, one submenu per section ("Transform Presets ▸").
 *
 * ## How
 *
 * An `INSPECTOR_SECTIONS` row may carry a `menu` component. The Properties
 * panel mounts each applicable section's `menu` once per selection — outside
 * the accordion, so a collapsed, searched-away or filtered-out section still
 * offers its actions — inside a `SectionMenuSlot`, and the component calls
 * `useSectionMenuRows(rows)`. The slot hands the rows to the panel's
 * `SectionMenuRegistry`, which the panel reads with `useSyncExternalStore`
 * and merges into the rows it gives the dock header. Outside a slot the hook
 * does nothing and answers `false`, so a component that also draws its own
 * trigger elsewhere (the Text panel's presets) keeps doing so.
 *
 * ## The update loop this must not bring back (v0.8.1)
 *
 * Handing the dock a new array re-renders the dock, which re-renders the panel
 * and every menu host — which registers its rows again. So the registry
 * publishes a new list only when something a reader can SEE changed: ids,
 * labels, checks, icons, disabled, the structure (`signatureOf`). Callbacks
 * are not part of that, and the published rows do not hold them: each one
 * calls through to the LATEST registered row at the same place, so a row
 * never runs a stale closure (layer A's apply after layer B was selected)
 * even though the visible menu did not change.
 *
 * Rows are `item` / `checkbox` / `label` / `separator`. A `custom` row's node
 * is not compared, so a change inside one alone is not republished.
 */

import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { DropdownItem } from '@components/Dropdown';

interface Entry {
  order: number;
  rows: readonly DropdownItem[];
  /** `signatureOf(rows)` — what a reader of the menu can see. */
  sig: string;
}

const NO_ROWS: DropdownItem[] = [];

/** JSON with the callbacks dropped and any React node reduced to a marker. */
function visible(_key: string, value: unknown): unknown {
  if (typeof value === 'function') return undefined;
  if (value !== null && typeof value === 'object' && '$$typeof' in value) return '\u0000node';
  return value;
}

/** Everything about `rows` that shows in a menu, as one string. */
export function signatureOf(rows: readonly DropdownItem[]): string {
  return JSON.stringify(rows, visible);
}

/** The rows every mounted section menu registered, in section order. */
export class SectionMenuRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private published: DropdownItem[] = NO_ROWS;

  /**
   * Register — or refresh — one section's rows. Re-registering rows that look
   * the same only swaps in their callbacks; nothing is published.
   */
  set(key: string, order: number, rows: readonly DropdownItem[]): void {
    const sig = signatureOf(rows);
    const prev = this.entries.get(key);
    this.entries.set(key, { order, rows, sig });
    if (prev && prev.sig === sig && prev.order === order) return;
    this.publish();
  }

  delete(key: string): void {
    if (this.entries.delete(key)) this.publish();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The merged rows — the SAME array until something visible changes. */
  rows = (): DropdownItem[] => this.published;

  private publish(): void {
    const sorted = [...this.entries].sort((a, b) => a[1].order - b[1].order || (a[0] < b[0] ? -1 : 1));
    this.published = sorted.length === 0
      ? NO_ROWS
      : sorted.flatMap(([key, e]) => e.rows.map((row) => this.delegate(key, [], row)));
    for (const listener of [...this.listeners]) listener();
  }

  /** `row`, with each callback calling the latest registered row at the same place. */
  private delegate(key: string, path: readonly string[], row: DropdownItem): DropdownItem {
    if (row.type === 'item') {
      const here = [...path, row.id];
      return {
        ...row,
        onSelect: (modifiers) => {
          const now = this.find(key, here);
          if (now?.type === 'item') now.onSelect?.(modifiers);
        },
        ...(row.submenu ? { submenu: row.submenu.map((sub) => this.delegate(key, here, sub)) } : {}),
      };
    }
    if (row.type === 'checkbox') {
      const here = [...path, row.id];
      return {
        ...row,
        onChange: (v) => {
          const now = this.find(key, here);
          if (now?.type === 'checkbox') now.onChange(v);
        },
      };
    }
    return row;
  }

  /** The row at `path` (ids from the top) among `key`'s latest rows. */
  private find(key: string, path: readonly string[]): DropdownItem | undefined {
    let level: readonly DropdownItem[] | undefined = this.entries.get(key)?.rows;
    let found: DropdownItem | undefined;
    for (const id of path) {
      found = level?.find((r) => (r.type === 'item' || r.type === 'checkbox') && r.id === id);
      if (!found) return undefined;
      level = found.type === 'item' ? found.submenu : undefined;
    }
    return found;
  }
}

interface SlotValue {
  registry: SectionMenuRegistry;
  key: string;
  order: number;
}

const SectionMenuSlotContext = createContext<SlotValue | null>(null);

/** Where one section's menu component registers: its key and its place in the list. */
export function SectionMenuSlot({
  registry,
  slotKey,
  order,
  children,
}: {
  registry: SectionMenuRegistry;
  slotKey: string;
  order: number;
  children: ReactNode;
}): JSX.Element {
  const value = useMemo(() => ({ registry, key: slotKey, order }), [registry, slotKey, order]);
  return <SectionMenuSlotContext.Provider value={value}>{children}</SectionMenuSlotContext.Provider>;
}

/**
 * Hand `rows` to the Properties ≡ menu. Inside a `SectionMenuSlot` the rows
 * are registered (refreshed on every commit, so the menu always calls the
 * latest callbacks) and dropped on unmount, and the answer is `true` — the
 * caller then draws nothing of its own. Anywhere else it is a no-op that
 * answers `false`. `null` withdraws the rows.
 */
export function useSectionMenuRows(rows: readonly DropdownItem[] | null): boolean {
  const slot = useContext(SectionMenuSlotContext);
  // Every commit, on purpose: the callbacks are re-taken each time; the
  // registry republishes only a visible change.
  useEffect(() => {
    if (!slot) return;
    if (rows) slot.registry.set(slot.key, slot.order, rows);
    else slot.registry.delete(slot.key);
  });
  useEffect(() => {
    if (!slot) return undefined;
    return () => slot.registry.delete(slot.key);
  }, [slot]);
  return slot !== null;
}
