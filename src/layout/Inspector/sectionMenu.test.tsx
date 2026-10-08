/**
 * The section-menu registry: how a section's actions reach the Properties ≡
 * menu without a header button — and without bringing back the v0.8.1 loop.
 *
 * The loop is the reason for the registry's two rules, and each case below
 * pins one of them:
 *
 *   • it publishes a NEW list only when something a reader can see changed,
 *     so re-registering on every render (which every menu host does) leaves
 *     the panel's memo — and the dock hand-off behind it — at rest;
 *   • the published rows call the LATEST registered callbacks, so the stable
 *     list never runs a stale closure (the previous layer's apply).
 */

import { act, cleanup, render } from '@testing-library/react';
import type { DropdownItem } from '@components/Dropdown';
import { SectionMenuRegistry, SectionMenuSlot, signatureOf, useSectionMenuRows } from './sectionMenu';

afterEach(cleanup);

const NO_MODS = { shift: false, alt: false, ctrl: false, meta: false } as never;

/** A section's one submenu row, as the preset menus register it. */
function presets(label: string, apply: (name: string) => void, names: readonly string[]): DropdownItem[] {
  return [{
    type: 'item',
    id: `presets-${label}`,
    label: `${label} Presets`,
    submenu: names.map((n): DropdownItem => ({ type: 'item', id: `apply-${n}`, label: n, onSelect: () => apply(n) })),
  }];
}

/** Choose `path` (row labels from the top) in a published list. */
function choose(rows: readonly DropdownItem[], path: readonly string[]): void {
  let level: readonly DropdownItem[] | undefined = rows;
  let row: DropdownItem | undefined;
  for (const label of path) {
    row = level?.find((r) => r.type === 'item' && r.label === label);
    level = row?.type === 'item' ? row.submenu : undefined;
  }
  if (row?.type !== 'item') throw new Error(`no row ${path.join(' ▸ ')}`);
  row.onSelect?.(NO_MODS);
}

describe('the registry', () => {
  it('lists every section’s rows in section order, whatever order they registered in', () => {
    const reg = new SectionMenuRegistry();
    reg.set('light', 2, presets('Light', () => {}, ['Key']));
    reg.set('transform', 1, presets('Transform', () => {}, []));
    expect(reg.rows().map((r) => (r.type === 'item' ? r.label : r.type))).toEqual(['Transform Presets', 'Light Presets']);
  });

  it('hands back the SAME list when rows are registered again looking the same', () => {
    const reg = new SectionMenuRegistry();
    let published = 0;
    reg.subscribe(() => { published += 1; });
    reg.set('transform', 0, presets('Transform', () => {}, ['A']));
    const first = reg.rows();
    // Every render re-registers fresh closures — nothing a reader can see moved.
    reg.set('transform', 0, presets('Transform', () => {}, ['A']));
    reg.set('transform', 0, presets('Transform', () => {}, ['A']));
    expect(reg.rows()).toBe(first);
    expect(published).toBe(1);
  });

  it('publishes again when a visible row changes, and when a section leaves', () => {
    const reg = new SectionMenuRegistry();
    reg.set('transform', 0, presets('Transform', () => {}, ['A']));
    const before = reg.rows();
    reg.set('transform', 0, presets('Transform', () => {}, ['A', 'B']));
    expect(reg.rows()).not.toBe(before);
    reg.delete('transform');
    expect(reg.rows()).toEqual([]);
  });

  it('runs the LATEST callback behind a row whose look did not change', () => {
    const reg = new SectionMenuRegistry();
    const applied: string[] = [];
    // Layer A's menu, then layer B selected: the same labels, new closures.
    reg.set('transform', 0, presets('Transform', (n) => applied.push(`A:${n}`), ['Soft']));
    const stable = reg.rows();
    reg.set('transform', 0, presets('Transform', (n) => applied.push(`B:${n}`), ['Soft']));
    expect(reg.rows()).toBe(stable);
    choose(stable, ['Transform Presets', 'Soft']);
    expect(applied).toEqual(['B:Soft']);
  });

  it('compares what a reader sees: labels, checks and structure — not callbacks', () => {
    const a: DropdownItem[] = [{ type: 'checkbox', id: 'x', label: 'X', checked: false, onChange: () => {} }];
    const b: DropdownItem[] = [{ type: 'checkbox', id: 'x', label: 'X', checked: false, onChange: () => { /* other */ } }];
    const c: DropdownItem[] = [{ type: 'checkbox', id: 'x', label: 'X', checked: true, onChange: () => {} }];
    expect(signatureOf(a)).toBe(signatureOf(b));
    expect(signatureOf(a)).not.toBe(signatureOf(c));
  });
});

function Rows({ rows, onAnswer }: { rows: DropdownItem[] | null; onAnswer: (inSlot: boolean) => void }): null {
  onAnswer(useSectionMenuRows(rows));
  return null;
}

describe('useSectionMenuRows', () => {
  it('registers inside a slot, refreshes on re-render and withdraws on unmount', () => {
    const reg = new SectionMenuRegistry();
    let inSlot: boolean | null = null;
    const applied: string[] = [];
    const view = render(
      <SectionMenuSlot registry={reg} slotKey="transform" order={0}>
        <Rows rows={presets('Transform', (n) => applied.push(`first:${n}`), ['Soft'])} onAnswer={(v) => { inSlot = v; }} />
      </SectionMenuSlot>,
    );
    expect(inSlot).toBe(true);
    expect(reg.rows()).toHaveLength(1);
    view.rerender(
      <SectionMenuSlot registry={reg} slotKey="transform" order={0}>
        <Rows rows={presets('Transform', (n) => applied.push(`second:${n}`), ['Soft'])} onAnswer={(v) => { inSlot = v; }} />
      </SectionMenuSlot>,
    );
    act(() => choose(reg.rows(), ['Transform Presets', 'Soft']));
    expect(applied).toEqual(['second:Soft']);
    view.unmount();
    expect(reg.rows()).toEqual([]);
  });

  it('is a no-op outside a slot, so a host can draw its own control there', () => {
    let inSlot: boolean | null = null;
    render(<Rows rows={presets('Transform', () => {}, [])} onAnswer={(v) => { inSlot = v; }} />);
    expect(inSlot).toBe(false);
  });
});
