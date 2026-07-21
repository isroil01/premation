# AE Parity — what's left, and in what order

**Date:** 2026-07-16
**Companion to:** `AE_PARITY_AUDIT_2026_07_16.md` (the audit + 9 fix passes)
**State:** Tiers 0–3 of the audit are closed. 163 suites / 1589 tests green; both repos typecheck; production build passes.

Every claim below was re-verified against the code today, not carried over from the audit — several Tier 4 lines were already stale (masks, Glow/Drop Shadow colours, the effect-model ceiling).

---

## The shape of what's left

The bugs are gone. What remains is **breadth** — features AE has that we don't — plus one small cluster of surfaces that still overstate what they do. That's a real change in character: for eight passes the work was "this lies, make it true"; from here it's "this is absent, build it".

Two things are worth separating out, because they're not the same kind of work:

- **Group A** is the last of the old pattern: UI that claims a capability the code doesn't have. Cheap, and it finishes the job the audit started.
- **Groups C–H** are genuine product scope. They're big, they're independent, and they should be *chosen*, not worked through by default.

---

## Group A — surfaces that still overstate themselves (small, high value)

These are the remaining "green tests, dead product" cases. Each is hours, not days.

| # | Thing | State | Why it matters |
|---|---|---|---|
| A1 | **Text editing is dead in Electron** | ✅ **DONE** (pass 10) — on-canvas `TextEditOverlay` replaces `window.prompt`. | Text is the primary content type; it did nothing in the desktop build. |
| A2 | **The RAM-preview cache bar is painted over nothing** | ✅ **DONE** (pass 10) — bar + fake cache removed; a real frame cache is deferred to its own effort. | Told users a frame was cached when it wasn't. |
| A3 | **No preview resolution** | ✅ **DONE** (pass 10) — Full/Half/Third/Quarter, content canvas at `dpr/N`. | The lever for slow preview. |
| A4 | **Z-sorting silently disables** | ✅ **DONE** (pass 10) — now sorts within runs bounded by order-dependent layers. | 3D layers rendered in wrong order silently. |
| A6 | **No Animation menu** | ✅ **DONE** (pass 10) — Animation menu with the F9 family + interpolation. | Discoverability. |
| A5 | **"Sequence Layers" isn't** | ⏳ deferred — staggers *keyframes*; AE offsets layer *bars*. | Same name, different feature (a small feature, not a lie). |
| A7 | **Layer markers absent** | ⏳ deferred — `scope: 'layer'` has zero occurrences. | Additive feature. |
| A8 | **Per-layer quality / collapse transformations** | ⏳ deferred — type-only. | Additive feature. |

**The honesty core (A1–A4, A6) is done.** Nothing in the product actively misleads any more. A5/A7/A8 are genuine small features rather than lies, and can be picked up alongside Group H (shell breadth) or on demand.

---

## Group B — audio ✅ DONE (pass 11)

Every MP4/WebM was silent. Now: shared offline mixer (`core/audio/audioMixdown.ts`, `OfflineAudioContext` → WAV, gain/trim mirror the live engine); MP4 bundles `audio.wav` in the frames zip and ffmpeg muxes AAC; WebM feeds a live track to MediaRecorder. Verified with real samples in a browser (440 Hz tone → correct waveform/gain/trim). GIF stays silent (no audio track). **The ffmpeg + MediaRecorder muxes weren't run end-to-end (backend down, no UI export run) — the mixer core is proven; those two wirings are straightforward.**

---

## Group C — the effect catalogue (large, now unblocked)

We ship **14 effects vs AE's ~300**. The single-scalar ceiling is gone (pass 6), so these are now ordinary work: add a def with typed params, add a render pass.

Ordered by value:
1. **Levels** ✅ (pass 12), **Hue/Saturation** ✅ (pass 13, both backends), **Curves** ✅ (pass 14, with a draggable curve editor), **Tint** ✅ + **Channel Mixer** ✅ (pass 15, both backends via a new Canvas2D matrix pixel pass), **Posterize** ✅ (pass 16, LUT) — plus a reusable per-pixel colour-LUT pipeline and a multi-param colour-matrix path. **The colour-grade category is now complete.**
2. **Sharpen, Echo, Posterize Time**
3. **Fill / Stroke / 4-Colour Gradient / Beam**
4. **Keying (Keylight)** — big on its own.
5. **Noise & Grain, Transitions, Particles (CC Particle World)** — each substantial.

