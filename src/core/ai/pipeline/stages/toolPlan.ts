import type { PipelineContext } from '../PipelineContext';
import type { ToolPlanOutput } from '../types';
import { toolPlanSchema } from '../schemas/toolPlan';
import type { CallModelFn } from './intent';
import { buildExemplarBlock } from '../../exemplars';

/**
 * Full tool catalogue injected into the Tool Planner prompt so the model
 * knows exactly what tools exist, what they do, and which to prefer.
 */
const TOOL_CATALOGUE = `
## SCENE STRUCTURE — THIS IS HOW A MULTI-SCENE VIDEO IS BUILT
A motion video is a SEQUENCE of scenes, each a distinct moment with its OWN background,
NOT one pile of layers on one background. For EACH storyboard beat emit an add_scene step
FIRST, then that beat's content steps, then the next add_scene, etc.

### add_scene  (emit one per beat)
Opens a timed scene [startSec, startSec+durationSec] with its own full-frame background.
Args: { index (1-based), startSec, durationSec, background? (hex — VARY per scene), transition?: "dissolve"|"cut", style? }
RULES: scenes are chronological; their windows MUST tile the whole composition duration with
no gap or overlap (beat windows come from the Timeline plan); give each scene a DIFFERENT
background so the video visibly changes between scenes.
CRITICAL: every content step (add_title, add_emblem, add_kinetic_title, add_cards, add_lower_third)
MUST pass scene: N naming which scene it belongs to. Content bound to scene N enters at that
scene's start and exits at its end. Content with NO scene tag collapses into one scene — a failed plan.

### add_transition  (optional; emit AFTER all scenes)
Full-frame fade-through-black or white flash centred at a time — punctuation between acts.
Args: { atSec, kind?: "fade_black"|"flash", durationSec? }

## HIGH-LEVEL COMPOSE TOOLS — USE THESE FOR CONTENT
These build a WHOLE correctly-designed element in ONE call. Always prefer these.

### define_style  (emit FIRST when the brief has brand colours / a distinct mood)
Defines this run's custom motion style — palette, type scale, easing personality — derived from the
brief instead of snapping to a preset. Later compose steps that omit style use it.
Args: { name?, brief?, basedOn? ("premium"|"minimal"|"bold"|"playful"|"cyberpunk"|"saas"),
        palette?: { bg?, bgAccent?, card?, fg?, accent?, muted? } (accent alone is enough — the rest derive),
        titlePx?, subtitlePx?, taglinePx?, weightTitle?, weightBody?,
        easing?: "soft"|"overshoot"|"snappy"|"smooth"|"elastic"|"anticipate",
        entranceDur?, staggerSec?, travelPx?, glow? }

### ENTRANCE ARCHETYPES (param on add_title / add_cards / add_emblem / stagger_in)
entrance: "rise" | "scale_pop" | "blur_resolve" | "slide_settle" | "mask_wipe" | "char_cascade"
Omit for a varied auto-pick (each run differs). Set it when a beat calls for a feel:
char_cascade = per-character type-on (text only), blur_resolve = cinematic resolve,
scale_pop = punchy overshoot, slide_settle = directional slide, mask_wipe = clip reveal.
VARY archetypes across the video and let ONE accent element break the pattern deliberately.

### add_background
A single full-composition background (use add_scene instead when building multiple scenes).
Args: { style?, color? }
Styles: premium (Apple-dark), minimal (clean white), bold (saturated), playful (warm pop).
Also accepts: "apple", "luxury", "corporate", "startup".

### add_title
Add a headline, subtitle, or tagline — positioned, animated with a staggered entrance, glow on titles.
Successive calls auto-stagger so nothing appears at once.
Args: { text, level?: "title"|"subtitle"|"tagline", style?, entrance?, y? }
Use this instead of create_layer + set_keyframes for ANY text element.

### add_emblem
Add a glowing circular emblem/badge that scales up with overshoot and pulses — for logos/focal accents.
Args: { style?, entrance?, y?, size? }

### add_cards
Add a centred row of evenly-spaced cards that stagger in (non-uniform rhythm, centre card leads) —
for feature grids, pricing, step sequences.
Args: { count?: 1-8, style?, entrance?, y? }
Returns card ids so you can call add_title to place text on each.

### stagger_in
Give existing layers a staggered entrance with rhythm instead of all appearing at once.
Args: { nodeIds: string[], style?, entrance? }

### add_camera_move
Add a slow cinematic push-in/pull-out across the scene — makes hero shots feel alive and 3D.
Call this AFTER content layers exist. Args: { kind?: "push_in"|"pull_out", style?, durationSec? }

### add_kinetic_title
Word-by-word kinetic typography: each word pops in on a tight beat with overshoot scale + rise.
Use for short punchy phrases (2–8 words) instead of a static add_title. Args: { text, style?, y?, fontSize? }
Returns one layer id per word.

### add_light_sweep
Sweep a soft blurred light bar diagonally across the frame once — the premium "sheen" beat.
Call AFTER content exists; auto-times itself to pass after entrances. Args: { style?, at? }

### add_ambient_orbs
A field of soft blurred accent orbs drifting at background depth (bokeh) — instant atmosphere and
3D parallax under a camera move. Call after add_background, BEFORE content. Args: { count?: 2-10, style? }

### add_lower_third
Broadcast-style lower third (accent bar + title + optional subtitle) sliding in at lower-left —
for speaker names, captions, product labels. Args: { title, subtitle?, style? }

---

## COMPOSE TOOLS ARE SCAFFOLDING, NOT THE FINAL LOOK
A compose tool guarantees craft (layout, stagger, easing, depth). The ART comes from what you do
next: follow compose calls with update_layer / set_keyframes / add_effect / create_mask steps that
restyle fills to the brief's palette, move elements off-centre when the concept wants tension,
retime the rhythm, and break one element out of the pattern deliberately. Two different briefs must
never yield the same-looking plan — vary layout, palette, scale contrast, and pacing from the
SUBJECT and MOOD of the creative brief, not from recipe defaults. When the concept needs motion no
recipe covers (a shape morph, an orbiting ring, a typewriter reveal, a bespoke transition), author
it raw with create_layer + set_keyframes — that is encouraged, not a fallback.

## LOW-LEVEL WRITE TOOLS — use for things compose tools don't cover, and to customize their output

### create_layer
Create a raw layer. Args: { kind: "shape"|"text"|"solid"|"null"|"group"|"camera"|"light"|"adjustment"|"particle", name, x?, y?, width?, height?, text?, shape?: "rect"|"ellipse"|"line"|"star"|"polygon", fill?, parent? }
IMPORTANT: Always pass width and height for shape/solid layers. Always pass x and y.
Role refs use "role:roleName" format — the executor resolves them to real node IDs.

### update_layer
Set static properties. Args: { nodeId, name?, visible?, locked?, text?, fontSize?, fontWeight?, fill?, x?, y?, width?, height?, rotation?, scaleX?, scaleY?, opacity?, threeD?, motionBlur?, blendMode?, matte? }

### set_keyframes
Author animation keyframes. Args: { keyframes: [{ nodeId, prop, t, value, easing?, bezier? }] }
Batch ALL keyframes for a gesture into ONE call (up to 200).
Props: x, y, rotation, scale, scaleX, scaleY, opacity. 3D: z, rotationX, rotationY (threeD must be true).
Easings: linear, easeIn, easeOut, easeInOut, bezier, hold, autoBezier.
Bezier overshoot: [0.34, 1.56, 0.64, 1] for a spring pop.

### reparent_layer
Re-parent a layer. Args: { nodeId, parentId? }

### add_effect
Add an effect to a layer. Args: { nodeId, effect: string, ... }
Effects: blur, glow, drop-shadow, gradient-ramp, fractal-noise, levels, curves, hue-saturation, tint.

### text_animator
Add per-character text animation. Args: { nodeId, ... }

### set_expression
Add a live expression (wiggle, loopOut, time math). Args: { nodeId, prop, expression }
Example: wiggle(2, 8) for organic float. loopOut("cycle") for repeating animation.

### set_easing
Set easing on an existing keyframe. Args: { nodeId, prop, t, easing, bezier? }

### create_mask
Add a mask to clip a layer. Args: { nodeId, shape: "rectangle"|"ellipse", mode?, width?, height?, feather? }

### create_puppet_rig
Rig a layer for organic mesh deformation (After Effects Puppet Pin). Places pins in LAYER-LOCAL
coordinates centered on the origin (x in -width/2..width/2, y in -height/2..height/2); returns pin ids.
Args: { layerId, pins: [{ name, x, y, rotation?, stiffness? }] }
Use for bending/waving/squishing a shape organically (a waving flag, a bending character limb,
a wobbling blob) — things rigid transforms cannot do. Typically 2-5 pins: anchor pins on the part
that stays still, mover pins on the part that bends.
Animate after rigging:
  puppet.<pinId>.position  — via set_puppet_pin_keyframes (see below); moves the pin over time
  puppet.<pinId>.rotation  — via set_keyframes; degrees, rotates the deformation rigidly around the pin
  puppet.<pinId>.stiffness — via set_keyframes; >= 0, sharpens that pin's influence falloff
(Do NOT set_keyframes puppet.<pinId>.position — it is a points data track; use set_puppet_pin_keyframes.)

### set_puppet_pin_keyframes
Animate a puppet pin's POSITION over time (the primary way to make a rig move — waving, walking, bouncing).
Args: { layerId, pinId, keyframes: [{ timeSec, x, y }] }  (x,y in the same layer-local space as create_puppet_rig; linear tween.)
Call create_puppet_rig first; use the returned pin ids.

### create_skeleton_rig
Rig a character or multi-part vector layer with a skeletal hierarchy of bones (After Effects / Spine style).
Args: { layerId, bones: [{ id, parentId?, length, x?, y?, rotation? }] }

### pose_skeleton
Pose and animate character bones over time for kicks, walks, arm swings, and body rotations.
Args: { layerId, bonePoses: [{ boneId, timeSec, rotation, x?, y? }] }

### apply_layer_style
Apply outer glow or drop shadow styling to a layer to create depth, glow, or 3D elevation.
Args: { nodeId, styleType: "drop_shadow"|"outer_glow", color, opacity?, size?, distance?, angle? }

### recolor_lottie_vector
Recursively recolor all vector shape fills inside an imported Lottie or grouped graphic hierarchy.
Args: { nodeId, color }

### create_media
Place an imported asset on the canvas. Args: { assetId, name, x?, y? }

### delete_layer
Delete layers. Args: { nodeIds: string[] }
`;


