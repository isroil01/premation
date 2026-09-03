/**
 * The tour engine.
 *
 * What is actually worth pinning here is the part that is easy to get wrong and
 * impossible to notice: a step's `check` is evaluated against the REAL stores,
 * on a timer, relative to a baseline captured at `start()`. Get the baseline
 * wrong and the tour races to the end on any project that already has content —
 * which looks, from the outside, exactly like "the tour is broken" with no
 * error anywhere. So the baseline cases are the bulk of this file.
 */

import { defaultAnimation } from '@motion/animation';
import {
  useOnboardingStore,
  TOUR_STEPS,
  TOUR_ANCHORS,
  TOUR_POLL_MS,
  canAutoStart,
  resetOnboardingRuntime,
} from './onboardingStore';

const SEEN_LS = 'motion-editor.onboarding.seen';

/** Index of a step by id — the tests should not care where a step sits. */
function stepIndex(id: string): number {
  const i = TOUR_STEPS.findIndex((s) => s.id === id);
  if (i < 0) throw new Error(`no tour step "${id}"`);
  return i;
}

/** Advance the tour to a given step with plain `next()` calls. */
function goTo(id: string): void {
  useOnboardingStore.getState().start();
  for (let i = 0; i < stepIndex(id); i++) useOnboardingStore.getState().next();
}

beforeEach(() => {
  jest.useFakeTimers();
  localStorage.clear();
  // Every track from a previous case, gone — `keyframeCount` reads the shared
  // engine singleton.
  for (const nodeId of defaultAnimation.getAnimatedNodeIds()) {
    for (const track of defaultAnimation.tracksFor(nodeId)) {
      defaultAnimation.removeTrack(nodeId, track.prop);
    }
  }
  resetOnboardingRuntime();
  useOnboardingStore.setState({ active: false, index: 0, done: false, autoStarted: false });
});

