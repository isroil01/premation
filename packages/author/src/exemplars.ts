/**
 * Three scene scripts, converted from the direct loop's exemplars
 * (src/core/ai/exemplars: product_reveal, kinetic_quote, logo_sting).
 *
 * They are what a finished script looks like, not templates: every colour,
 * size, time and ease in them is a decision for THAT brief. The system prompt
 * carries the one closest to the user's prompt, with the instruction to take
 * the structure and nothing else.
 *
 * All three are written for 1920×1080 and must coerce with zero repairs
 * (`exemplars.test.ts`) — an exemplar that needs repairing teaches the repair.
 */

import type { SceneScript } from './types';

export interface AuthorExemplar {
  id: string;
  /** Lowercase keywords matched against the prompt. */
  keywords: readonly string[];
  /** What it demonstrates, in a sentence. */
  lesson: string;
  script: SceneScript;
}

const productReveal: SceneScript = {
  title: 'Aurora X — launch tease',
  intent: 'A cold, quiet tease that resolves into one confident product moment and a clean call to action.',
  durationSec: 10,
  background: '$night',
  palette: { night: '#070b16', deep: '#0d1830', ink: '#eef2ff', mute: '#8a96b8', accent: '#4f8cff', glow: '#9cc2ff' },
  grid: { columns: 12, gutter: 24, margin: 144, baseline: 8 },
  type: {
    display: { family: 'Inter', weight: 700, size: 132, tracking: -4, leading: 0.95 },
    body: { family: 'Inter', weight: 400, size: 34, tracking: 0.6, leading: 1.4 },
  },
  globals: [
    { id: 'backdrop', kind: 'gradient', name: 'Backdrop', role: 'background', gradient: { stops: ['$deep', '$night'], kind: 'radial', centerX: 50, centerY: 40, radius: 120 } },
    {
      id: 'grade', kind: 'adjustment', name: 'Grain and vignette', role: 'ambient', stack: 'front',
      props: { x: 960, y: 540, width: 1920, height: 1080 },
      effects: [
        { type: 'add-grain', params: { intensity: 6, size: 1.2 } },
        { type: 'vignette', params: { amount: 22, size: 90, feather: 120 } },
      ],
    },
  ],
  beats: [
    {
      name: 'Tease', purpose: 'Set the cold mood and promise something.', startSec: 0, endSec: 3.4,
      layers: [
        {
          id: 'tease_line', kind: 'text', name: 'Tease line', role: 'hero', text: 'Something new is coming', typeStyle: 'body',
          props: { x: 960, y: 540, fontSize: 56, fill: '$ink', align: 'center', width: 1400 },
          textAnimators: [{ basedOn: 'words', opacity: 0, blur: 18, y: 24, sweep: { from: 0.3, to: 2.0, ease: 'easeOut' } }],
          keys: { opacity: [{ t: 2.7, v: 100, ease: 'easeIn' }, { t: 3.4, v: 0 }] },
        },
      ],
    },
    {
      name: 'The product', purpose: 'The one loud moment: the mark lands, the name resolves under it.', startSec: 3.4, endSec: 7.6,
      layers: [
        {
          id: 'halo', kind: 'shape', shape: 'ellipse', name: 'Halo', role: 'ambient',
          props: { x: 960, y: 440, width: 520, height: 520, fill: '$accent', opacity: 0, threeD: true, z: 240 },
          effects: [{ type: 'gaussian-blur', params: { blurriness: 120 } }],
          keys: { opacity: [{ t: 0.1, v: 0, ease: 'easeOut' }, { t: 1.2, v: 45 }], scale: [{ t: 0.1, v: 0.7, ease: 'easeOut' }, { t: 2.4, v: 1 }] },
        },
        {
          id: 'mark', kind: 'shape', shape: 'polygon', name: 'Aurora mark', role: 'hero',
          props: { x: 960, y: 440, outerRadius: 120, points: 6, roundness: 18, fill: '$ink', threeD: true },
          effects: [{ type: 'glow', params: { radius: 40, color: '$glow' }, keys: { intensity: [{ t: 0.3, v: 100, ease: 'easeOut' }, { t: 1.4, v: 35 }] } }],
          keys: {
            scale: [{ t: 0.2, v: 0.6, ease: 'bezier', bezier: [0.34, 1.56, 0.64, 1] }, { t: 0.9, v: 1 }],
            opacity: [{ t: 0.2, v: 0, ease: 'easeOut' }, { t: 0.5, v: 100 }],
            rotationY: [{ t: 0.2, v: -40, ease: 'easeOut' }, { t: 1.1, v: 0 }],
          },
        },
        {
          id: 'name', kind: 'text', name: 'Product name', role: 'support', text: 'Aurora X', typeStyle: 'display',
          props: { x: 960, y: 704, fill: '$ink', align: 'center', width: 1200 },
          keys: {
            opacity: [{ t: 0.8, v: 0, ease: 'easeOut' }, { t: 1.3, v: 100 }],
            y: [{ t: 0.8, v: 736, ease: 'easeOut' }, { t: 1.4, v: 704 }],
            letterSpacing: [{ t: 0.8, v: 8, ease: 'easeOut' }, { t: 2.2, v: -4 }],
          },
        },
        {
          id: 'cam', kind: 'camera', name: 'Push', props: { focalLength: 1700 },
          keys: { z: [{ t: 0, v: -1900, ease: 'easeInOut' }, { t: 4.2, v: -1700 }] },
        },
      ],
    },
    {
      name: 'Call to action', purpose: 'Close on the opening tone with one clear line.', startSec: 7.6, endSec: 10,
      layers: [
        {
          id: 'cta', kind: 'text', name: 'Available now', role: 'hero', text: 'Available now', typeStyle: 'display',
          props: { x: 960, y: 520, fontSize: 96, fill: '$ink', align: 'center', width: 1400 },
          masks: [{ shape: 'rectangle', width: 1400, height: 140 }],
          keys: { y: [{ t: 0.2, v: 600, ease: 'easeOut' }, { t: 0.9, v: 520 }], opacity: [{ t: 0.2, v: 0, ease: 'easeOut' }, { t: 0.5, v: 100 }] },
        },
        {
          id: 'rule', kind: 'shape', shape: 'line', name: 'Underline', role: 'support',
          props: { x: 960, y: 610, width: 360, height: 4, stroke: '$accent', strokeWidth: 4 },
          trim: { start: 50, end: 50, keys: { start: [{ t: 0.7, v: 50, ease: 'easeOut' }, { t: 1.3, v: 0 }], end: [{ t: 0.7, v: 50, ease: 'easeOut' }, { t: 1.3, v: 100 }] } },
        },
      ],
    },
  ],
};

