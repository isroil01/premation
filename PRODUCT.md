# Product

## Register

product

## Platform

web

## Users

The primary user is a **professional motion designer** — someone who currently lives in After Effects, Cavalry, Motion, or Rive and carries years of muscle memory. They arrive fluent: they expect solo/lock/reveal on layers, precomps, scrubbable timelines, keyframe interpolation, and keymaps that echo the tools they came from. They are in a focused authoring task, often for hours, on a desktop with a real pointer and keyboard. They do not need to be taught what a timeline is; they need one that is faster, non-destructive, and gets out of their way.

A secondary, code-adjacent audience — technical artists and plugin authors — matters because the whole system is built to be extended, but the interface is designed first for the working motion designer.

## Product Purpose

Motion Editor is a document-centric, non-destructive motion design application: a scene graph, a timeline, and GPU compositing, in the class of After Effects / Blender / Rive / Resolve. What sets it apart is that it is **AI-native** — an assistant can read the document and propose typed, reversible edits through the exact same command path the user's own actions travel, never by re-authoring opaque blobs. Success is a professional choosing this over the tool they already know because it is faster, cleaner, and because the AI is a trustworthy collaborator on their real project rather than a black box.

## Positioning

The motion tool where AI edits your actual document — every change typed, undoable, and yours to refine. The AI is not a separate mode or an export target; it drives the same reversible command system the user does, so nothing it does is ever unaccountable or unrecoverable.

## Brand Personality

Powerful, technical, and serious — a professional instrument, not a creative toy. The voice is precise and confident: it assumes expertise, names things exactly, and never pads. But seriousness here is carried by precision and capability, not by visual noise. The current build already expresses this — calm near-black surfaces, a single blue accent, one reserved coral playhead, elevation by value rather than borders — and that restraint is the personality, not a departure from it. Power the user can feel; clutter they never see.

## Anti-references

Not a playful consumer creative app (Canva and its lineage): no bubbly shapes, sticker-bright multicolor, or template-first flows. That register reads as unserious to this audience.

Equally, not a cluttered legacy pro tool: no walls of tiny buttons, no nested toolbars competing for attention, nothing that shows everything at once. The trap for a serious instrument is overwhelming density; the answer is complexity revealed on demand, calm by default. (The timeline already models this — one quiet row per layer that expands into per-property keyframes only when asked.)

## Design Principles

The tool disappears into the task. A working motion designer should feel the software's power through what they can do, not through how much chrome is on screen. Restraint is the brand, not a constraint on it.

AI acts on the real document, reversibly. Every AI edit is a typed command on the same undoable path as a human edit — visible, attributable, recoverable. Trust is earned by making the AI accountable, never by making it flashy.

Earn every unit of density. This is an information-rich instrument, but density must be justified by the task in front of the user and revealed progressively. Serious, never cluttered — the two are not the same thing.

Respect the muscle memory. The audience carries deep habits from AE, Motion, and Rive. Honor established professional conventions and affordances instead of reinventing standard interactions for novelty; surprise is a cost here, not a feature.

Precision is the promise. Correctness and reversibility are the top quality attribute of the whole system, and the interface must read the same way: exact controls, deterministic behavior, no ambiguity about what an action will do.

## Accessibility & Inclusion

As built, the system commits to two specific accommodations that must be preserved. Layer-category colors are colorblind-safe and always paired with an icon shape, so meaning never rests on hue alone. And a full `prefers-reduced-motion` path collapses non-essential UI animation to instant transitions system-wide. Contrast should hold to WCAG AA for body text against the dark and light timeline/chrome surfaces. No specific WCAG conformance level has been formally committed beyond these; treat AA as the working floor and confirm before claiming more.
