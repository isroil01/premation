/**
 * Onboarding tour. A short, first-run walkthrough
 * of the five signature differences. Never a lecture — each step names a real
 * action the user can try. Persisted so it only auto-runs once.
 */

import { create } from 'zustand';

export interface TourStep {
  title: string;
  body: string;
  hint: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    title: 'Welcome to Motion Studio',
    body: 'The VS Code of motion design — fast, calm, keyboard-first. Coming from After Effects? Your muscle memory works here: U/P/S/R/T reveal, Spacebar plays.',
    hint: 'Five things make this faster than AE. Take 60 seconds.',
  },
  {
    title: 'Value fields do math',
    body: 'Every number is a scrubbable slider AND a text field. Drag to adjust, or click and type an expression like 960/2 or *1.5.',
    hint: 'Try it: click any value in the Inspector and type "+15".',
  },
  {
    title: 'Command Palette',
    body: 'Press ⌘⇧P to find anything — commands, layers, compositions, or a timecode. Prefixes: > commands, @ layers, # comps, : time.',
    hint: 'Try it: press ⌘⇧P and type ":3" to jump to 3 seconds.',
  },
  {
    title: 'The Motion Editor',
    body: 'Shape how a value moves with a large, direct curve editor — easing presets, custom bezier handles, and exact numeric input.',
    hint: 'Try it: select an animated layer → the Motion tab.',
  },
  {
    title: 'Focus Mode',
    body: 'Double-click a layer to isolate it — everything else ghosts, and a breadcrumb keeps you oriented. Esc steps back up. Never lose context.',
    hint: 'Try it: double-click a layer in the timeline.',
  },
];

interface OnboardingStore {
  active: boolean;
  step: number;
  aeShortcuts: boolean;
  start: () => void;
  next: () => void;
  back: () => void;
  toggleAe: () => void;
  finish: () => void;
}

export const useOnboardingStore = create<OnboardingStore>((set, get) => ({
  active: false,
  step: 0,
  aeShortcuts: true,
  start: () => set({ active: true, step: 0 }),
  next: () => {
    if (get().step >= TOUR_STEPS.length - 1) { set({ active: false }); return; }
    set((s) => ({ step: s.step + 1 }));
  },
  back: () => set((s) => ({ step: Math.max(0, s.step - 1) })),
  toggleAe: () => set((s) => ({ aeShortcuts: !s.aeShortcuts })),
  finish: () => set({ active: false }),
}));