const kineticQuote: SceneScript = {
  title: 'Make it move like it means it',
  intent: 'The words are the scenery: a breathing word-by-word read with one accent word that keeps living.',
  durationSec: 8,
  background: '$ink',
  palette: { ink: '#0b0b10', paper: '#f4f1ea', accent: '#ffd23f', dim: '#6d6a63' },
  grid: { columns: 8, gutter: 32, margin: 160, baseline: 12 },
  type: {
    quote: { family: 'Fraunces', weight: 800, size: 120, tracking: -3, leading: 0.98 },
    credit: { family: 'Inter', weight: 500, size: 28, tracking: 3, leading: 1.3 },
  },
  globals: [
    { id: 'paper_noise', kind: 'adjustment', name: 'Paper grain', role: 'ambient', stack: 'front', props: { x: 960, y: 540, width: 1920, height: 1080 }, effects: [{ type: 'noise', params: { amount: 5, monochrome: true }, keys: { evolution: [{ t: 0, v: 0 }, { t: 8, v: 400 }] } }] },
  ],
  beats: [
    {
      name: 'The line', purpose: 'Read the phrase on a breathing beat.', startSec: 0, endSec: 5.6,
      layers: [
        {
          id: 'line_a', kind: 'text', name: 'Make it move', role: 'support', text: 'Make it move', typeStyle: 'quote',
          props: { x: 760, y: 420, fill: '$paper', align: 'left', width: 1200 },
          textAnimators: [{ basedOn: 'words', opacity: 0, y: 40, skew: 12, sweep: { from: 0.2, to: 1.1, ease: 'bezier', bezier: [0.22, 1, 0.36, 1] } }],
        },
        {
          id: 'line_b', kind: 'text', name: 'like it', role: 'support', text: 'like it', typeStyle: 'quote',
          props: { x: 600, y: 560, fill: '$paper', align: 'left', width: 900 },
          textAnimators: [{ basedOn: 'words', opacity: 0, y: 40, sweep: { from: 1.3, to: 1.8, ease: 'easeOut' } }],
        },
        {
          id: 'means', kind: 'text', name: 'means', role: 'hero', text: 'means', typeStyle: 'quote',
          props: { x: 1180, y: 560, fontSize: 168, fill: '$accent', align: 'left', width: 900, anchorX: -300 },
          keys: {
            scale: [{ t: 2.0, v: 0.4, ease: 'bezier', bezier: [0.34, 1.56, 0.64, 1] }, { t: 2.5, v: 1 }],
            opacity: [{ t: 2.0, v: 0, ease: 'easeOut' }, { t: 2.15, v: 100 }],
          },
          expressions: { rotation: 'time > 2.5 ? Math.sin((time - 2.5) * 2.2) * 2 : 0' },
        },
        {
          id: 'it_means', kind: 'text', name: 'it', role: 'support', text: 'it', typeStyle: 'quote',
          props: { x: 760, y: 700, fill: '$paper', align: 'left', width: 600 },
          keys: { opacity: [{ t: 2.9, v: 0, ease: 'easeOut' }, { t: 3.2, v: 100 }], x: [{ t: 2.9, v: 720, ease: 'easeOut' }, { t: 3.4, v: 760 }] },
        },
      ],
    },
    {
      name: 'Credit', purpose: 'A quiet attribution; the quote holds above it.', startSec: 5.6, endSec: 8,
      layers: [
        {
          id: 'credit', kind: 'text', name: 'Credit', role: 'support', text: '— every good animator', typeStyle: 'credit',
          props: { x: 960, y: 880, fill: '$dim', align: 'center', width: 1000 },
          keys: { opacity: [{ t: 0.2, v: 0, ease: 'easeOut' }, { t: 0.8, v: 100 }], letterSpacing: [{ t: 0.2, v: 12, ease: 'easeOut' }, { t: 1.6, v: 3 }] },
        },
      ],
    },
  ],
};

