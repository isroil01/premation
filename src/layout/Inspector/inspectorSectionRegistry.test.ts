/**
 * Every inspector section is either IN the registry or explicitly hosted.
 *
 * ## The failure this exists to catch
 *
 * A section component is easy to write and easy to strand. It compiles, it has
 * its own tests, it renders correctly when something mounts it — and nothing
 * ever mounts it. That is exactly how the Plugins panel shipped invisible
 * (`onDemandPanelsReachable.test.ts` is the same guard one level up), and the
 * inspector is more exposed than the dock was: the order used to live inside a
 * 280-line `items.push()` chain, so "is this section reachable" could only be
 * answered by reading the whole function and holding it in your head.
 *
 * Now it is a question about an array. `INSPECTOR_SECTIONS` names the
 * components it renders, so a section is reachable iff it appears there — or
 * iff it is a section another section EMBEDS, which is a real and different
 * thing (a Face Materials block inside Material, an Audio Waveform inside Shape
 * Effects). Those get named below, with their host, so "not registered" is a
 * decision on the record rather than an omission nobody noticed.
 *
 * ## Identity, not names
 *
 * The subjects are compared by FUNCTION IDENTITY against what the registry
 * actually holds, not by grepping the registry source for a string. A test that
 * matches text would pass on a stale import, on a name that appears only in a
 * comment, and on a component imported and then never used.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { INSPECTOR_SECTIONS } from './inspectorSections';

/**
 * Sections that are deliberately NOT top-level registry entries, and what
 * mounts each one instead.
 *
 * Adding a name here is the escape hatch, and it is meant to cost a sentence:
 * if you cannot say what hosts the section, it is stranded and the registry is
 * where it belongs.
 */
const EMBEDDED: Readonly<Record<string, string>> = {
  // Inside another inspector section.
  AudioEffectsSection: 'AudioControls (the Audio Settings section)',
  AudioWaveformSection: 'ShapeEffects (the shape Audio Waveform section)',
  CompOverridesSection: 'PrecompControl (the Pre-composition section)',
  FaceMaterialsSection: 'MaterialSection',
  StylePresetsSection: 'LayerStylesWithPresetsSection (the Layer Styles section)',
  TransformSection: 'TransformWithThreeDSection (the Transform section, with the 3D switch)',
  // Mounted by a panel other than the inspector accordion.
  AlignSection: 'AlignPanel — dedicated dock panel',
  ClonerSection: 'EffectControlsPanel — attached from Effects ▸ Simulation',
  PhysicsSection: 'EffectControlsPanel — attached from Effects ▸ Simulation',
  TrackMotionSection: 'TrackerPanel — dedicated dock panel',
  // Not scoped to the selected layer at all, so it cannot be a registry entry:
  // this belongs to the applied mograph, not to a node.
  MographParamsSection: 'PropertiesPanel — the inspector extras strip below the accordion',
};

/**
 * Every `*Section` component exported from a file in this directory.
 *
 * Read from disk rather than imported statically, for the reason
 * `conditionalHooks.test.tsx` records at length: a hardcoded subject list is a
 * guard that silently stops covering whatever is added next, and it reads
 * exactly like a guard that passes.
 *
 * Uppercase initial only, so the `hasXSection` predicates that live beside
 * their sections are not mistaken for components.
 */
/**
 * `InspectorSection` is the SHELL every section is drawn in, not a section. It
 * matches the name pattern and nothing else about it fits — it takes no
 * `nodeId`, it is mounted by the renderer rather than by the registry, and
 * "register the wrapper" is not a fix anyone would want. Named here rather
 * than pattern-dodged so the exclusion is one line with a reason on it.
 */
const NOT_A_SECTION = new Set(['InspectorSection']);

function discoverSectionComponents(): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const file of readdirSync(__dirname)) {
    if (!file.endsWith('.tsx') || file.includes('.test.')) continue;
    const mod = require(path.join(__dirname, file)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== 'function') continue;
      if (!/^[A-Z][A-Za-z0-9]*Section$/.test(name)) continue;
      if (NOT_A_SECTION.has(name)) continue;
      out.push([name, value]);
    }
  }
  return out;
}

