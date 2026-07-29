/**
 * F11: `activityFor` must stay in step with the tool registry.
 *
 * It is a hand-maintained switch over tool names, which is a shape that drifts
 * silently in both directions:
 *
 *  • a name it maps that no longer exists is a dead branch nobody will ever see;
 *  • a name it does NOT map falls through to "Working", so the user watches a
 *    generic label while the assistant does the most interesting part of the run.
 *
 * Neither breaks a build or a test, which is why the mapping had drifted. This
 * checks both directions against the live registry.
 */

import { ALL_TOOL_DEFS } from '@motion/ai-tools';
import { __testables } from './useAiChat';

const { activityFor } = __testables;

const REGISTERED = new Set(ALL_TOOL_DEFS.map((t) => t.name));

/**
 * Tools whose generic label is correct.
 *
 * A read tool the user never needs narrated, or a write whose name is already
 * what the label would say. Listing them explicitly is the difference between
 * "we decided this one is fine" and "we forgot this one".
 */
const DELIBERATELY_GENERIC = new Set<string>([
  'list_assets',
  'define_style',
]);

describe('activityFor', () => {
  it('maps no tool that is not registered', () => {
    // Every name in the switch must exist. A branch for a removed tool is dead
    // code that looks like coverage.
    const mapped = __testables.MAPPED_TOOL_NAMES;
    const unknown = mapped.filter((n) => !REGISTERED.has(n));
    expect(unknown).toEqual([]);
  });

  it('gives every mutating tool a real label, not "Working"', () => {
    const generic: string[] = [];
    for (const t of ALL_TOOL_DEFS) {
      if (t.kind === 'read') continue;
      if (DELIBERATELY_GENERIC.has(t.name)) continue;
      if (activityFor(t.name) === 'Working') generic.push(t.name);
    }
    expect(generic).toEqual([]);
  });

  it('labels every read tool as reading', () => {
    for (const t of ALL_TOOL_DEFS) {
      if (t.kind !== 'read') continue;
      if (DELIBERATELY_GENERIC.has(t.name)) continue;
      expect(`${t.name}: ${activityFor(t.name)}`).toBe(`${t.name}: Reading the scene`);
    }
  });

  it('still falls back to "Working" for a name it has never heard of', () => {
    expect(activityFor('some_future_tool')).toBe('Working');
  });
});