const logoSting: SceneScript = {
  title: 'NOVA ident',
  intent: 'One idea, cleanly: a ring draws itself, the mark pops, a burst punctuates it, the name settles, and it ends.',
  durationSec: 5,
  background: '$black',
  palette: { black: '#0a0a0f', hot: '#ff3d71', white: '#f7f5ff', soft: '#ff9ab5' },
  grid: { columns: 12, gutter: 20, margin: 120, baseline: 8 },
  type: { word: { family: 'Space Grotesk', weight: 700, size: 112, tracking: 18, leading: 1 } },
  globals: [],
  beats: [
    {
      name: 'Sting', purpose: 'Draw, pop, burst, name.', startSec: 0, endSec: 4.4,
      layers: [
        {
          id: 'ring', kind: 'shape', shape: 'ellipse', name: 'Ring', role: 'support',
          props: { x: 960, y: 450, width: 300, height: 300, fillOpacity: 0, stroke: '$hot', strokeWidth: 6, rotation: -90 },
          trim: { end: 0, keys: { end: [{ t: 0.1, v: 0, ease: 'bezier', bezier: [0.65, 0, 0.35, 1] }, { t: 0.9, v: 100 }] } },
        },
        {
          id: 'core', kind: 'shape', shape: 'ellipse', name: 'Core', role: 'hero',
          props: { x: 960, y: 450, width: 190, height: 190, fill: '$hot' },
          effects: [{ type: 'deep-glow', params: { radius: 80, tint: '$soft', tintAmount: 60 }, keys: { exposure: [{ t: 0.8, v: 1.5, ease: 'easeOut' }, { t: 1.8, v: 0 }] } }],
          keys: { scale: [{ t: 0.75, v: 0, ease: 'bezier', bezier: [0.34, 1.56, 0.64, 1] }, { t: 1.2, v: 1 }] },
        },
        {
          id: 'burst', kind: 'shape', shape: 'rect', name: 'Burst ticks', role: 'ambient',
          props: { x: 960, y: 450, width: 6, height: 34, fill: '$white', cornerRadius: 2 },
          repeaters: [{ copies: 12, rotation: 30, anchorX: 0, anchorY: 230, keys: { offset: [{ t: 1.0, v: 0, ease: 'easeOut' }, { t: 1.6, v: 1 }] } }],
          keys: { opacity: [{ t: 0.95, v: 0 }, { t: 1.05, v: 100, ease: 'easeIn' }, { t: 1.9, v: 0 }], scale: [{ t: 1.0, v: 0.8, ease: 'easeOut' }, { t: 1.8, v: 1.25 }] },
        },
        {
          id: 'word', kind: 'text', name: 'NOVA', role: 'support', text: 'NOVA', typeStyle: 'word',
          props: { x: 960, y: 720, fill: '$white', align: 'center', width: 900 },
          textAnimators: [{ basedOn: 'characters', opacity: 0, characterOffset: 12, sweep: { from: 1.4, to: 2.3, ease: 'easeOut' } }],
          keys: { letterSpacing: [{ t: 1.4, v: 48, ease: 'easeOut' }, { t: 2.8, v: 18 }] },
        },
      ],
    },
    {
      name: 'Out', purpose: 'A sting must end, not linger.', startSec: 4.4, endSec: 5,
      layers: [
        { id: 'fade', kind: 'solid', name: 'Fade to black', props: { x: 960, y: 540, width: 1920, height: 1080, fill: '$black' }, keys: { opacity: [{ t: 0, v: 0, ease: 'easeIn' }, { t: 0.5, v: 100 }] } },
      ],
    },
  ],
};

