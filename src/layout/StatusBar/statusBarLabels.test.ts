import { resolveActiveCompName } from '@layout/Composition/activeCompName';

/**
 * The bar printed the active TAB's title, which is minted once ("Main Comp")
 * and never renamed — beside a comp the user had named "Comp 2".
 */
describe('resolveActiveCompName', () => {
  const tabs = { t1: { compositionId: 'c1', title: 'Main Comp' }, t2: { compositionId: 'c2', title: 'Main Comp' } };
  const comps = { c1: { name: 'Comp 2' }, c2: { name: 'Composition 1' } };

  it("reads the composition's own name, not the tab's stale title", () => {
    expect(resolveActiveCompName({ activeTabId: 't1', tabs, comps })).toBe('Comp 2');
  });

  it('follows a switch to another comp tab', () => {
    expect(resolveActiveCompName({ activeTabId: 't2', tabs, comps })).toBe('Composition 1');
  });

  it('follows a rename', () => {
    const renamed = { ...comps, c1: { name: 'Hero Shot' } };
    expect(resolveActiveCompName({ activeTabId: 't1', tabs, comps: renamed })).toBe('Hero Shot');
  });

  it('never prints a placeholder id as a name', () => {
    const placeholder = { c1: { name: 'c1' } };
    expect(resolveActiveCompName({ activeTabId: 't1', tabs, comps: placeholder }, 'Live Name')).toBe('Live Name');
    expect(resolveActiveCompName({ activeTabId: 't1', tabs, comps: placeholder })).toBe('Main Comp');
  });

  it('falls back to the live composition store with no tab open', () => {
    expect(resolveActiveCompName({ activeTabId: null, tabs, comps }, 'Composition 1')).toBe('Composition 1');
    expect(resolveActiveCompName({ activeTabId: null, tabs, comps })).toBeUndefined();
  });
});
