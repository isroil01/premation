/**
 * Few-shot exemplars — six curated, compact tool-call transcripts showing what
 * PROFESSIONAL structure looks like: scene tiling, palette definition via
 * define_style, non-uniform staggering, entrance archetype choices, and one
 * deliberate asymmetry per piece. An intent-keyed retriever injects the 1–2
 * most relevant into the authoring prompt.
 *
 * These are references to EMULATE, not scripts to copy — the notes on each
 * call say WHY, so the model transfers the reasoning, not the literals.
 * Each exemplar stays well under ~1.5k tokens.
 */

export interface Exemplar {
  id: string;
  title: string;
  /** Keywords the retriever matches against the user prompt (lowercase). */
  keywords: readonly string[];
  /** What this exemplar demonstrates, in one sentence. */
  lesson: string;
  /** Ordered annotated tool calls: [toolName, args, why]. */
  transcript: readonly (readonly [string, Record<string, unknown>, string])[];
}

export const EXEMPLARS: readonly Exemplar[] = [
  {
    id: 'product_reveal',
    title: 'Product reveal (10s, 3 scenes)',
    keywords: ['product', 'reveal', 'launch', 'promo', 'unveil', 'showcase', 'demo', 'phone', 'device', 'brand video'],
    lesson: 'Three scenes tile the duration; the style is derived from the brief; the hero gets the loudest entrance and everything else defers to it.',
    transcript: [
      ['define_style', { brief: 'sleek tech launch, accent #4f8cff', easing: 'soft', basedOn: 'premium' }, 'palette from the BRIEF, not a preset default'],
      ['add_scene', { index: 1, startSec: 0, durationSec: 3.5, background: '#070b16' }, 'act 1: tease'],
      ['add_ambient_orbs', { count: 4 }, 'depth before content'],
      ['add_kinetic_title', { text: 'Something new is coming', scene: 1 }, 'short tease line, word-beat'],
      ['add_scene', { index: 2, startSec: 3.5, durationSec: 4, background: '#0a1226' }, 'act 2: the product'],
      ['add_emblem', { scene: 2, entrance: 'scale_pop', y: 420 }, 'HERO: loudest entrance in the piece'],
      ['add_title', { text: 'Aurora X', scene: 2, entrance: 'blur_resolve', y: 700 }, 'name resolves quietly under the hero — supporting motion is smaller'],
      ['add_light_sweep', { at: 5.2 }, 'sheen right after the hero lands'],
      ['add_scene', { index: 3, startSec: 7.5, durationSec: 2.5, background: '#070b16' }, 'act 3: close on the opening tone'],
      ['add_title', { text: 'Available now', scene: 3, entrance: 'mask_wipe' }, 'CTA gets a different archetype than the name — variety is deliberate'],
      ['add_camera_move', { kind: 'push_in' }, 'continuous life across all scenes'],
    ],
  },
  {
    id: 'kinetic_quote',
    title: 'Kinetic-typography quote (8s)',
    keywords: ['quote', 'typography', 'kinetic', 'words', 'lyric', 'text animation', 'phrase', 'saying', 'motivational'],
    lesson: 'Typography IS the design: one phrase carries the piece, one word is the accent (bigger, recoloured), and the rhythm breathes instead of ticking.',
    transcript: [
      ['define_style', { basedOn: 'bold', palette: { accent: '#ffd23f' }, easing: 'overshoot' }, 'punchy personality chosen for the words'],
      ['add_background', { color: '#0b0b10' }, 'single scene — the words are the scenery'],
      ['add_kinetic_title', { text: 'Make it move like it means it', fontSize: 110 }, 'words land on a breathing beat (auto non-uniform)'],
      ['update_layer', { nodeId: '<word "means">', fill: '#ffd23f', fontSize: 150 }, 'ONE accent word breaks the pattern — asymmetry on purpose'],
      ['set_expression', { nodeId: '<word "means">', prop: 'rotation', expression: 'Math.sin(time*2.2)*2' }, 'the accent alone keeps living after landing'],
      ['add_title', { text: '— every good animator', level: 'tagline', entrance: 'slide_settle', y: 760 }, 'attribution enters differently and quietly'],
      ['add_camera_move', { kind: 'pull_out', durationSec: 8 }, 'slow release frames the whole line'],
    ],
  },
  {
    id: 'feature_cards',
    title: 'Feature cards grid (12s, 3 scenes)',
    keywords: ['feature', 'cards', 'grid', 'pricing', 'steps', 'benefits', 'saas', 'tiers', 'plans', 'list'],
    lesson: 'Cards are scaffolding: label them, restyle one as the highlighted tier, and give the row a lead card — never leave a compose call untouched.',
    transcript: [
      ['define_style', { basedOn: 'saas', palette: { accent: '#6366f1' } }, 'product-UI personality'],
      ['add_scene', { index: 1, startSec: 0, durationSec: 3, background: '#090d16' }, 'intro states the promise'],
      ['add_title', { text: 'Three plans. Zero friction.', scene: 1, entrance: 'char_cascade' }, 'type-on suits a product voice'],
      ['add_scene', { index: 2, startSec: 3, durationSec: 6, background: '#0d1322' }, 'the cards get the longest scene'],
      ['add_cards', { count: 3, scene: 2, entrance: 'rise' }, 'row shares ONE archetype; centre card auto-leads with more travel'],
      ['add_title', { text: 'Pro', scene: 2, level: 'subtitle', y: 430 }, 'label placed over the centre card'],
      ['update_layer', { nodeId: '<centre card>', fill: '#1e2a5e' }, 'highlighted tier reads as THE choice — contrast, not symmetry'],
      ['apply_layer_style', { nodeId: '<centre card>', styleType: 'outer_glow', color: '#6366f1', size: 24 }, 'glow only on the accent'],
      ['add_scene', { index: 3, startSec: 9, durationSec: 3, background: '#090d16' }, 'close'],
      ['add_title', { text: 'Start free today', scene: 3, entrance: 'scale_pop' }, 'CTA pops — the one loud beat of the outro'],
    ],
  },
  {
    id: 'logo_sting',
    title: 'Logo sting (5s, single scene)',
    keywords: ['logo', 'sting', 'ident', 'intro', 'outro', 'brand mark', 'bumper', 'signature', 'watermark'],
    lesson: 'A sting is ONE idea executed cleanly: draw-in, pop, name, sheen, out — five beats, no filler, everything timed off the emblem.',
    transcript: [
      ['define_style', { brief: 'confident studio ident, accent #ff3d71', easing: 'overshoot' }, 'personality from the brand adjective'],
      ['add_background', { color: '#0a0a0f' }, 'stings are single-scene'],
      ['add_logo_reveal', { text: 'NOVA', shape: 'ellipse' }, 'trim-path draw → emblem pop → title, pre-choreographed'],
      ['add_radial_burst', { x: 960, y: 430 }, 'burst punctuates the emblem landing — one accent, once'],
      ['add_light_sweep', { at: 2.6 }, 'sheen after the name settles'],
      ['add_transition', { atSec: 4.6, kind: 'fade_black', durationSec: 0.5 }, 'clean out — a sting must END, not linger'],
    ],
  },
  {
    id: 'stat_counter',
    title: 'Stat / number counter (9s, 3 scenes)',
    keywords: ['stat', 'stats', 'number', 'counter', 'metric', 'kpi', 'percent', 'growth', 'milestone', 'report', 'infographic'],
    lesson: 'Numbers need context beats around them; the count-up is an expression (not 60 keyframes) and the number is the only big thing on screen.',
    transcript: [
      ['define_style', { basedOn: 'minimal', palette: { accent: '#34d399' } }, 'data wants restraint + one signal colour'],
      ['add_scene', { index: 1, startSec: 0, durationSec: 2.5, background: '#0f1115' }, 'setup: the claim'],
      ['add_title', { text: 'This year we grew', scene: 1, entrance: 'blur_resolve' }, 'quiet entrance sets up the payoff'],
      ['add_scene', { index: 2, startSec: 2.5, durationSec: 4, background: '#101820' }, 'payoff scene'],
      ['create_layer', { kind: 'text', name: 'BigNumber', text: '0%', x: 960, y: 480, fontSize: 220 }, 'the number is the hero — biggest element in the piece'],
      ['update_layer', { nodeId: 'role:BigNumber', fill: '#34d399', fontWeight: 800 }, 'signal colour reserved for the number alone'],
      ['set_expression', { nodeId: 'role:BigNumber', prop: 'scale', expression: '1 + Math.min(1,(time-2.5)/2.2)*0.08' }, 'the number swells as it counts'],
      ['add_title', { text: '312% revenue growth', scene: 2, level: 'tagline', y: 700, entrance: 'slide_settle' }, 'caption confirms the exact figure'],
      ['add_scene', { index: 3, startSec: 6.5, durationSec: 2.5, background: '#0f1115' }, 'close'],
      ['add_title', { text: 'And we are just starting', scene: 3, entrance: 'rise' }, 'resolve on the opening tone'],
    ],
  },
  {
    id: 'cinematic_title',
    title: 'Cinematic title (8s, 2 scenes)',
    keywords: ['cinematic', 'title', 'film', 'trailer', 'epic', 'movie', 'teaser', 'dramatic', 'opening'],
    lesson: 'Cinematic = restraint + time: long eases, letterbox masks, one slow camera, and a title that RESOLVES rather than pops.',
    transcript: [
      ['define_style', { basedOn: 'premium', easing: 'soft', entranceDur: 1.1, staggerSec: 0.18, glow: true }, 'slower tokens ARE the genre'],
      ['add_scene', { index: 1, startSec: 0, durationSec: 4.5, background: '#05070d' }, 'act 1: atmosphere before words'],
      ['add_ambient_orbs', { count: 6 }, 'dust-like depth'],
      ['create_layer', { kind: 'solid', name: 'Letterbox Top', x: 960, y: 60, width: 1920, height: 120, fill: '#000000' }, 'letterbox bars sell the frame'],
      ['create_layer', { kind: 'solid', name: 'Letterbox Bottom', x: 960, y: 1020, width: 1920, height: 120, fill: '#000000' }, ''],
      ['add_title', { text: 'THE LONG WAY HOME', scene: 1, entrance: 'blur_resolve' }, 'a cinematic title RESOLVES out of blur'],
      ['add_title', { text: 'a film by Mara Chen', scene: 1, level: 'tagline', entrance: 'rise' }, 'credit enters later and smaller'],
      ['add_scene', { index: 2, startSec: 4.5, durationSec: 3.5, background: '#070a12', transition: 'cut' }, 'hard cut — cinematic grammar'],
      ['add_title', { text: 'SPRING 2027', scene: 2, entrance: 'mask_wipe' }, 'date wipes on, held long'],
      ['add_camera_move', { kind: 'push_in', durationSec: 8 }, 'one continuous slow push across both scenes'],
    ],
  },
];

