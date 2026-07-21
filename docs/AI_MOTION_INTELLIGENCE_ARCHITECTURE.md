# AI Motion Intelligence System — Technical Architecture

**Status:** Design blueprint (2026-07-19)
**Scope:** The intelligence layer that makes the AI think, plan, and create like a senior motion designer — layered on top of the existing motion-editor runtime.
**Principle:** Long-term architecture over short-term hacks. Every subsystem is designed to plug into what already exists, and to degrade gracefully so we can ship it in stages.

---

## 0. Where we start (the foundation that already exists)

This is not a greenfield design. The intelligence system sits on a working runtime, and every subsystem below names its concrete anchor in the current code:

| Foundation | Lives in | Role in the new architecture |
|---|---|---|
| LLM gateway (BYOK, encrypted keys, provider-native SSE, retry) | `motion-back/src/ai/`, `packages/ai-tools/src/providers/` | The raw model access. Agents call through it. |
| Agentic tool loop (look → act → review → answer) | `src/core/ai/AgentLoop.ts` | Becomes the **execution kernel** the agents drive. |
| Typed tool registry (22 tools, 7 read / 15 write) | `packages/ai-tools/src/tools/`, `src/core/ai/toolHandlers.ts` | The **low-level motor cortex**. High-level tools compile down to these. |
| Scene graph + animation engine (keyframes, easing, expressions) | `src/core/scene/`, `packages/animation/` | The substrate everything mutates. |
| Deterministic render + single-frame render | `src/core/rendering/buildSnapshot.ts`, `src/core/export/offlineRenderer.ts` | The **eyes** for the critic and feedback loop. |
| Visual feedback loop (render → model sees → self-correct) | `src/core/ai/renderFeedback.ts` | The seed of the **Quality Critic** subsystem. |
| Undo boundary (one prompt = one reversible act) | `src/core/ai/aiTransaction.ts` | Makes multi-agent editing safe and atomic. |

The design goal: **keep this runtime, and grow a brain on top of it.**

---

## The system as a layered stack

The fifteen requested subsystems are not peers — they form a stack. Data flows down (intent → plan → execution) and feedback flows up (render → critique → learning). Reading the stack top-to-bottom is reading the life of a single prompt.

```
  ┌───────────────────────────────────────────────────────────────┐
  │  L6  MEMORY & LEARNING     Motion Memory · Learning System     │  ← persists across prompts
  ├───────────────────────────────────────────────────────────────┤
  │  L5  ORCHESTRATION         Multi-Agent Director graph          │  ← runs a prompt
  ├───────────────────────────────────────────────────────────────┤
  │  L4  EVALUATION            Quality Critic (scored rubric)      │  ← judges output
  ├───────────────────────────────────────────────────────────────┤
  │  L3  REASONING             Planning Engine · Story · Scene     │  ← decides WHAT to build
  ├───────────────────────────────────────────────────────────────┤
  │  L2  KNOWLEDGE             KB · Knowledge Graph · Recipes ·     │  ← what the AI KNOWS
  │                            Style · Motion Physics              │
  ├───────────────────────────────────────────────────────────────┤
  │  L1  TOOL INTELLIGENCE     High-level motion APIs              │  ← craft-encoding tools
  ├───────────────────────────────────────────────────────────────┤
  │  L0  RUNTIME (exists)      Loop · Tools · Scene · Render · LLM  │  ← the motor cortex
  └───────────────────────────────────────────────────────────────┘
```

The rest of this document details each subsystem with: **Purpose · Responsibilities · Inputs · Outputs · Internal reasoning · Data structures · Relationships · Learning · Scalability · Advantages · Implementation.**

---

# L2 — KNOWLEDGE: what the AI knows

The current failure mode ("not even junior level") is a *knowledge* failure, not a plumbing failure. The model has tools but no codified expertise. L2 is the fix.

## 1. Motion Knowledge Base (KB)

**Purpose.** The canonical store of professional motion-design knowledge — principles, numbers, and rules that are true regardless of the specific brief.

**Responsibilities.** Hold atomic, retrievable, *parameterized* knowledge units (not prose essays): animation principles (anticipation, follow-through, overlap, squash/stretch, staging, secondary action), timing/spacing tables, easing semantics, typographic scales, color theory (contrast ratios, palette construction, 60-30-10), composition (thirds, negative space, visual weight), camera language, motion psychology (what fast/slow/bouncy *communicates*), attention management, brand systems.

