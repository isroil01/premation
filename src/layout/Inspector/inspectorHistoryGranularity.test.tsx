/**
 * ONE inspector edit = ONE history entry, across the whole inspector.
 *
 * ## Rule 5·0 — the observable, the layer, and the medium
 *
 * The observable is the number of rows the History panel gains from one edit,
 * and the layer that produces it is `HistoryService`'s entry list — fed from
 * TWO independent places: the command a control invokes, and the debounced
 * snapshot `historyStore` captures behind it.
 *
 * The medium has to sample BOTH, and that is the whole reason this bug lived so
 * long. `rigGestureUndo.test.tsx` already asserted "one gesture, one step" for
 * the canvas gestures and was green throughout, because it never wires the
 * snapshot path — with only the command layer live, the count is trivially
 * right. The duplicate only exists when `attachHistoryRecording()` has run, so
 * this suite runs it, exactly as boot does.
 *
 * ## The bug this pins
 *
 * The baseline sync was subscribed at MODULE SCOPE. `Application.boot()` calls
 * `setEventBus(new EventBus())`, so it attached to a bus boot then discarded and
 * never fired once. `lastState` was therefore never refreshed after a command
 * pushed, `statesEqual` compared every capture against a stale baseline and
 * always saw a change, and each commanded edit recorded a generic `Edit N`
 * snapshot ON TOP of the command's own entry. Ctrl+Z took two presses for one
 * gesture, app-wide, and the History panel showed rows for actions nobody took.
 *
 * ## Why the subject set is DERIVED
 *
 * Naming the sections would guard the sections that were named on the day it
 * was written. This is the same failure `conditionalHooks.test.tsx` was rewritten
 * to avoid after `BoneControls` shipped a bug its hardcoded list could not see —
 * the fourth instance on this project. History granularity is a property of
 * EVERY inspector control, so the subjects are read off the directory and a new
 * section is covered the moment it exists.
 *
 * ## Probes that change nothing are excluded, not counted
 *
 * A control fired at that leaves captured state byte-identical records nothing,
 * and 0 is the CORRECT answer there — counting it as a pass would let this suite
 * go green on a build where no probe landed at all. So every probe re-captures
 * state and only probes that provably changed it are asserted on; the positive
 * controls below assert that enough of them did, across more than one section.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { render, cleanup, fireEvent } from '@testing-library/react';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { EventBus, setEventBus } from '@core/events/EventBus';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import { defaultAnimation } from '@motion/animation';
import { sceneProjectIO } from '@core/scene/sceneProjectIO';
import { useHistoryStore, attachHistoryRecording, baselineHistory } from '@stores/historyStore';
import type { SceneNode } from '@core/types';

const ID = 'hist_probe_layer';

/**
 * A layer carrying enough components that many sections have something to edit:
 * a transform, text, a style, and a two-bone skeleton for the rig panels.
 */