afterEach(() => {
  useOnboardingStore.getState().skip();
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('the step list', () => {
  test('every step has a unique id and a non-empty anchor selector', () => {
    const ids = TOUR_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of TOUR_STEPS) {
      expect(s.anchor.length).toBeGreaterThan(0);
      expect(() => document.querySelector(s.anchor)).not.toThrow();
    }
  });

  test('every anchor selector is drawn from the declared vocabulary', () => {
    // The point of `TOUR_ANCHORS` is that the set of things the tour points at
    // is ONE list. A step with an inline selector would defeat that silently.
    const vocabulary = new Set<string>(Object.values(TOUR_ANCHORS));
    for (const s of TOUR_STEPS) expect(vocabulary.has(s.anchor)).toBe(true);
  });

  test('the tour opens on a task and closes on export', () => {
    expect(TOUR_STEPS[0]!.id).toBe('add-shape');
    expect(TOUR_STEPS[0]!.action).toBeDefined();
    expect(TOUR_STEPS[TOUR_STEPS.length - 1]!.id).toBe('export');
  });

  test('every actionable step tells the user what to do', () => {
    for (const s of TOUR_STEPS) {
      if (!s.action) continue;
      expect(s.action.hint.length).toBeGreaterThan(0);
    }
  });
});

describe('navigation', () => {
  test('start opens at the first step', () => {
    useOnboardingStore.getState().start();
    expect(useOnboardingStore.getState()).toMatchObject({ active: true, index: 0 });
  });

  test('back stops at the first step rather than going negative', () => {
    useOnboardingStore.getState().start();
    useOnboardingStore.getState().back();
    expect(useOnboardingStore.getState().index).toBe(0);
  });

  test('next past the last step finishes and persists "seen"', () => {
    useOnboardingStore.getState().start();
    for (let i = 0; i < TOUR_STEPS.length; i++) useOnboardingStore.getState().next();
    expect(useOnboardingStore.getState().active).toBe(false);
    expect(useOnboardingStore.getState().done).toBe(true);
    expect(localStorage.getItem(SEEN_LS)).toBe('true');
  });

  test('skip persists "seen" too — a declined tour is a decision, not a pause', () => {
    useOnboardingStore.getState().start();
    useOnboardingStore.getState().skip();
    expect(useOnboardingStore.getState().active).toBe(false);
    expect(localStorage.getItem(SEEN_LS)).toBe('true');
  });
});

describe('auto-advance', () => {
  test('a keyframe step advances by itself once a keyframe exists', () => {
    goTo('set-keyframe');
    expect(useOnboardingStore.getState().index).toBe(stepIndex('set-keyframe'));

    jest.advanceTimersByTime(TOUR_POLL_MS * 2);
    expect(useOnboardingStore.getState().index).toBe(stepIndex('set-keyframe'));

    defaultAnimation.setKeyframe('tour-node', 'position.x', 0, 0);
    jest.advanceTimersByTime(TOUR_POLL_MS);
    expect(useOnboardingStore.getState().index).toBe(stepIndex('second-keyframe'));
  });

  test('the second-keyframe step needs a SECOND one, not just any', () => {
    goTo('set-keyframe');

    // The keyframe that satisfies step 3 must not also satisfy step 4 — the
    // point of the step is that one keyframe is a value, and two are motion.
    defaultAnimation.setKeyframe('tour-node', 'position.x', 0, 0);
    jest.advanceTimersByTime(TOUR_POLL_MS);
    expect(useOnboardingStore.getState().index).toBe(stepIndex('second-keyframe'));

    jest.advanceTimersByTime(TOUR_POLL_MS * 3);
    expect(useOnboardingStore.getState().index).toBe(stepIndex('second-keyframe'));

    defaultAnimation.setKeyframe('tour-node', 'position.x', 1, 100);
    jest.advanceTimersByTime(TOUR_POLL_MS);
    expect(useOnboardingStore.getState().index).toBe(stepIndex('play'));
  });

  test('a project that ALREADY has keyframes does not skip the keyframe steps', () => {
    // The regression this exists for: with an absolute check ("any keyframe
    // exists"), taking the tour on real work would fly through three steps
    // before the first card had been read.
    defaultAnimation.setKeyframe('existing', 'position.x', 0, 0);
    defaultAnimation.setKeyframe('existing', 'position.x', 1, 50);
    defaultAnimation.setKeyframe('existing', 'opacity', 0, 1);

    goTo('set-keyframe');
    jest.advanceTimersByTime(TOUR_POLL_MS * 4);
    expect(useOnboardingStore.getState().index).toBe(stepIndex('set-keyframe'));
  });

  test('a narration step never advances on its own', () => {
    goTo('inspector');
    expect(TOUR_STEPS[stepIndex('inspector')]!.action).toBeUndefined();
    jest.advanceTimersByTime(TOUR_POLL_MS * 8);
    expect(useOnboardingStore.getState().index).toBe(stepIndex('inspector'));
  });

  test('the poll stops when the tour ends', () => {
    goTo('set-keyframe');
    useOnboardingStore.getState().skip();
    defaultAnimation.setKeyframe('tour-node', 'position.x', 0, 0);
    jest.advanceTimersByTime(TOUR_POLL_MS * 4);
    expect(useOnboardingStore.getState().active).toBe(false);
    // The satisfied check must not have moved anything — a timer that outlives
    // the tour would advance a tour nobody is looking at, and would still be
    // running the next time it opened.
    expect(useOnboardingStore.getState().index).toBe(stepIndex('set-keyframe'));
  });
});

describe('first-run policy', () => {
  test('auto-start is allowed on a clean install', () => {
    expect(canAutoStart()).toBe(true);
  });

  test('a completed or skipped tour never auto-starts again', () => {
    useOnboardingStore.getState().start();
    useOnboardingStore.getState().skip();
    expect(canAutoStart()).toBe(false);
  });

  test('"don\'t show again" is honoured', () => {
    useOnboardingStore.getState().setDontShowAgain(true);
    expect(canAutoStart()).toBe(false);
  });

  test('a boot-time start is retracted when the policy says no', () => {
    // `Providers` starts the tour during boot on its own (looser) condition.
    // The overlay mounting is what applies the full policy, and a retraction
    // must NOT mark the tour seen — it was never shown.
    localStorage.setItem('motion-editor.onboarding.dontShowAgain', 'true');
    useOnboardingStore.getState().start();
    expect(useOnboardingStore.getState().active).toBe(true);

    useOnboardingStore.getState().onEditorMounted();
    expect(useOnboardingStore.getState().active).toBe(false);
    expect(localStorage.getItem(SEEN_LS)).toBeNull();
  });

  test('a start made AFTER the editor mounted is never retracted', () => {
    // Seen already, so mounting neither starts nor retracts anything...
    localStorage.setItem(SEEN_LS, 'true');
    useOnboardingStore.getState().onEditorMounted();
    expect(useOnboardingStore.getState().active).toBe(false);
    // ...and a person choosing Take the Tour afterwards gets it regardless.
    useOnboardingStore.getState().start();
    useOnboardingStore.getState().onEditorMounted();
    expect(useOnboardingStore.getState().active).toBe(true);
  });
});