**Inputs.** A concept id or a semantic query from a reasoning agent ("how long should a premium entrance be?").

**Outputs.** A knowledge unit: `{ id, principle, appliesWhen, concreteValues, doExample, dontExample, relatedConcepts[] }`.

**Internal reasoning.** None — it is a retrieval store, not a reasoner. Its intelligence is in *curation*: every unit must carry **concrete numbers** ("premium entrance = 0.6–0.9s, easeOut or overshoot bezier [0.34,1.56,0.64,1], 20–40px travel"), because "make it elegant" is useless to a keyframe generator.

**Data structures.** Markdown+frontmatter knowledge cards (git-versioned, human-editable), embedded into a vector index for semantic recall. Each card is small and single-purpose so retrieval is precise.

**Relationships.** Consumed by the Planning Engine, Style Intelligence, Motion Physics, and the Quality Critic (the same numbers that *author* motion also *score* it). Cards reference the Knowledge Graph nodes.

**Learning strategy.** Cards are added/edited by humans first; later the Learning System proposes new cards from observed accepted/rejected patterns (human-approved before they land).

**Scalability.** Flat card files scale to thousands; retrieval is O(1) vector lookup. New domains (3D, character rig) = new card packs.

**Advantages.** Turns "vibes" into numbers; auditable; the single source of truth shared by author and critic so they can't disagree.

**Implementation.** `packages/motion-knowledge/cards/*.md` + a build step producing an embedded index. Start with ~80 cards covering the principles above. The current `SYSTEM_PROMPT` craft section (`buildContext.ts`) is the seed — extract it into cards.

## 2. Motion Knowledge Graph

**Purpose.** Encode the *relationships* the KB can't — that a choice in one dimension constrains others. "Luxury brand" → serif/light type → slow easing → minimal transitions → restrained camera → muted palette. The graph is how the AI reasons about *coherence*.

**Responsibilities.** Represent concepts as typed nodes and directed, weighted relationships, and answer traversal queries ("given mood=luxury and platform=web hero, what typography / easing / camera / palette are consistent?").

**Inputs.** A partial specification (some dimensions fixed). **Outputs.** A coherent completion of the remaining dimensions, with confidence weights and alternatives.

**Internal reasoning.** Constraint propagation over the graph: fix known nodes, propagate along edges, surface the highest-weight consistent assignment plus runner-ups. This is what prevents "random luxury video with a bouncy comic font."

**Data structures.**
```
Node   { id, kind: 'mood'|'style'|'typography'|'easing'|'transition'|'camera'
                    |'palette'|'scenePurpose'|'audience'|'brandPersonality',
         attrs }
Edge   { from, to, relation: 'implies'|'pairsWith'|'conflictsWith'|'intensifies',
         weight 0..1 }
```
Stored as JSON/SQLite adjacency; queried as a small in-memory graph.

**Relationships.** Sits between the KB (facts) and the Planning Engine (decisions). Style Intelligence is essentially a curated subgraph. The Quality Critic uses `conflictsWith` edges to flag incoherent output ("bouncy easing + luxury brand = penalty").

**Learning strategy.** Edge weights are tuned from outcomes: accepted combinations strengthen `pairsWith`; frequently-undone combinations strengthen `conflictsWith`.

**Scalability.** Hundreds of nodes, thousands of edges stay in memory. Graph partitions per domain (UI motion vs cinematic) load on demand.

**Advantages.** Coherence by construction; explainable ("chose slow easing *because* luxury→restraint"); a natural place to encode taste.

**Implementation.** `packages/motion-knowledge/graph/` with a tiny traversal lib. v1 can be hand-authored (~150 nodes). It supersedes the old hard-coded `MotionIntelligence` style table (deleted with v3) — same idea, but a real graph instead of a 6-row switch.

## 3. Motion Recipe Library

**Purpose.** Proven, parameterized *procedures* for building a specific thing well — the difference between knowing principles and knowing *how a pro executes*. This is the highest-ROI knowledge asset.

**Responsibilities.** Store reusable recipes, each a template that compiles to real tool calls given parameters (target layers, palette, timing scale, energy).

**Recipe schema.**
```
Recipe {
  id, name, purpose,
  useWhen[], avoidWhen[],
  params { energy, palette, durationScale, layerRefs, ... },
  steps[]        // parameterized tool-call templates (create/keyframe/effect/camera)
  timing { staggerMs, entranceDur, easing },
  physics        // overshoot/settle profile id (→ Motion Physics)
  layerOrder, camera?, lighting?, particles?,
  variations[]   // named param presets ("subtle" | "bold" | "cinematic")
  commonMistakes[],
  autoImprovements[]   // critic-fixable deltas
}
```