function richNode(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`, type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'text', x: 0, y: 0, rotation: 0, width: 200, height: 160, opacity: 100 },
      },
      { id: `${id}_txt`, type: 'Text', props: { content: 'Hi', fontSize: 48, fontFamily: 'Inter' } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#ffffff' } },
    ],
  } as unknown as SceneNode;
}

function discoverSections(): Array<[string, React.ComponentType<{ nodeId: string }>]> {
  const dir = __dirname;
  const out: Array<[string, React.ComponentType<{ nodeId: string }>]> = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.tsx') || file.includes('.test.')) continue;
    const mod = require(path.join(dir, file)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== 'function') continue;
      if (!/^[A-Z]/.test(name)) continue;
      const src = (value as { toString(): string }).toString();
      if (!/nodeId/.test(src)) continue;
      out.push([`${file.replace(/\.tsx$/, '')}.${name}`, value as React.ComponentType<{ nodeId: string }>]);
    }
  }
  return out;
}

const SECTIONS = discoverSections();

/** Entries currently in the undo stack. Non-destructive — never undoes to count. */
function entryCount(): number {
  return getCommandSystem().getHistory().getEntries().length;
}

function captured(): string {
  try {
    return JSON.stringify({ scene: sceneProjectIO.capture(), anim: defaultAnimation.snapshot() });
  } catch {
    return '';
  }
}

interface Probe {
  section: string;
  control: string;
  /** Entries the edit added. Only meaningful when `changed` is true. */
  added: number;
  changed: boolean;
}

/**
 * Fire one realistic edit at `el` and measure what history did.
 *
 * `flush()` stands in for the 700 ms debounce elapsing — it is the same call
 * `performUndo` makes, so this is the real commit path rather than a shortcut
 * around it.
 */
function probeControl(section: string, el: Element): Probe {
  const control = el.getAttribute('aria-label') ?? el.tagName.toLowerCase();
  const before = captured();
  const entriesBefore = entryCount();

  if (el.getAttribute('role') === 'spinbutton') {
    // The resting ValueField: ArrowUp calls onChange(value + step) directly.
    // ArrowDown is the fallback for a field already sitting at its max, where
    // ArrowUp clamps to a no-op and would look like a control that does nothing.
    fireEvent.keyDown(el, { key: 'ArrowUp' });
    if (captured() === before) fireEvent.keyDown(el, { key: 'ArrowDown' });
  } else if (el.tagName === 'SELECT') {
    const sel = el as HTMLSelectElement;
    const other = [...sel.options].find((o) => o.value !== sel.value && o.value !== '');
    if (!other) return { section, control, added: 0, changed: false };
    fireEvent.change(sel, { target: { value: other.value } });
  } else {
    fireEvent.change(el, { target: { value: 'probe-edit' } });
  }

  useHistoryStore.getState().flush();
  return {
    section, control,
    added: entryCount() - entriesBefore,
    changed: captured() !== before,
  };
}

/** Every control in a rendered section that this suite knows how to drive. */
function drivableControls(container: HTMLElement): Element[] {
  return [
    ...container.querySelectorAll('[role="spinbutton"][aria-label]'),
    ...container.querySelectorAll('select[aria-label]'),
    ...container.querySelectorAll('input[aria-label]:not([type="color"])'),
  ];
}

/**
 * Run every section once and collect the probes. Done ONCE, at suite level, so
 * the positive controls and the assertion look at the same measurement.
 */
function collectProbes(): Probe[] {
  const probes: Probe[] = [];
  for (const [name, Section] of SECTIONS) {
    resetWorld();
    let container: HTMLElement;
    try {
      container = render(<Section nodeId={ID} />).container;
    } catch {
      // Rendering is already guarded by conditionalHooks.test.tsx; a section
      // that cannot mount in this harness is out of scope here, not a failure.
      cleanup();
      continue;
    }
    for (const el of drivableControls(container)) {
      // Still attached? An edit can re-render the section and drop the node.
      if (!container.contains(el)) continue;
      try {
        probes.push(probeControl(name, el));
      } catch {
        /* a control that throws is conditionalHooks' subject, not this one */
      }
    }
    cleanup();
  }
  return probes;
}

function resetWorld(): void {
  // A fresh bus per section, then the SAME wiring boot installs. Order matters:
  // this mirrors `Application.boot()` swapping the bus before Providers
  // subscribes, which is the exact sequence the bug lived in.
  setEventBus(new EventBus());
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  defaultAnimation.clear();
  try { defaultSceneGraph.removeNode(ID); } catch { /* fresh */ }
  defaultSceneGraph.addNode(richNode(ID));
  defaultSceneGraph.setSkeleton(ID, {
    bones: [
      { id: 'upper', name: 'Upper', parentId: null, length: 50, x: -60, y: 0, rotation: 0 },
      { id: 'fore', name: 'Fore', parentId: 'upper', length: 50, x: 50, y: 0, rotation: 0 },
    ],
    ikTargets: [{ boneId: 'fore', x: 40, y: 0, chainLength: 2 }],
    controllers: [{ id: 'c1', name: 'Hand', shape: 'circle', side: 'left', size: 14, link: { kind: 'ikTarget', boneId: 'fore' } }],
    meshDensity: 6, meshExpansion: 0,
  } as never);
  useSelectionStore.setState({ ids: [ID] } as never);
  attachHistoryRecording();
  baselineHistory();
}

const PROBES = collectProbes();
const LANDED = PROBES.filter((p) => p.changed);

afterAll(() => {
  cleanup();
  try { defaultSceneGraph.removeNode(ID); } catch { /* already gone */ }
});

describe('the probe set is real', () => {
  it('POSITIVE CONTROL: the directory scan found sections', () => {
    // `describe.each([])` and `[].every(...)` both report as passing.
    expect(SECTIONS.length).toBeGreaterThan(5);
  });

  it('POSITIVE CONTROL: probes actually landed — edits changed captured state', () => {
    // Without this the granularity assertion below is vacuous: a harness where
    // every fireEvent silently missed would show zero violations and pass.
    // This is the check the previous run's invalid `writeProp` probe failed —
    // it recorded 0 entries because the write never landed, and 0 was right.
    //
    // The floor is set near what this actually measures (63 of 70 probes land),
    // not at a token 1: a floor of 1 would stay green while the harness decayed
    // to a single control and would read exactly like a suite that passes.
    expect(LANDED.length).toBeGreaterThanOrEqual(40);
  });

  it('POSITIVE CONTROL: the landed probes span most of the inspector', () => {
    // One section carrying every landed probe would guard one panel and read
    // like it guarded the inspector. Measured spread is 8 sections.
    expect(new Set(LANDED.map((p) => p.section)).size).toBeGreaterThanOrEqual(6);
  });

  it('POSITIVE CONTROL: probes reach the sections that CAN exhibit the bug', () => {
    // The duplicate is specific to COMMANDED edits — an edit with no command
    // only ever took the snapshot path and was always one entry. So a probe set
    // that landed only on uncommanded sections would be broad and blind at the
    // same time. These two are the command-backed rig panels, and they are
    // where all 18 violations appeared when the fix was reverted.
    const landedSections = new Set(LANDED.map((p) => p.section));
    for (const want of ['BoneControls.BoneControls', 'PuppetControls.PuppetControls']) {
      expect({ want, found: landedSections.has(want) }).toEqual({ want, found: true });
    }
  });

  it('POSITIVE CONTROL: the recording mechanism is live in this harness', () => {
    // If `attachHistoryRecording` were wired to nothing here, the snapshot path
    // would be absent and the suite would measure the command layer alone —
    // which is exactly the blind spot that hid this bug for so long. An
    // UNCOMMANDED edit is the tell: only the snapshot path can record it.
    resetWorld();
    const before = entryCount();
    defaultSceneGraph.setSkeleton(ID, {
      bones: [{ id: 'solo', name: 'Solo', parentId: null, length: 20, x: 1, y: 2, rotation: 0 }],
      ikTargets: [], meshDensity: 6, meshExpansion: 0,
    } as never);
    useHistoryStore.getState().schedule('scene');
    useHistoryStore.getState().flush();
    expect(entryCount() - before).toBe(1);
  });
});

describe('one inspector edit is one history entry', () => {
  it('no control adds more than one entry', () => {
    // The failing shape before the fix: `added: 2` — the command's own entry
    // plus a generic `Edit N` snapshot recorded on top of it.
    const violations = LANDED.filter((p) => p.added !== 1)
      .map((p) => `${p.section} › ${p.control} added ${p.added}`);
    expect(violations).toEqual([]);
  });

  it('reports what it measured, so a shrinking probe set is visible', () => {
    // Rule 4d: a suite that quietly stops probing is not a suite that passes.
    // Pinning the section spread and the landed count means a harness that
    // decays into covering one control fails here rather than going green.
    expect({
      probedAtLeast50: PROBES.length >= 50,
      sectionsProbedAtLeast10: new Set(PROBES.map((p) => p.section)).size >= 10,
      landedAtLeast40: LANDED.length >= 40,
      everyLandedProbeIsOne: LANDED.every((p) => p.added === 1),
    }).toEqual({
      probedAtLeast50: true,
      sectionsProbedAtLeast10: true,
      landedAtLeast40: true,
      everyLandedProbeIsOne: true,
    });
  });
});
