/**
 * The tour overlay.
 *
 * jsdom gives every element a zero-area `getBoundingClientRect`, which is not a
 * limitation here so much as the unmounted-anchor case handed to us for free:
 * an anchor with no box is exactly what a closed panel looks like, and the
 * fallback path — centred card, no spotlight, a line saying how to reopen the
 * thing — is the branch most likely to rot unnoticed, because it only appears
 * to users whose layout differs from the developer's.
 *
 * The spotlight geometry itself is not asserted here; it is arithmetic on a
 * DOMRect, and asserting it against jsdom's all-zero rects would pin nothing.
 */

import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { OnboardingOverlay } from './OnboardingOverlay';
import {
  useOnboardingStore,
  TOUR_STEPS,
  resetOnboardingRuntime,
} from '@stores/onboardingStore';

function mount(): { done: jest.Mock } {
  const done = jest.fn();
  render(<OnboardingOverlay onDone={done} />);
  return { done };
}

beforeEach(() => {
  localStorage.clear();
  resetOnboardingRuntime();
  useOnboardingStore.setState({ active: false, index: 0, done: false, autoStarted: false });
});

afterEach(() => {
  cleanup();
  act(() => { useOnboardingStore.getState().skip(); });
});

test('renders nothing while the tour is not running', () => {
  localStorage.setItem('motion-editor.onboarding.seen', 'true');
  mount();
  expect(screen.queryByRole('dialog', { name: 'Welcome tour' })).toBeNull();
});

test('shows the current step, its position in the tour, and its task', () => {
  localStorage.setItem('motion-editor.onboarding.seen', 'true');
  mount();
  act(() => { useOnboardingStore.getState().start(); });

  const first = TOUR_STEPS[0]!;
  expect(screen.getByText(first.title)).toBeTruthy();
  expect(screen.getByText(`Step 1 of ${TOUR_STEPS.length}`)).toBeTruthy();
  expect(screen.getByText(first.action!.hint)).toBeTruthy();
});

test('an anchor with no box falls back to a centred card and says how to reopen it', () => {
  localStorage.setItem('motion-editor.onboarding.seen', 'true');
  mount();
  act(() => { useOnboardingStore.getState().start(); });

  // Nothing in this test renders the toolbar, so the anchor matches nothing.
  expect(screen.getByText(TOUR_STEPS[0]!.whenMissing!)).toBeTruthy();
  const card = screen.getByRole('dialog', { name: 'Welcome tour' }).querySelector('[data-placement]');
  expect(card?.getAttribute('data-placement')).toBe('center');
});

test('Next and Back walk the tour', () => {
  localStorage.setItem('motion-editor.onboarding.seen', 'true');
  mount();
  act(() => { useOnboardingStore.getState().start(); });

  fireEvent.click(screen.getByText('Next'));
  expect(screen.getByText(TOUR_STEPS[1]!.title)).toBeTruthy();
  fireEvent.click(screen.getByText('Back'));
  expect(screen.getByText(TOUR_STEPS[0]!.title)).toBeTruthy();
  // Back is absent on the first step — there is nowhere to go.
  expect(screen.queryByText('Back')).toBeNull();
});

test('the right arrow advances and Escape skips', () => {
  localStorage.setItem('motion-editor.onboarding.seen', 'true');
  const { done } = mount();
  act(() => { useOnboardingStore.getState().start(); });

  fireEvent.keyDown(window, { key: 'ArrowRight' });
  expect(useOnboardingStore.getState().index).toBe(1);

  fireEvent.keyDown(window, { key: 'Escape' });
  expect(useOnboardingStore.getState().active).toBe(false);
  expect(done).toHaveBeenCalled();
});

test('Skip tour ends it and reports back so the flag gets written', () => {
  localStorage.setItem('motion-editor.onboarding.seen', 'true');
  const { done } = mount();
  act(() => { useOnboardingStore.getState().start(); });

  fireEvent.click(screen.getByText('Skip tour'));
  expect(useOnboardingStore.getState().active).toBe(false);
  expect(done).toHaveBeenCalled();
});

test('the last step closes the tour rather than advancing past it', () => {
  localStorage.setItem('motion-editor.onboarding.seen', 'true');
  const { done } = mount();
  act(() => {
    useOnboardingStore.getState().start();
    useOnboardingStore.setState({ index: TOUR_STEPS.length - 1 });
  });

  expect(screen.getByText('Done')).toBeTruthy();
  fireEvent.click(screen.getByText('Done'));
  expect(useOnboardingStore.getState().active).toBe(false);
  expect(done).toHaveBeenCalled();
});

test('nothing outside the card swallows a pointer event', () => {
  // The whole design depends on this: half the steps ask the user to act on the
  // editor WHILE the tour is up. A full-bleed element that takes clicks turns
  // the tour into a slideshow, and it is a one-line CSS regression away.
  localStorage.setItem('motion-editor.onboarding.seen', 'true');
  mount();
  act(() => { useOnboardingStore.getState().start(); });

  const layer = screen.getByRole('dialog', { name: 'Welcome tour' });
  // The card is the only child that opts back in; everything else is decoration
  // and must not be focusable or clickable, which in this markup means it must
  // not contain a control.
  const decorations = Array.from(layer.children).filter((c) => !c.hasAttribute('data-placement'));
  for (const d of decorations) expect(d.querySelector('button, input, a')).toBeNull();
});