**Effort:** 1–2 effects per pass for the simple ones; Keylight and particles are a pass each minimum. **The LUT pipeline (pass 12) unblocks every per-channel colour effect** — Curves, Channel Mixer, Tint-via-LUT are now small.

---

## Group D — 3D depth (large)

Lights are `{color, intensity, radius}` with **no `type` field**, so parallel/spot/point/ambient don't exist; no shadows. Also missing: orientation, anchor Z (`matrix4.ts` supports it — the sole caller passes 0), material options, two-node cameras, POI, zoom, DOF, aperture, camera tools (orbit/pan/dolly — numeric entry only), real 3D intersection (currently a centroid painter's sort that pops on crossover), extrusion, C4D renderer.

**Note:** `light.ts` is honest about its scope ("True 3D material-response lighting is out of scope for a 2D compositor"). Going further is a **deliberate expansion of what this app is**, not a gap-fill. Worth a decision, not a default.

---

## Group E — paint & rotoscoping (very large)

Brush, Clone Stamp, Eraser, Roto Brush, Puppet Pin — all absent. (`src/core/paint/` is a false lead: it's vector fill/stroke styling.)

This is a raster pipeline the app does not currently have. **Multiple passes, and a real architectural commitment.**

---

## Group F — WebGL2 completeness (large, engine)

The gap is *reported* rather than closed (pass 3): `capabilities.ts` picks the right backend per document and tells the user what won't render. WebGL2 had **no matte concept in `FrameScene`, no light pass, no adjustment pass, and a hardcoded font**.

**Font ✅ (pass 17)** and **Lights ✅ (pass 18)** — both reduced to the existing textured-quad path (app-layer, no renderer-package change) and are verified real-pixels through the WebGL2 backend. Font: full family/weight/style/size/spacing/align/multi-line. Lights: a screen-blended radial-gradient quad, Canvas2D-identical (intensity 50 → 158 vs Canvas2D's 159). **Remaining:** adjustment layers and track mattes — these genuinely need a real `CompositionPass` render-to-texture step (mirroring Canvas2D's `applyAdjustment`/`drawMatted`), not just a quad. Plus GPU can't run the LUT colour effects (Levels/Curves/Posterize).

Until those close, a document using both mattes and Fractal Noise cannot render at full fidelity on either backend. **Order of attack: adjustment layers next (full-screen re-composite of the accumulated colour target through the effect stack, structurally like the existing `EffectPass`/`SCENE_COLOR_TARGET`), then track mattes (hardest — a matte source's alpha multiplied into the matted layer, a new `Renderable` field + composite step).**

---

## Group G — project & footage breadth (medium)

Bins/folders, footage interpretation (alpha/fps/pulldown/loop), proxies, placeholders, replace footage, Collect Files, Reduce/Consolidate, image-sequence import, PSD/AI layered import, Increment & Save, templates, ProRes.

The Project panel (pass 8) gives folders somewhere to live. **Image-sequence import and Increment & Save are the cheap, high-use wins here.**

---

## Group H — shell breadth (medium)

Preview panel, Info panel, live VU meter, Region of Interest, RGB channel views (only rgb↔alpha today), viewer snapshot, multi-view 3D layouts, floating panels (`PanelUndocked` is declared and never emitted), Layer/Footage panels.

Mostly independent, mostly a pass each.

---

## Recommended order

1. **Group A** — finish the audit's work. The product stops overstating itself anywhere. *(1 pass)*
2. **Group B: audio** — export produces a deliverable with sound. *(2 passes)*
3. **Then a choice**, because these diverge and shouldn't be defaults:
   - **C (effects)** — most visible AE parity per hour, now that the ceiling is gone.
   - **F (WebGL2)** — removes the "neither backend is complete" caveat; unblocks the GPU effects on real documents.
   - **G/H (breadth)** — makes the app feel finished rather than more capable.
   - **D/E (3D, paint)** — genuine scope expansions; worth deciding deliberately.

**My recommendation: A → B → F → C.** A and B close the last honesty and delivery gaps. F removes a caveat that currently taints every export decision. C is then pure additive value on a model that can hold it.

**Progress: A (honesty core) ✅, B (audio) ✅, and the whole Group C colour-grade cluster ✅ (Levels, Hue/Saturation, Curves, Tint, Channel Mixer — passes 10–15) are done. Next up: the non-colour effect catalogue (Sharpen / Echo / Fill / Stroke / Keylight …), or F (WebGL2 completeness) — a real engine project best scoped together.**