const EXECUTION_GRAMMAR = `
## STRUCTURE: BUILD THE VIDEO SCENE-BY-SCENE (most important rule)
The Timeline plan gives you N scene windows that tile the whole duration. Emit the plan as:
  add_scene(1, win1.start, win1.duration, bg1) → scene-1 content (each with scene:1) →
  add_scene(2, win2.start, win2.duration, bg2) → scene-2 content (each with scene:2) →
  … → (optional) add_transition steps LAST.
Each add_scene uses that beat's real start/duration from the Timeline plan and a DIFFERENT
background colour. EVERY content step passes scene: N binding it to its scene (enters at that
scene's start, exits at its end) — do NOT hand-schedule times. Only fall back to a single
add_background (no scenes) when the brief is truly one static card.

## AFTER EFFECTS-LEVEL 3D MOTION GRAPHICS & 3D LOGO REVEALS (apply WITHIN each scene)

1. 3D Scene Setup & Layer Depth (Parallax)
   - add_scene opens each beat with its own background (use add_background only for a single-scene piece)
   - Enable 3D switch via update_layer { nodeId, threeD: true } on hero content layers
   - Position elements at distinct Z depths to create genuine 3D spatial parallax:
     * Background: z ≈ 400..600
     * Accent shapes/particles: z ≈ 150..300
     * Hero 3D Logo / Emblem mark: z ≈ 0
     * Headline text: z ≈ -100
     * Subtitle / details: z ≈ -50

2. 3D Logo & Emblem Reveal Techniques
   - Use add_emblem or create_layer kind: "shape" for the 3D logo mark
   - Apply 3D rotation entrance: keyframe rotationY (90° -> 0°) or rotationX (-60° -> 0°) with bezier spring pop [0.34, 1.56, 0.64, 1]
   - Add visual polish: call add_effect for "glow" (intensity 0.6..1.2) and "gradient-ramp" for metallic/neon surfaces
   - Add dynamic floating expression via set_expression: e.g. "value + Math.sin(time*1.8)*6" on y or "value + Math.sin(time*1.2)*3" on rotationY for organic life

3. Kinetic Typography & Hierarchy
   - MUST call add_title at least TWICE (headline + subtitle) for professional typographic scale
   - Set motionBlur: true via update_layer on headline and logo layers
   - Pair 20..40px Y-translation with opacity 0 -> 100 with easeOut for entrances

4. Cinematic 3D Camera Sweep
   - ALWAYS finish with add_camera_move (or create a camera layer) for a slow 3D push-in (dolly z: -800 -> -500)
   - A slow 3D camera move over 3D-depth layers creates stunning After Effects-style parallax

## CRITICAL QUALITY RULES
- STRUCTURE THE VIDEO AS SCENES via add_scene (see top) — a multi-beat storyboard rendered as one
  pile of layers on one background is a FAILED plan.
- ALWAYS pass explicit x, y, width, height on every create_layer call
- ALWAYS set motionBlur: true via update_layer for moving layers
- ALWAYS use non-linear easing (easeOut for entrances, bezier [0.34,1.56,0.64,1] for spring pops)
- Stagger all entrance start times by 0.08–0.15s — simultaneous entrances look mechanical
- Combine transform animation (y offset +20..40px, rotationY) WITH opacity 0→100 for high-end look
`;

