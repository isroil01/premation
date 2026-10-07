/**
 * The fifteen prompts the eval harness runs in both modes.
 *
 * Chosen to cover what the libraries are weakest at as much as what they are
 * good at: brand and product pieces (the caster's home ground), type-led
 * pieces, data, 3D and depth, atmosphere, portrait and square frames, a long
 * and a very short duration. Each has an id the artifacts and fixtures key on;
 * changing a prompt's text invalidates its recorded fixtures, so add a new
 * case rather than editing one.
 */

export interface EvalCase {
  id: string;
  prompt: string;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
}

export const EVAL_CASES: readonly EvalCase[] = [
  { id: 'saas_launch', prompt: 'A 10 second launch teaser for Ledgerly, an invoicing app for freelancers. Calm, confident, a little warm. End on "Get paid on time."', width: 1920, height: 1080, fps: 30, durationSec: 10 },
  { id: 'logo_sting', prompt: 'A 4 second logo sting for a podcast called Night Signal. Moody, electric blue, a radio-wave motif.', width: 1920, height: 1080, fps: 30, durationSec: 4 },
  { id: 'kinetic_quote', prompt: 'Kinetic typography for the quote "Simplicity is the ultimate sophistication." — Leonardo da Vinci. Elegant, editorial.', width: 1920, height: 1080, fps: 30, durationSec: 8 },
  { id: 'data_story', prompt: 'Explain that solar went from 1% to 12% of global electricity in ten years. Clear data animation, optimistic.', width: 1920, height: 1080, fps: 30, durationSec: 12 },
  { id: 'event_promo_vertical', prompt: 'A vertical story ad for a rooftop jazz night on Friday at 8pm. Sunset colours, playful.', width: 1080, height: 1920, fps: 30, durationSec: 8 },
  { id: 'product_3d', prompt: 'Reveal a premium wireless earbud case with real depth: a slow camera push through layered planes, glossy highlights.', width: 1920, height: 1080, fps: 30, durationSec: 8 },
  { id: 'title_sequence', prompt: 'Opening title sequence for a noir detective series called "The Long Rain". Rain, shadows, typewriter type.', width: 1920, height: 1080, fps: 24, durationSec: 12 },
  { id: 'feature_list', prompt: 'Show three features of a fitness tracker: sleep score, heart-rate zones, 7-day battery. Energetic, sporty.', width: 1920, height: 1080, fps: 30, durationSec: 10 },
  { id: 'square_social', prompt: 'A square social post announcing a 30% off spring sale for a plant shop. Fresh, botanical.', width: 1080, height: 1080, fps: 30, durationSec: 6 },
  { id: 'lower_third', prompt: 'A lower third for an interview: Dr. Amara Okafor, Climate Scientist. Clean broadcast style over a dark background.', width: 1920, height: 1080, fps: 30, durationSec: 5 },
  { id: 'abstract_loop', prompt: 'An abstract, hypnotic background loop of flowing gradients and particles for a meditation app.', width: 1920, height: 1080, fps: 30, durationSec: 10 },
  { id: 'countdown', prompt: 'A 5-4-3-2-1 countdown intro for a game stream. Glitchy, neon, high energy.', width: 1920, height: 1080, fps: 60, durationSec: 6 },
  { id: 'brand_manifesto', prompt: 'A 20 second brand manifesto for an outdoor gear company: "Go further. Leave less. Come back changed." Cinematic, grounded.', width: 1920, height: 1080, fps: 24, durationSec: 20 },
  { id: 'app_ui_demo', prompt: 'Demo a to-do app: a task gets checked off, the list reorders, a celebration appears. Friendly product motion.', width: 1920, height: 1080, fps: 60, durationSec: 8 },
  { id: 'ident_bumper', prompt: 'A 3 second channel bumper for a cooking channel called Salt & Ember. Warm, appetising, quick.', width: 1920, height: 1080, fps: 30, durationSec: 3 },
];