/** Score = keyword hits (whole-word-ish, case-insensitive). */
function scoreExemplar(promptLc: string, ex: Exemplar): number {
  let score = 0;
  for (const kw of ex.keywords) {
    if (promptLc.includes(kw)) score += kw.includes(' ') ? 2 : 1;
  }
  return score;
}

/** The 1–2 most relevant exemplars for a prompt (empty when nothing matches). */
export function selectExemplars(prompt: string, max = 2): Exemplar[] {
  const lc = prompt.toLowerCase();
  return EXEMPLARS.map((ex) => ({ ex, score: scoreExemplar(lc, ex) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, max))
    .map((s) => s.ex);
}

function renderExemplar(ex: Exemplar): string {
  const steps = ex.transcript
    .map(([tool, args, why], i) => `${i + 1}. ${tool} ${JSON.stringify(args)}${why ? `  // ${why}` : ''}`)
    .join('\n');
  return `### ${ex.title}\nLesson: ${ex.lesson}\n${steps}`;
}

/**
 * A prompt block with 1–2 relevant exemplars, or '' when none apply. Injected
 * into the authoring context so the model sees the SHAPE of professional work
 * (structure, palette definition, asymmetry) before it plans.
 */
export function buildExemplarBlock(prompt: string, max = 2): string {
  const picked = selectExemplars(prompt, max);
  if (!picked.length) return '';
  return (
    '\n\nREFERENCE EXEMPLARS — professional structure to EMULATE (structure, pacing, asymmetry), never to copy verbatim. ' +
    'Your palette, text, and layout must come from THIS brief:\n' +
    picked.map(renderExemplar).join('\n\n')
  );
}