**Inputs.** A recipe id + resolved params (from the Planning Engine). **Outputs.** A concrete `ToolCall[]` batch ready for the execution kernel, plus the rationale.

**Internal reasoning.** A recipe is a pure function `params → ToolCall[]`. The intelligence is in *selection* (Planning Engine chooses which recipe) and *parameterization* (Style + Physics fill params). Recipes encode the craft numbers so the model can't fumble spacing/timing.

**Data structures.** Declarative recipe modules; a registry keyed by `{purpose, style}`; a semantic index so the planner can retrieve "logo reveal, premium."

**Relationships.** Fed params by Style Intelligence + Motion Physics; selected by Planning; compiled to L0 tools; scored by the Critic (which can apply `autoImprovements`). This is also exactly what **Tool Intelligence (#13)** exposes as callable APIs.

**Learning strategy.** New recipes are mined from published/accepted projects (a sequence of tool calls that scored high becomes a candidate recipe, human-curated). Variation weights tune from usage.

**Scalability.** Recipes are independent modules — the library grows without touching the engine. Domains packaged separately (kinetic-type pack, dataviz pack).

**Advantages.** Encodes taste as code; dramatically reduces model error surface; fast (less model authoring); consistent; testable (a recipe's output can be rendered and pixel-checked).

**Implementation.** `packages/motion-recipes/` — start with 8–10: hero-title-entrance, logo-reveal, lower-third, pricing-cards-stagger, feature-section, kinetic-type-line, gradient-hero, product-callout, chart-reveal, scene-transition. Each ships with a render test.

## 6. Motion Physics Engine

**Purpose.** A reusable model of *how things move* so the AI selects motion that has weight and life, not linear slides. Turns "energetic" into actual curves.

**Responsibilities.** Provide named physical motion profiles — easing, overshoot, bounce, elastic, momentum, anticipation, follow-through, secondary motion, weight/inertia, rhythm/pacing — and a selector that maps intent → profile → concrete bezier/keyframe deltas.

**Inputs.** `{ intent: mood/energy, propertyKind: position|scale|opacity|rotation, role: hero|support|accent }`. **Outputs.** A motion profile: easing id or bezier, overshoot amount, settle time, secondary-motion suggestion, stagger interval.

**Internal reasoning.** A parameterized physics model, not per-frame simulation: e.g. overshoot = f(energy), settle = f(weight); anticipation = small counter-move before a strong entrance; follow-through = child/offset elements lag the parent by `k·mass`. Deterministic and closed-form so it compiles straight to keyframes.

**Data structures.** Profile table `{ id, bezier|springParams, overshoot, settleMs, secondaryRule }`; a mapping matrix `intent × propertyKind → profileId`.

**Relationships.** Parameterizes Recipes; consulted by the Planning Engine per element; the Critic scores "does the motion have weight" against these profiles. Extends the existing easing/bezier support in `packages/animation` and the expression engine (`exprLang`) for organic motion (wiggle/inertia).

**Learning strategy.** Profile params tune from accepted vs undone motion (if users consistently soften a profile, its overshoot drifts down).

**Scalability.** Table-driven; new profiles (character-anim, cloth) are new rows. Spring/curve math is cheap.

**Advantages.** Every motion reads intentional; removes the "everything is linear/flat" failure; shared vocabulary between author and critic.

**Implementation.** `packages/motion-physics/`. v1 = ~12 profiles mapped from mood/energy, emitting beziers into `set_keyframes`. Replaces the deleted v3 scalar multipliers with a principled model.

## 7. Style Intelligence

**Purpose.** Translate a named aesthetic (Apple, Linear, Stripe, Swiss, Brutalist, Luxury, Playful…) into concrete, consistent choices across every dimension.

**Responsibilities.** For a given style, resolve: type (family/scale/weight/tracking), spacing rhythm, palette, motion (timing + physics profiles), transitions, camera behavior, particle/effect usage.

**Inputs.** A style id (or a blend + weights) from Planning. **Outputs.** A `StyleToken` bundle — the "house style" for this project (a design-token set).

**Internal reasoning.** A style is a curated *assignment* over the Knowledge Graph's dimensions — effectively a saved subgraph. Blending = weighted interpolation between two token bundles with conflict resolution via `conflictsWith` edges.

**Data structures.**
```
StyleToken {
  type: { family, scale[], weights, tracking },
  color: { bg, fg, accent[], neutrals[] },
  spacing: { unit, rhythm[] },
  motion: { entranceDur, staggerMs, physicsProfileId, easingDefault },
  transitions: [...], camera: {...}, fx: {...}
}
```

**Relationships.** Downstream of the Knowledge Graph; upstream of Recipes and Tool Intelligence (which consume tokens as defaults). The Critic checks output against the active StyleToken for consistency.

**Learning strategy.** New styles added as curated bundles; per-brand overrides learned via Motion Memory.

**Scalability.** Each style is one bundle file; dozens are trivial. Blends computed on demand.

**Advantages.** Consistency by construction (the #1 amateur→pro gap); "make it Apple-style" becomes deterministic; directly fixes the "random colors/sizes/durations" problem.

**Implementation.** `packages/motion-styles/` bundles + a blender. This *is* the "design-token house style" lever — the token set every recipe and default reads from.

---

# L3 — REASONING: deciding what to build

The AI must **never animate immediately.** It reasons first. L3 is the reasoning pipeline.

## 4. Planning Engine

**Purpose.** Convert a raw prompt into a validated, structured **production plan** before a single keyframe exists. This is the spine of the system.

**Responsibilities.** Run the staged pipeline: Intent → Audience → Goal → Platform → Brand → Story → Scenes → Assets → Typography → Animation-language → Camera → Transitions → Timeline → (hand to Execution) → Review → Improve.

**Inputs.** User prompt, attached references, active Motion Memory (brand/prefs), current scene state. **Outputs.** A `ProductionPlan` — a typed, inspectable, editable document.

**Internal reasoning (per stage).**
- *Intent* — classify what the user actually wants (deliverable type, must-haves, constraints). Ambiguity → a clarifying question, not a guess.
- *Audience/Goal/Platform* — infer or ask; these set aspect ratio, duration norms, energy, safe zones.
- *Brand* — pull StyleToken from Memory or derive from references.
- *Story* — choose a structure (see Story Intelligence): hook → value → proof → CTA, etc.
- *Scenes* — decompose the story into scenes with purpose/energy/duration.
- *Assets/Typography* — resolve real assets (`list_assets`) and a type plan from StyleToken.
- *Animation-language/Camera/Transitions* — pick recipes + physics profiles + camera moves per scene.
- *Timeline* — lay scenes on a global timeline with pacing; resolve overlaps and total duration.

Each stage reads L2 (KB/Graph/Style/Physics/Recipes) and writes into the plan. The plan is *validated* (durations sum, contrast passes, no conflicting style edges) before execution.

**Data structures.**
```
ProductionPlan {
  intent, audience, goal, platform, brand: StyleToken,
  story: { structure, beats[] },
  scenes: [ { id, purpose, energy, emotion, durationSec,
              elements[], recipeId, physicsProfile, camera, transitionIn/Out } ],
  timeline: { totalSec, sceneOffsets[] },
  assets[], typography
}
```

**Relationships.** The central document. Reads all of L2; consumed by L5 agents and the Execution kernel; scored by the Critic; diffed by the Learning System (plan vs final accepted edit).

**Learning strategy.** Plans that lead to accepted results reinforce their recipe/structure choices; heavily-edited plans flag weak stages.

**Scalability.** Stages are independent and cacheable; a plan for a 6-scene video is small JSON. Long videos scale by scene, not by keyframe.

**Advantages.** Separates *thinking* from *doing* (the core of the whole ask); inspectable/editable by the user *before* execution (this is also the natural home of "give me options" — variant plans); makes execution cheap and correctable.

**Implementation.** `src/core/ai/planning/` producing a `ProductionPlan`. This is where the promising-but-rigid v3 IntentPlanner/SceneAnalyzer idea is reborn correctly — as an *editable plan that drives a real tool-loop*, not an enum that a lookup table expands.

## 8. Scene Intelligence

**Purpose.** Understand a single scene as a designer does — its purpose, energy, emotion, focal hierarchy, reading order, and reveal/exit timing.

**Responsibilities.** For each scene in the plan: assign a visual hierarchy (primary/secondary/background), a reading order, a focal point, and per-element reveal/hold/exit timing that serves attention.

**Inputs.** A scene spec + its elements + StyleToken. **Outputs.** An annotated scene: `{ elements: [{ id, role, readIndex, revealAt, holdDur, exitAt, emphasis }] }`.

**Internal reasoning.** Hierarchy from size/position/semantic role; reading order from layout (top-left→bottom-right, or explicit flow); reveal timing from hierarchy (hero first, support staggered, accents last) using Motion Physics stagger. Enforces "one focal point at a time" and "lead the eye."

**Data structures.** Per-scene attention model (a small DAG of reveal dependencies).

**Relationships.** Consumes the plan's scene; feeds Recipes and Execution the exact per-element timing; the Critic scores hierarchy/attention against it. Directly prevents the "everything appears at once, overlapping" failure by *assigning distinct positions + staggered reveals structurally*.

**Learning strategy.** Learns typical reveal orders per scene purpose from accepted work.

**Scalability.** Per-scene, bounded by element count.

**Advantages.** Structural fix for the exact symptoms we diagnosed (stacking + simultaneous appearance); makes attention intentional.

**Implementation.** `src/core/ai/planning/scene.ts`. Encodes what the current prompt only *asks* the model to do — here it becomes guaranteed structure.

## 9. Story Intelligence

**Purpose.** Choose and sequence a narrative structure appropriate to the deliverable, so a video *flows* instead of being disconnected animations.

**Responsibilities.** Map deliverable type → story structure, and expand it into scene beats with roles.

**Inputs.** Intent + audience + goal + platform. **Outputs.** `{ structure, beats: [{ role, purpose, targetDur }] }`.

**Internal reasoning.** A library of narrative templates keyed by deliverable:
- Product launch → Hook → Problem → Product → Features → Proof → CTA.
- SaaS demo → Context → Pain → Solution walkthrough → Outcome → CTA.
- Social → Pattern-interrupt → Payload → Loop/CTA (short, high energy).
- Explainer → Question → Build-up → Reveal → Recap.
- Logo/brand → Anticipation → Reveal → Settle → Signature.
Selection considers platform norms (duration, energy) and audience.

**Data structures.** Narrative templates `{ id, deliverable, beats[], pacingCurve }`.

**Relationships.** Feeds the Planning Engine's Story + Scenes stages; pacing curve informs the Timeline; the Critic scores story clarity.

**Learning strategy.** Beat weightings and durations tune from published-video engagement/acceptance.

**Scalability.** Template library; add deliverables as templates.

**Advantages.** Coherent narrative arc; correct pacing per platform; turns "make a launch video" into a structured multi-scene plan automatically.

**Implementation.** `packages/motion-knowledge/story/`. v1 = ~8 structures.

## 14. Motion Design Reasoning (the pipeline in motion)

**Purpose.** Define *how the AI thinks internally* end-to-end — the architectural reasoning flow, not a chain-of-thought transcript.

**Reasoning pipeline for "Create a premium Apple-style product launch":**
1. **Intent** → deliverable=product-launch, style=Apple/premium, no assets attached → note to build from type/shapes or ask for logo.
2. **Memory** → load brand StyleToken if this project has one; else derive Apple-premium tokens from Style Intelligence.
3. **Story** → select Product-Launch structure → 5 beats.
4. **Scenes** → decompose beats → 5 scenes with purpose/energy/duration; Scene Intelligence assigns hierarchy + reveal timing per scene.
5. **Style + Physics** → resolve StyleToken (type scale, muted palette, restrained easing) and physics profiles (soft overshoot, long settle) for "premium."
6. **Recipes** → per scene, select recipes (hero-title-entrance, feature-callout, logo-reveal) and parameterize with tokens+physics.
7. **Camera/Transitions** → add a slow push-in per hero scene; cross-dissolve/scale transitions consistent with style.
8. **Timeline** → lay scenes, resolve total duration to platform norm.
9. **Validate plan** → contrast, durations, style-conflict check → (optionally surface as an editable plan / options to the user).
10. **Execute** → compile recipes → real tool calls through the L0 loop, inside one undo transaction.
11. **Review** → render frames → Quality Critic scores → auto-fix low scores → re-render.
12. **Answer + Learn** → present result + rationale; record plan/edit deltas to the Learning System.

Every arrow is a typed hand-off between subsystems; no stage improvises a keyframe without the plan behind it.

---

# L1 — TOOL INTELLIGENCE: craft-encoding APIs

## 13. Tool Intelligence (high-level motion APIs)

**Purpose.** Stop the model from hand-emitting 40 raw keyframes (where it fumbles spacing/timing) and instead let it call intent-level APIs that *compile* to correct low-level tools.

**Responsibilities.** Expose high-level operations — `CreateHeroReveal`, `AnimatePricingCards`, `BuildFeatureSection`, `RevealLogo`, `StaggerTypography`, `AnimateChart`, `CreateProductLaunch`, `GenerateTimeline` — each backed by a Recipe + Style + Physics, compiling to the existing 22 tools.

**Inputs.** High-level params (`StaggerTypography(layerIds, style='editorial', energy='medium')`). **Outputs.** The same `ToolResult` shape as today, so the loop is unchanged; internally a validated batch of `create_layer/set_keyframes/add_effect/...` calls.

**Internal reasoning.** Each API = recipe selection + parameter resolution from StyleToken/Physics + Scene Intelligence timing → `ToolCall[]` → executed atomically. The model chooses *what* (intent); the API guarantees *how* (craft).

**Data structures.** Same `AiToolDef`/handler contract as the current registry (`packages/ai-tools`), so high-level tools live beside low-level ones and both are available. The model is guided to prefer high-level.

**Relationships.** The compile target of Recipes; the primary surface agents call; still bottoms out in L0 tools and the undo transaction.

**Learning strategy.** Usage + acceptance per API tunes default params; frequently hand-corrected APIs get their defaults adjusted.

**Scalability.** New APIs = new recipe + registration; no engine change. Coexists with raw tools for cases no recipe covers.

**Advantages.** Massive reduction in model error surface (the reliable fix for stacking/simultaneity/flat-motion); fewer model round-trips (fits the step budget); testable per API.

**Implementation.** Register high-level defs in `packages/ai-tools` that call into `packages/motion-recipes`. Keep the 22 primitives as the fallback. This is the concrete, buildable core of the whole vision — start here after the KB/Style/Physics minimum exists.

---

# L4 — EVALUATION: judging the work

## 10. Quality Critic

**Purpose.** Replace "looks good" with a **scored rubric**, so the system can objectively detect and fix weak output — and so we can measure whether changes help.

**Responsibilities.** Given rendered frames + the plan + StyleToken, score the result on: typography, contrast, spacing, motion quality, timing, hierarchy, composition, readability, professionalism, animation quality, camera quality, transitions, visual rhythm, brand consistency, story clarity. Emit per-axis scores + specific, *actionable* defects.

**Inputs.** Rendered frames (from `renderStillFrame`), the ProductionPlan, StyleToken, KB thresholds. **Outputs.**
```
Critique {
  scores: { axis: 0..100 }, overall,
  defects: [ { axis, severity, where: layerId|scene, fix: ToolCall|recipeDelta } ],
  verdict: 'ship' | 'auto-fix' | 'replan'
}
```

**Internal reasoning.** Two channels: (a) *measurable* axes computed programmatically from the scene graph + frames (contrast ratios, element overlap, whether entrances have opacity-from-0 keyframes, stagger intervals, safe-zone violations) — cheap and objective; (b) *perceptual* axes judged by a vision-model pass over the frames against KB rubric anchors. Defects carry a suggested fix (a recipe `autoImprovement` or a specific tool call), so the loop can apply them.

**Data structures.** Rubric definition (axis → measurement method + threshold from KB); the `Critique` object.

**Relationships.** Upgrades the current `renderFeedback.ts` critique from prose to structured scores; feeds fixes back into Execution; feeds scores into the Learning System as a quality signal; uses the same KB numbers the author used (shared truth).

**Learning strategy.** Rubric thresholds calibrate against human accept/reject (if humans ship things the critic scored low, recalibrate); becomes a reward signal for offline tuning.

**Scalability.** Measurable axes are O(scene); perceptual axes are a bounded number of frames. Runs once or twice per generation (bounded, like today's `MAX_CRITIQUES`).

**Advantages.** Objective, improvable, measurable; catches the exact failures we diagnosed *automatically*; gives us a metric to iterate the whole system against.

**Implementation.** `src/core/ai/critic/` — extend `renderFeedback.ts` with the measurable channel first (pure scene-graph checks: overlap, contrast, entrance-present, stagger) since it needs no model and is deterministic; add the perceptual channel second.

---

# L5 — ORCHESTRATION: the multi-agent director

## 5. AI Agent Architecture

**Purpose.** Decompose the work across specialized agents, each expert in one thing, coordinated by a director — because one prompt trying to be creative director + animator + QA at once is exactly why output is mediocre.

**The agents.**

| Agent | Responsibility | Inputs | Outputs |
|---|---|---|---|
| **Creative Director** | Owns intent, story, overall vision; runs the Planning Engine; final arbiter | prompt, memory, references | ProductionPlan |
| **Art Director** | Style, palette, typography, layout coherence | plan, StyleToken | resolved visual spec |
| **Story Planner** | Narrative structure + scene decomposition | intent, audience | story beats + scenes |
| **Motion Director** | Chooses recipes, physics profiles, pacing per scene | scenes, style | per-scene motion spec |
| **Animation Engineer** | Compiles specs → tool calls; drives the L0 loop | motion spec | scene-graph mutations |
| **Camera Director** | Camera moves + 3D depth staging | scenes, style | camera keyframes + z assignment |
| **Typography Expert** | Type scale, kerning, text animators, legibility | text elements, style | type spec + text-animator calls |
| **Visual Reviewer** | Runs the render + reads frames | rendered frames | observations |
| **Quality Critic** | Scores against rubric, proposes fixes | frames, plan | Critique |
| **Learning Agent** | Observes outcomes, updates memory/weights | edits, accept/reject | knowledge deltas |

**How they communicate.** A **shared blackboard** = the `ProductionPlan` + scene graph + a message log. The Creative Director orchestrates as a state machine: plan → (Art/Story/Motion/Camera/Type fill their sections) → Animation Engineer executes → Visual Reviewer + Critic evaluate → fix or ship. Agents don't free-chat; they read/write typed sections of the blackboard. This maps cleanly onto the existing `Workflow`/subagent primitive and the single-undo transaction (the whole multi-agent run = one reversible act).

**Internal reasoning.** Each agent is an LLM call (or deterministic module) with a narrow system prompt + the L2 subsystems it needs. Specialization = smaller context, sharper output, independent testability.

**Data structures.** Blackboard (`ProductionPlan` + scene graph + message log); an orchestration state machine.

**Learning strategy.** Per-agent quality tracked separately, so we learn *which* agent is the weak link.

**Scalability.** Agents run in parallel where independent (Art + Story concurrently); the director serializes only true dependencies. Bounded by the plan, not the timeline.

**Advantages.** Each concern gets full attention; independently improvable/testable; parallelizable; matches how real studios work.

**Implementation.** Orchestrate with the existing `Workflow` engine (deterministic fan-out/pipeline) + subagents. v1 can collapse several roles into one model call and split them as quality demands — the *architecture* is multi-agent even if v1 runs 3 agents.

---

# L6 — MEMORY & LEARNING: getting better over time

## 11. Learning System

**Purpose.** Improve continuously and *safely* from real usage without destabilizing behavior.

**Responsibilities.** Observe signals — user edits after generation, regenerations, undos, accepted vs rejected results, published videos, template usage, Critic scores — and turn them into knowledge deltas (new recipes, tuned graph weights, adjusted physics/style params, new memory).

**Inputs.** Event stream `{ projectId, plan, toolCalls, edits, undos, accepted, criticScores, published }`. **Outputs.** Proposed deltas to KB/Graph/Recipes/Physics/Style — **staged, never auto-applied to global knowledge.**

**Internal reasoning.** Attribute outcome to decisions: a plan+recipe that's accepted with few edits → reinforce; heavily hand-corrected → the correction *is* the lesson (diff the AI's output vs the user's final = a training pair). Aggregate across users for global tuning; keep per-user/brand signals in Motion Memory.

**Data structures.** Event log (append-only); a delta queue with provenance + confidence; a human-review gate for global changes.

**Learning strategy (safety).** Three tiers: (1) per-project memory updates instantly; (2) per-user preferences update with light confirmation; (3) global knowledge changes require human review + are versioned/rollbackable. Never lets one user's taste rewrite everyone's defaults.

**Scalability.** Event log → offline batch tuning; online path only touches project/user memory.

**Advantages.** Compounding quality; the corrections users already make become the training signal for free; safe by construction.

**Implementation.** Event capture in the editor + `motion-back` (the schema already has AiUsage; add an events table). Offline tuning jobs. Gate global deltas behind review. Ties to the existing "activity log" gap noted in production-prep.

## 12. Motion Memory

**Purpose.** Long-term, per-scope memory so the AI feels like it *knows this user and brand* — not amnesiac every prompt.

**Responsibilities.** Remember, at the right scope: brand (logo, palette, type, StyleToken), animation/transition preferences, pacing, audience, previous projects, favorite styles, creative direction.

**Memory hierarchy.**
```
Global defaults        (curated, shared)          ← ships with the product
  └ Style/brand kits   (per workspace/brand)      ← Art Director reads first
      └ Project memory  (this video's decisions)   ← instant updates
          └ Turn memory  (this conversation)        ← the existing chat history
```
Higher scopes are overridden by lower ones (project beats brand beats global).

**Inputs.** Reads at plan time (Creative/Art Directors); writes on accept/publish (Learning Agent). **Outputs.** A resolved context bundle injected into planning.

**Internal reasoning.** On a new prompt, resolve the hierarchy top-down, merge, and hand the Planning Engine a pre-filled brand/preference context so it doesn't re-ask what it already knows.

**Data structures.** Scoped key-value + StyleToken bundles in `motion-back` (Postgres), keyed by workspace/project. The current per-project chat threads are the innermost layer.

**Learning strategy.** Written by the Learning System with scope-appropriate confidence; user can inspect/edit brand memory explicitly.

**Scalability.** Small per-scope documents; loaded on demand.

**Advantages.** Consistency across a brand's videos; less re-asking; the foundation for "make another one like last time."

**Implementation.** Extend `motion-back` with a memory store + `StyleToken` persistence; wire resolution into the Planning Engine. Builds on the existing per-project conversation scoping.

---

# 15. Future-Proof Architecture

The stack is deliberately shaped so new capabilities are *new modules*, not rewrites:

- **3D / Particles / Physics** — already partially in the runtime (camera 3D, particle layers, expression engine); they become new Recipes, Physics profiles, and Camera-Director capabilities. No architectural change.
- **Character animation** — a new KB card pack + Physics profiles (rigging) + recipes; the agent graph gains a Character Director.
- **Audio sync / voice-over** — the Timeline stage gains audio tracks; a new "Audio Director" aligns scene offsets to beats/VO markers. The Planning Engine already owns the timeline.
- **Procedural / generative assets** — a new asset source behind `list_assets`/`create_media`; the plan's Assets stage can request generation.
- **Multi-agent collaboration / real-time / collaborative editing** — the blackboard + single-undo transaction generalize to multi-user; agents become long-lived services.
- **Interactive motion graphics** — an export target + a new recipe/effect class.

Because everything routes through **plan → recipe → high-level tool → L0 primitive**, and knowledge lives in swappable packs, each future capability plugs into a known socket.

---

# Grounded implementation roadmap

Ambition is cheap; sequencing is the architecture. This maps the vision onto what's buildable on the current runtime, each phase shippable and verifiable.

**Phase A — Knowledge foundation (unblocks everything).**
KB cards (extract + expand the current craft prompt) · Style Intelligence tokens (≈6 styles) · Motion Physics profiles (≈12). Deliverable: the model authors from tokens+profiles, not vibes.

**Phase B — Tool Intelligence + Recipes.**
`packages/motion-recipes` (8–10 recipes) exposed as high-level tools. Deliverable: `StaggerTypography`, `CreateHeroReveal`, etc. — the reliable fix for stacking/simultaneity/flat motion, each with a render test.

**Phase C — Planning Engine + Scene/Story Intelligence.**
The `ProductionPlan` pipeline, editable before execution (natural home for "give me options"). Deliverable: the AI plans a multi-scene video before touching a keyframe.

**Phase D — Quality Critic (structured).**
Deterministic measurable axes first (overlap/contrast/entrance/stagger) on top of `renderFeedback.ts`, then perceptual axes. Deliverable: objective scores + auto-fix + a metric to iterate against.

**Phase E — Multi-agent orchestration.**
Split the director roles over the `Workflow` engine. Deliverable: specialized agents, parallel where independent.

**Phase F — Memory + Learning.**
Scoped Motion Memory in `motion-back`; event capture; gated offline tuning. Deliverable: brand consistency + compounding improvement.

**Dependency order:** A → B → (C,D in parallel) → E → F. Knowledge before reasoning before orchestration before learning. Each phase makes the next cheaper and is independently useful.

---

## The one-line thesis

Today the model has *hands* (tools) and now *eyes* (feedback) but no *training*. This architecture gives it **training** (knowledge), **judgment** (reasoning + critic), **specialization** (agents), and **experience** (memory + learning) — while every decision compiles down to the tools and render engine that already work. Build the knowledge first; the intelligence follows.