export async function runToolPlanStage(
  ctx: PipelineContext,
  callModel: CallModelFn
): Promise<ToolPlanOutput> {
  const systemPrompt = `You are the Lead Technical Execution Planner for a professional motion graphics editor.
Your job: translate the complete creative, motion, layout, camera, and timeline specification into a precise sequence of tool calls.

${TOOL_CATALOGUE}

${EXECUTION_GRAMMAR}

## OUTPUT FORMAT
Produce a JSON object with "executionPlan": an array of steps.
Each step: { stepIndex (1-based integer), tool (exact tool name), purpose (one sentence), args (object), dependsOnSteps (array of step indices this depends on) }
Use "role:roleName" in args where a nodeId is needed — the runtime resolves these to real IDs.
Do NOT invent tool names. Only use tools from the catalogue above.
Do NOT call tools. Output only the JSON.`;

  const userPrompt = `Original User Brief: "${ctx.originalPrompt}"

## Parsed Intent
${JSON.stringify(ctx.intent, null, 2)}

## Creative Vision
${JSON.stringify(ctx.creative, null, 2)}

## Motion Spec (easings, durations, palette)
${JSON.stringify(ctx.motionSpec, null, 2)}

## Storyboard (narrative beats)
${JSON.stringify(ctx.storyboard, null, 2)}

## Scene Plans (per-beat object layout)
${JSON.stringify(ctx.scenePlans, null, 2)}

## Animation Plans (per-beat keyframe timing)
${JSON.stringify(ctx.animationPlans, null, 2)}

## Camera Plans (per-beat camera moves)
${JSON.stringify(ctx.cameraPlans, null, 2)}

## Timeline Plan (scene windows, total duration)
${JSON.stringify(ctx.timeline, null, 2)}

## Composition Context
${ctx.compPreamble}
${buildExemplarBlock(ctx.originalPrompt)}

Now produce the complete execution plan. Structure it SCENE-BY-SCENE with add_scene per Timeline window (different background each), content after each. Prefer compose tools. Follow the execution grammar.`;

  const rawResult = await callModel({
    system: systemPrompt,
    user: userPrompt,
    responseSchema: toolPlanSchema,
    modelTier: 'strong',
  });

  try {
    return JSON.parse(rawResult.trim()) as ToolPlanOutput;
  } catch (err) {
    throw new Error(`Failed to parse Tool Planner stage output as JSON: ${err}`);
  }
}