/**
 * Sections that NOTHING mounts. This is debt, written down.
 *
 * Separate from `EMBEDDED` on purpose: an embedded section is a design
 * decision, and one of these is a component nobody can reach. Both were found
 * by this suite the day it was written, which is the argument for the suite —
 * each had a host once, each lost it in a change that touched only the host,
 * and neither failure was visible from anywhere.
 *
 * Neither is deleted here because deleting a component is a behaviour decision
 * with an owner, and this change was a refactor with a no-behaviour-change
 * rule. Fixing one means either mounting it again or removing it; leaving it
 * in this list forever is the option that is NOT fine.
 */
const UNMOUNTED: Readonly<Record<string, string>> = {
  TextSection:
    'Superseded by CharacterPanel, which renders the same font / size / tracking / ' +
    'leading controls as a dock tab. Nothing imports this. Either delete it or make ' +
    'the Character panel render it, so the two cannot drift.',
  VersionHistorySection:
    'Used to render in the Properties panel extras strip beside the mograph and ' +
    'template fields; only a comment in Providers.tsx still refers to it. Local ' +
    'version history has no surface in the app while this is unmounted.',
};

const SUBJECTS = discoverSectionComponents();
const REGISTERED = new Set<unknown>(INSPECTOR_SECTIONS.map((s) => s.Component));

describe('the discovery found real subjects', () => {
  it('POSITIVE CONTROL: enumerating the directory is not returning nothing', () => {
    // Without this, a rename or a moved directory would empty the list and
    // every assertion below would pass having checked nothing.
    expect(SUBJECTS.length).toBeGreaterThan(15);
  });

  it('the registry itself is not empty, and every row names a component', () => {
    expect(INSPECTOR_SECTIONS.length).toBeGreaterThan(10);
    for (const def of INSPECTOR_SECTIONS) {
      expect({ id: def.id, hasComponent: typeof def.Component === 'function' })
        .toEqual({ id: def.id, hasComponent: true });
    }
  });
});

describe.each(SUBJECTS)('%s is accounted for', (name, component) => {
  it('is registered, explicitly hosted elsewhere, or a KNOWN unmounted section', () => {
    const registered = REGISTERED.has(component);
    const how = registered
      ? 'INSPECTOR_SECTIONS'
      : name in EMBEDDED
        ? `hosted by ${EMBEDDED[name]}`
        : name in UNMOUNTED
          ? 'KNOWN UNMOUNTED (see the UNMOUNTED map)'
          : 'NOTHING MOUNTS IT';
    // Reported alongside the boolean so a failure says WHAT to do — register
    // it, name its host, or admit it is stranded — rather than just "false".
    expect({ name, accountedFor: how !== 'NOTHING MOUNTS IT', how })
      .toEqual({ name, accountedFor: true, how });
  });
});

describe('the exemption lists do not rot', () => {
  it('name only sections that still exist', () => {
    const known = new Set(SUBJECTS.map(([n]) => n));
    const stale = [...Object.keys(EMBEDDED), ...Object.keys(UNMOUNTED)].filter((n) => !known.has(n));
    expect(stale).toEqual([]);
  });

  it('do not excuse a section that IS registered', () => {
    // A name in both places is a stale exemption: the section became reachable
    // and the note claiming otherwise outlived the reason for it.
    const registeredNames = SUBJECTS.filter(([, c]) => REGISTERED.has(c)).map(([n]) => n);
    const bothWays = registeredNames.filter((n) => n in EMBEDDED || n in UNMOUNTED);
    expect(bothWays).toEqual([]);
  });

  it('do not overlap each other', () => {
    const both = Object.keys(EMBEDDED).filter((n) => n in UNMOUNTED);
    expect(both).toEqual([]);
  });

  it('POSITIVE CONTROL: the unmounted list is not silently absorbing the directory', () => {
    // If this ever trips, sections are being stranded faster than they are
    // being fixed and the guard has become a ledger of failures.
    expect(Object.keys(UNMOUNTED).length).toBeLessThanOrEqual(3);
  });
});