export const AUTHOR_EXEMPLARS: readonly AuthorExemplar[] = [
  {
    id: 'product_reveal',
    keywords: ['product', 'reveal', 'launch', 'promo', 'unveil', 'showcase', 'demo', 'device', 'brand', 'app', 'saas', 'feature'],
    lesson: 'Three beats tile the time; the hero gets the one loud entrance; depth comes from z, a camera push and a blurred halo; grain and vignette sit on top as a front global.',
    script: productReveal,
  },
  {
    id: 'kinetic_quote',
    keywords: ['quote', 'typography', 'kinetic', 'words', 'lyric', 'text', 'phrase', 'saying', 'motivational', 'poem', 'title'],
    lesson: 'Type is the design: a type scale with negative display tracking, words that read on a breathing (non-uniform) beat, one accent word that breaks the pattern and keeps living.',
    script: kineticQuote,
  },
  {
    id: 'logo_sting',
    keywords: ['logo', 'sting', 'ident', 'intro', 'outro', 'bumper', 'mark', 'badge', 'reveal', 'brand'],
    lesson: 'One idea, five moves timed off each other: trim-path draw-on, overshoot pop, repeater burst, character-offset name, a real ending.',
    script: logoSting,
  },
];

/** The exemplar whose keywords best match the prompt (the first on a tie). */
export function selectAuthorExemplar(prompt: string): AuthorExemplar {
  const p = prompt.toLowerCase();
  let best = AUTHOR_EXEMPLARS[0]!;
  let score = -1;
  for (const e of AUTHOR_EXEMPLARS) {
    const s = e.keywords.reduce((n, k) => n + (p.includes(k) ? 1 : 0), 0);
    if (s > score) { best = e; score = s; }
  }
  return best;
}
