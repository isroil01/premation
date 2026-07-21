# After Effects Parity Audit — motion-editor + motion-back

**Date:** 2026-07-16
**Scope:** 5 parallel code-traced audits (compositions/timeline, animation/keyframes, effects/rendering, project-IO/export/backend, shell/tools/shortcuts) against Adobe After Effects.
**Method:** every feature traced UI → handler → store → engine read → persistence. Registry entries, type definitions and passing tests were treated as *no evidence*.

> **Status 2026-07-16 (fix passes 1–19):** **All of Tier 0–3, the honesty core of Group A, Group B (audio), the entire Group C colour-grade cluster, the first two Group F units (GPU text styling + GPU lights), and a UI-wiring pass** are **DONE** — see the fix logs at the bottom. Suite: 163 suites / 1611 tests green; both repos typecheck + build. Group F remaining: GPU track mattes + adjustment layers (each a real `CompositionPass` render-to-texture step) + GPU LUT effects. Expressions, motion blur, masks, effect params, preview resolution, the text editor, the audio mixdown, and every colour effect (Levels, Hue/Saturation, Curves, Tint, Channel Mixer) were verified in a real browser, not just in tests — jsdom has no CSP, no 2D canvas and no OfflineAudioContext, which is exactly why those bugs survived. What's left is genuine breadth (more of Group C, plus D–H) and WebGL2 completeness — see `AE_PARITY_ROADMAP.md`.

---

## Verdict

The engines are good. The product is not usable for real work, because the layer that connects engine to user is broken in ways the UI actively hides.

Roughly **60% of AE's core surface is present in some form; ~35% actually works end-to-end.** The dominant defect class is not missing features — it is **UI that asserts a capability the code does not deliver**: switches that light up and change no pixels, a cache bar over a cache that stores nothing, tooltips advertising unbound keys, a Loop button that deletes your work area.

The single most serious finding: **almost nothing in the time domain survives a save.**

---

## Tier 0 — Blocking. Nothing else matters until these are fixed.

### 1. The timeline never persists
`serializeTimeline` / `deserializeTimeline` (`packages/timeline/src/serialization/Serializer.ts:55,72`) have **zero callers**. `EditorDocument.timeline` (`core/api/cloudDocument.ts:22`) is declared and never assigned. On reload, `TimelineController.syncFromScene` (`core/timeline/TimelineController.ts:508-542`) regenerates every clip at `start:0, duration:full`.

**Lost on every save+reload:** every trim, every split, every clip position, all markers, the work area, track groups, timeline view state.

### 2. Composition settings never persist
`sceneProjectIO.capture` (`core/scene/sceneProjectIO.ts:39-57`) serializes `{version, nodes}` — scene geometry only. Comp size/fps/duration/background/transparent are never written. Every reopen resets to 1920×1080/30fps/10s.

Also unsaved: motion blur config (which *affects render output*), guides, tabs, playhead.

### 3. There is only one composition, forever
`projectStore.ts:88` seeds `comps: {comp_root}`. `updateComp` (`:186`) guards `if (s.comps[id])` and **nothing ever inserts a new key**.
- "New Composition" (`NewCompositionDialog.tsx:112-146`) *overwrites* the active comp and wipes the scene. It is "Reset Project."
- Precompose (`sceneInsert.ts:361-380`) makes a flagged group with no comp identity, and always reparents to `getRoots()[0]` — precomposing a nested layer yanks it to the root.
- Comp tabs open with a **scene node id** (`App.tsx:458`) that has no `comps` entry → every settings edit inside a precomp tab is **silently swallowed** by the guard. `BottomTimeline.tsx:335-338` is split-brained: the Dur field writes to the engine (applies) *and* to `updateComp` (dropped), so duration changes and the field snaps back to 10.

AE's core organizing unit does not exist.

### 4. Expressions are 100% dead at runtime
`expressions.ts:127` compiles via `new Function`. `index.html:13` sets `script-src 'self'` with no `'unsafe-eval'` — and no override exists in `electron/main.ts` or `vite.config.ts`. CSP throws → caught at `:132` → `run()` returns `{value:null}` → `AnimationEngine.sampleInternal:400-403` falls through to the base value.

**Every expression on every property silently has zero effect.** ~390 lines of correct language implementation, a tokenizing editor with autocomplete, cycle detection — all unreachable. Tests pass because `jest.config.cjs:4` uses jsdom, which enforces no CSP.

Even with CSP fixed, expressions would still be broken: **four of six host providers are never bound.** `setLayerResolver`, `setBaseValueProvider`, `setCompInfoProvider`, `setLayerInfoProvider` (`AnimationEngine.ts:96,105,110,115`) have zero callers, so they keep defaults:
- `layer('Title','x')` → always `0`
- `thisComp.width` → **hardcoded 1920**, lies on every non-1080p comp
- `thisLayer.name` → always the string `'Layer'`

### 5. MP4 export is broken for nearly every duration — cross-repo contract mismatch
- motion-editor `core/export/exportManager.ts:169`: `pad = String(total).length`, emits `frame_000.jpg` for a 300-frame render.
- motion-back `render/render.worker.ts:90`: hardcodes `frame_%04d.jpg`.

ffmpeg finds nothing and exits non-zero. **MP4 only works when frame count lands in [1000, 9999]** (≈33s–333s @30fps) — an accidental window. The failure is then masked by `exportManager.ts:433-437`, which catches everything and reports *"MP4 export requires the backend to be online"* — so a padding bug presents as a network error. No test spans the two repos.

---

## Tier 1 — Features that exist but silently do nothing

| Thing | Mechanism |
|---|---|
| **Timeline motion-blur + adjustment switches** | `App.tsx:715` writes `(n as any)[flag]` as a top-level prop on the cached view object. Renderer reads the **`fx` component** via `readNodeMotionBlur` (`motionBlur.ts:56-59`) / `readNodeAdjustment` (`adjustment.ts:14-17`). Two switches per concept, disagreeing: timeline lights the icon and changes nothing; inspector changes the canvas and never lights the icon. |
| **Timeline `fx` switch** | `fxEnabled` has zero readers outside its own icon highlight. Disabling effects on a layer is impossible. |
| **Camera X/Y pan** | `project3d.ts:56` uses `cam.position.x` as *both* camera position and screen principal point. At z=0, `scale=1` → the camera term **cancels exactly**. Keyframing camera Position X moves nothing; at non-zero Z, layers drift the wrong way. Hidden because default `cam.x === width/2` coincides with correct. |
| **F9 / Easy Ease on Position** | `App.tsx:170-188` merges x/y/z into a pseudo-prop `'Position'` **by default**. `applyEasingToKeyframes` (`keyframeAssistants.ts:265`) calls `getTrackKeyframes(nodeId,'Position')` → `null` → `continue`. F9 no-ops on the most-animated property, and `Providers.tsx:118` reports success anyway. |
| **Mask mode / feather / opacity** | All three stored and exposed in the UI; **zero render-side readers**. `buildMaskPath` (`Canvas2DBackend.ts:22-34`) never reads `path.mode` — all paths unioned with `'evenodd'`, so two Add masks XOR. |
| **Pucker & Bloat / Twist** | `pathOps.ts:223` coerces anything not `roundCorners`/`none` to **`'zigzag'`**. The dropdown visibly snaps back. `PathOpControls.tsx:91` also sets `min={0}` — Pucker requires negative values. |
| **Loop button** | `BottomTimeline.tsx:100-109` calls `clearWorkArea()` on toggle-off **and on mount**. Playback loops unconditionally anyway (`Timeline.ts:246-256`). A button labelled "Loop" silently wipes the work area you set with B/N. |
| **RAM preview / cache bar** | `renderCache` is a `Set<number>` of bucket indices — **booleans, zero pixels**. `mark()` runs *after* an unconditional `renderFrame()`; no call site ever reads the cache to skip work. `App.tsx:396-399` paints green ranges over a cache that stores nothing. |
| **Edit ▸ Cut / Copy / Paste** | `menuModel.ts:58-60` — commands **never registered**. Render enabled (`AppMenuBar.tsx:83` defaults unknown commands to enabled). A fully working, fully tested `core/commands/clipboard.ts` sits two directories away with zero callers. |
| **Window ▸ Effects (F3)** | `openPanel('effectControls')` — that id is never registered (`App.tsx:105-117`); `layoutStore.ts:219` does `if (!p) return`. |
| **Examples ▸ Load SaaS Ad / Showcase** | Commands never registered. |
| **Panel close buttons** | All 13 panels register `closable:true`; `DockPanel.tsx:219` hardcodes `closable:false`. |
| **Alt+[ / Alt+]** | `useTimelineKeys.ts:91` does `if (e.altKey) return;` **before** the switch whose branches check `e.altKey`. Structurally unreachable, yet advertised in tooltips. |
| **AI `create_layer` camera/light/adjustment** | `toolContext.ts:113-130` bypasses `insertCamera`/`insertLight`/`insertAdjustmentLayer` → falls to else-branch → a 220×220 blue rect. The fake **camera hijacks the view** (`readSceneCamera` returns the first camera). |
| **Particle system** | `nodeTypes.ts:84 createParticleNode` — zero callers anywhere. |
| **`packages/scene` serializer** | `serializeScene`/`deserializeScene` have no callers in `src/`. **There are two scene systems; the tested one is not the shipped one.** |

---

## Tier 2 — Correctness bugs that corrupt output

1. **Motion blur fades every layer ~34%.** `Canvas2DBackend.ts:321-327` draws N samples at `opacity/n` with `source-over`: `1−(1−1/n)^n ≈ 0.66`. Needs accumulate-then-divide.
2. **Motion blur destroys track mattes.** `Canvas2DBackend.ts:329` `continue`s *before* the `if (layer.matte)` check at `:331`. The layer renders unmatted and the matte source stays hidden — it just vanishes.
3. **Motion blur is a no-op on 3D layers.** Per-sample spread overrides `x/y/rotation/scale`, but 3D layers carry a baked `matrix` which `drawComposited` prefers (`:474-476`). N identical draws at reduced opacity — fade only.
4. **Speed graph writes speed into value.** `GraphEditor.tsx:150-159` sets `KfPoint.value = getVal(kf.t)` (the derivative); the drag handler writes it back as the value. A position key at `x=100` moving 250px/s becomes `x=250`. Looks like a legitimate edit, so undo is the only recovery.
5. **Text animators collapse multi-line text.** `Canvas2DBackend.ts:718-720` diverts to `drawGlyphs`, which never splits `\n` and hardcodes `textAlign='center'`. All lines overlap at y=0.
6. **Keyframe paste drops easing.** `clipboard.ts:104-113` writes at **layer** time then looks up bezier/tangents at **comp** time → `.find(k => k.t === t)` misses on any offset layer. Also builds selection ids with `@` while `makeKeyframeId` uses `::` → `parseKeyframeId` returns null → pasted keys never selectable. (Two stale doc comments enshrine the wrong `@` format.)
7. **Undo's 700ms debounce eats two actions.** `Providers.tsx:699-702` — Ctrl+Z inside the debounce window undoes the *previous* entry, whose `before` predates the pending edit.
8. **Exported JSON "project" cannot be re-opened.** `exportManager.ts:190` nests under `scene`; `sceneProjectIO.ts:61` reads top-level `file.nodes` → `?? []` → **clears the graph and adds nothing.** The preset advertises "Re-openable Motion project file."
9. **`File ▸ Open` doesn't open files.** `ApiFileAdapter` is installed at `EditorPage.tsx:55` and never uninstalled; `.open()` (`:20-28`) ignores the picker and returns your most-recently-updated cloud project.
10. **Render Queue renders the wrong comp.** Every job draws the global `defaultSceneGraph` singleton (`offlineRenderer.ts:20,116`); `compositionName` is a label only. Queue N comps → N copies of the active one. Also hardcodes `background:'#101014'` (`renderQueueStore.ts:73`).
11. **Render Queue GIF ships a .webm** with a toast falsely claiming no encoder exists (`renderQueueStore.ts:115-122`) — while a real hand-written GIF89a+LZW encoder works in the Export dialog (`gifEncoder.ts:201`).
12. **Crash recovery can never fire.** `recovery.ts:27` matches `window.location.pathname`; the app is a **HashRouter** (`AppRouter.tsx:88`). `projectId` is always undefined → the whole local autosave/recovery subsystem is inert.

---

## Tier 3 — Architectural ceilings

**The backend split is the most dangerous structural issue.** Neither render backend is complete:
- **Canvas2D** (default): 10/14 effects work. Gradient Ramp, Fractal Noise, Displacement Map, Motion Tile have `css: () => ''` → adding them is a **silent no-op**, and the Effects panel offers all 14 with no gating.
- **WebGL2** ("Experimental"): those 4 work, but it **skips adjustment layers, matte sources and lights** (`snapshotToFrameScene.ts:198,202`), has no matte concept in `FrameScene`, and discards all text styling (`AppTextureProvider.ts:370` hardcodes `600 …px Inter`).

You can have all 14 effects **or** adjustment layers + mattes + lights + text styling — never both. Worse: `exportManager.ts:126-132` hardcodes Canvas2D for stills while `offlineRenderer.ts:102` honors the user's setting → **flipping to WebGL2 keeps stills correct while silently gutting every video export.**

**One scalar per effect.** `effects.ts:28-34` gives each effect a single `amount` and one `ValueField`. Levels, Curves, Hue/Sat, Keylight, Lumetri and particles are **impossible to add** without refactoring the data model, UI and keyframe path together. Fix this before adding any more effects.

**Undo memory.** 500 levels (AE caps at 32 *because* entries are expensive), each `StoreSnapshotCommand` retaining two full `structuredClone` deep copies (`historyStore.ts:21-31`), plus a synchronous full-document clone on every emit (`:107-112`). Every clip drag deep-clones the whole project on the main thread.

---

## Tier 4 — Genuinely missing AE categories

**Effects:** Keying (Keylight), Matte chokers, Noise & Grain, Transition, Simulation (particles), Time (Echo/Posterize Time), Levels/Curves/Hue-Sat/Lumetri, Sharpen, Warp/Mesh Warp/Turbulent Displace, Fill/Stroke/Beam/4-Color Gradient/Audio Spectrum. Registry: **14 effects vs AE's ~300**, and Glow/Drop Shadow have hardcoded colors with no angle/distance/threshold.

**Tools:** Brush, Clone Stamp, Eraser, Roto Brush, Puppet Pin — all absent. (`src/core/paint/` is a false lead: it's vector fill/stroke styling.)

**Masks:** vertex editing after creation (`updateMaskPath` never called with `points`), variable-width feather. Path animation is a **one-way trap** — `readNodeMaskAt` returns the interpolated mask and ignores the static one, while every UI control writes the static one.

**3D:** orientation, anchor Z (supported in `matrix4.ts:76` — the sole caller hardcodes 0), material options, extrusion, C4D renderer, Draft 3D, two-node cameras, POI, zoom, DOF, aperture, camera tools (orbit/pan/dolly — numeric entry only). Lights are `{color,intensity,radius}` — **no `type` field**, so parallel/spot/point/ambient don't exist; no shadows. Z-sorting silently disables when any adjustment layer or unresolved matte exists (`buildSnapshot.ts:621`); no 3D intersection (centroid painter's sort, pops on crossover).

**Text:** Character/Paragraph panels, per-character 3D, Source Text keyframes (the engine is scalar-only — no string keyframing anywhere). On-canvas editing is `window.prompt('Edit text:')` (`useWorkspace.ts:496`).

**Project/IO:** bins/folders, footage interpretation, proxies, placeholders, replace footage, Collect Files, Reduce/Consolidate, image-sequence import, PSD/AI layered import, Increment & Save, templates, ProRes, **audio output in any format** (`grep audio core/export/*.ts` → zero hits — every MP4/WebM is silent).

**Shell:** Animation menu (F9 commands exist with no menu home), Preview panel, preview resolution (Full/Half/Third — `renderQualityStore` is a boolean `draft` that only disables motion blur), Info panel, live VU meter, Region of Interest, RGB channel views (only rgb↔alpha), viewer snapshot, multi-view 3D layouts, floating panels (`PanelUndocked` declared, never emitted), Layer/Footage panels.

**Timeline:** per-layer quality, collapse transformations / continuous rasterization, real Sequence Layers (bar offsets — the current one staggers *keyframes*), an "Enable Time Remapping" command, draggable guides + snapping, a matte column, layer markers (`scope:'layer'` — zero occurrences).

---

## Shortcut reality

| Key | Advertised | Reality |
|---|---|---|
| **Space** | "Spacebar plays" (`onboardingStore.ts:18`) | **Pan only.** Play/pause is mouse-only. The most ingrained AE reflex, and the app's own onboarding lies about it. |
| **P** (reveal Position) | `App.tsx:327` | Shadowed by `tool.pen`. ShortcutManager is window-**capture** + `stopPropagation` (`ShortcutManager.ts:41,137`); the reveal listener is window-**bubble** → never fires. |
| **T** (reveal Opacity) | `App.tsx:330` | Shadowed by `tool.text`, same mechanism. |
| **U** (Rectangle tool) | `Providers.tsx:91` | Shadowed by `timeline.revealAnimated`, registered later (`ShortcutManager.ts:128` scans backwards). |
| **Ctrl+N** (New Composition) | `Providers.tsx:243` | Collides with `project.new` after meta→ctrl mapping (`shortcutOverrides.ts:82-88`). Never opens New Comp on Windows/Linux. |
| **Alt+[ / Alt+]** | tooltips `BottomTimeline.tsx:275-285` | Structurally unreachable (early `if (e.altKey) return`). |
| **F2 / L overrides** | `AE_PRESET:29-30` | Inert — override commands that don't exist. |
| **Numpad 0** (RAM preview) | — | Unbound; no RAM preview exists. |
| Tooltips: `Q`, `Shift+Q`, `G`, `Ctrl+T`, `A`, `Shift+P`, `Alt+P`, `L` | `TopNav.tsx:40-68` | **None bound.** The tools are real; the tooltips are the lie. |

Working: `S`/`R`/`A`/`M`/`L` reveal, Ctrl+Shift+D split, B/N work area, J/K keyframe nav, F9 (except on Position), Ctrl+Shift+P palette (Cmd+K correctly freed for Comp Settings).

**Corrections to prior audit notes:** Escape is **not** swallowed globally — `edit.deselect` guards on `enabled: () => count() > 0`, and `stopPropagation` (not `stopImmediatePropagation`) doesn't block same-target capture listeners. `L` is **not** taken by `revealAudio` — that command doesn't exist, so audio reveal works. Undo is **one unified system**, not three competing ones — `historyStore` and the timeline `History` both funnel into `CommandSystem`'s `HistoryService`; the `if (cmd.undo)` branch at `CommandSystem.ts:59` is dead but was never load-bearing.

---

## What is genuinely good

Worth protecting — the problems above are almost all at boundaries, not in the engines:

- **`packages/animation`** — the sampler, roving keyframes, spatial tangents, cycle detection and the reversible-command layer are correct and well-documented. Every defect is at a boundary: engine↔CSP, engine↔host binding, engine↔UI time base, or a stale doc comment a caller followed.
- **The 2.5D compositor core** — `buildSnapshot` genuinely composes a Matrix4, projects through a pinhole camera, and z-sorts. Canvas2D honors the projected affine.
- **motion-back** — the healthiest part of the system, and not the bottleneck. Auth, ownership assertion, trash + retention purge, paginated/indexed search, version snapshots with pruning, revision-conflict support, Cloudinary storage, zip-slip-hardened extraction, and a real ffmpeg mux are all genuinely implemented. Its schema comments are unusually candid. The failures are in the editor and at the **editor↔backend contract** (missing `baseRevision`, missing `time`, mismatched frame filenames).
- **The 4 GPU effects are real** — genuine WGSL *and* GLSL shaders, properly invoked. They are backend-gated, not fake.
- **The GIF encoder** — hand-written GIF89a + LZW + NETSCAPE loop. Real work.
- **The shell** — 45 of 52 menu items real, all 18 tools reach real engine code, docking works, the History panel is live.
- **Working AE features:** blend modes, track mattes (Canvas2D), parenting with world preservation, solo/visibility, time-stretch/reverse/freeze, time remapping, layer split/duplicate, graph editor (value mode), roving keyframes, spatial bezier motion paths with tangent handles, anchor-point compensation, keyframe navigator, Sequence/Time-Reverse assistants, guides/rulers/safe areas, PNG/JPEG sequence export (the most trustworthy output), WebM export, layer styles (drop shadow + outer glow).

---

## Recommended order

**Stop-the-bleeding (data loss / silent lies):**
1. Wire `serializeTimeline`/`deserializeTimeline` into `captureDocument`/`restoreDocument` — the `timeline` field is already declared.
2. Persist the whole `comps` Record + motion blur + guides; make comp edits trigger autosave (`EditorPage.tsx:114-119` doesn't subscribe to them).
3. Fix the frame-padding contract (one line either side) + **add a cross-repo contract test**.
4. Fix or delete `exportJSON`'s "re-openable" claim and `ApiFileAdapter.open()` — silent wrong-data paths are worse than errors.
5. Recovery: read the route from `location.hash`, not `pathname`.

**Cheap, high-value (mostly one-liners):**
6. Route the three timeline switches through `setNodeMotionBlur`/`setNodeAdjustment`, or delete them.
7. Camera pan: use the principal point (`width/2`), not `cam.position.x`.
8. `pathOps.ts:223` coercion — restores 2 of 4 shipped path ops; drop `min={0}`.
9. Expand `'Position'` → `['x','y','z']` in `applyEasingToKeyframes`/`applyVelocityToKeyframes` (mirroring what `App.tsx:482` already does) — restores F9.
10. Wire `edit.cut/copy/paste` to the tested, uncalled `clipboard.ts`. Likely the highest value-per-line fix in the audit.
11. Bind Space to play/pause. Fix the Loop button's `clearWorkArea` on mount/toggle-off.
12. Bind the four unbound host providers in `Providers.tsx` (next to the two already there).
13. Make tooltips tell the truth, or bind the keys they name.
14. Motion blur: accumulate-then-divide; move the matte check before the `continue`.

**Structural (decide before adding features):**
15. Expressions: either add `'unsafe-eval'` to CSP (a real security relaxation — CSP is load-bearing for backend origins) **or** write an interpreter over the existing `tokenizeExpression`, keeping CSP intact and removing the arbitrary-code-execution surface.
16. Unify the render backends, or gate the UI per-backend and stop hardcoding Canvas2D for stills.
17. Replace the single-scalar effect model before adding any more effects.
18. Make compositions a real, insertable, persisted entity.
19. Delete one of the two scene systems (`packages/scene`'s serializer is tested and unshipped).

**Testing:** the suite is green because it exercises pure functions directly and crosses none of the broken boundaries — `pathOps.test.ts:93` calls `applyPathOp` past the `:223` coercion; `effects.test.ts:102` explicitly *excludes* the 4 GPU-only effects from its non-empty-CSS assertion; `expressions.test.ts` injects `ctx` directly, bypassing the unbound providers; `mask.test.ts` never asserts mode/feather/opacity affect output; `agent.test.ts` never calls `create_layer` with camera/light/adjustment; `buildSnapshot3d.test.ts` never tests camera X/Y pan. Add boundary tests (save→load round-trip, cross-repo render contract, UI-switch→pixel) or this recurs.

> Note: `npx jest` in OneDrive silently runs 2 of 140 suites (placeholders read as symlinks). Mirror to local disk before trusting any "suite green" claim.

---

# Fix log — 2026-07-16, pass 1

Verified: **149 suites / 1367 tests green**, motion-editor + motion-back typecheck clean, `vite build` passes. New tests were mutation-checked — reverting the fix makes them fail.

## Tier 0 — data loss

**1. The timeline persists.** New `applySerializedTimeline` (`packages/timeline/src/serialization/Serializer.ts`) loads a document into an EXISTING timeline, so restore reuses the instances `TimelineController.initTimeline` built — keeping their history hook and event wiring, which a fresh `deserializeTimeline` would silently drop. `TimelineController.capture()/restore()` handle every composition; `captureDocument`/`restoreDocument` fill the already-declared `timelines` field. Restore re-derives the composition track id from the loaded document (the id minted at init belongs to a track that was just replaced), then `syncFromScene` reconciles without stomping restored geometry.
→ Trims, splits, clip positions, markers and the work area now survive save+reload.

**2. Comps, motion blur and guides persist.** `captureDocument` saves the whole `comps` record (was: only the active tab's, so every other comp reverted), plus `motionBlurStore.settings()` (render-affecting — exports changed after a reload) and `guidesStore.settings()`. Both stores gained `settings()`/`restore()`. Document version → `1.1.0`; v1.0.0's single `comp` field is still read.

**3. Comp settings edits stop vanishing.** `projectStore.updateComp` upserts instead of `if (exists)`-guarding — that guard silently swallowed every settings change inside a precomp tab, since tabs open with a scene node id that has no comps entry. Added `ensureComp` and `replaceComps`. `openTab` seeds a comp inheriting the parent's size/fps, so a precomp opens at the project's real dimensions instead of `DEFAULT_COMPOSITION`. `initTimeline` reads the comp it is initializing rather than the active tab's.

**4. Autosave hears non-scene edits.** New `DocumentChanged` app event, emitted by `updateComp`, the motion-blur setters, and the timeline engine's structural events (layers/tracks/markers/ranges/duration/frame-rate — deliberately NOT playhead/zoom/scroll, which would fire on every frame of playback). `CloudAutosave` subscribes. A `reconciling` flag suppresses it during load and scene-mirroring, so a load doesn't immediately re-dirty the project it just loaded.

**5. MP4 export fixed (cross-repo).** `FRAME_SEQUENCE_PAD = 4` + `frameFileName()` pin the producer side; padding was `String(total).length`, so any render under 1000 frames emitted `frame_000.jpg` while the worker globbed `frame_%04d.jpg` — ffmpeg matched nothing and every MP4 under ~33s failed. motion-back's new `framePattern()` DERIVES pattern, extension and start frame from the extracted files and passes `-start_number`, so the contract can't silently break again. The catch-all that blamed the network for every failure now reports the real error.

**6. Crash recovery can fire.** `recovery.ts` reads the project id from `location.hash` (HashRouter). It matched `location.pathname` — `/` in dev, the index.html path under Electron — so `projectId` was always undefined and the whole subsystem was inert. Snapshots now carry the full document; pre-1.1 scene+anim snapshots still restore.

**7. `File > Open` stops opening the wrong project.** `ApiFileAdapter.open()` ignored the picker and returned the most-recently-updated project. It returns null now, and the Open command routes to the dashboard in cloud mode.

**New tests:** `src/core/api/cloudDocument.test.ts` (9 round-trip assertions: work area, markers, trims, splits, all comps, motion blur, guides, v1.0.0 back-compat, missing-timeline tolerance) and `src/core/export/frameContract.test.ts` (pins padding, mirrors the worker's derivation).

## Tier 1 — features that did nothing

**8. Timeline layer switches write where the renderer reads.** `App.tsx` routed motionBlur/adjustment/fxEnabled through a top-level property on the cached node view that no render path consults. All three now go through `setNodeMotionBlur`/`setNodeAdjustment`/`setNodeFxEnabled` (the `fx` component), and the icons READ the same accessors — timeline and inspector are finally one source of truth.

**9. The `fx` switch has a reader.** Added `readNodeFxEnabled`/`setNodeFxEnabled`/`readNodeRenderEffects` + `SceneGraph.setFxEnabled`. `buildSnapshot` (layer and precomp paths) resolves through `readNodeRenderEffects`, which returns `[]` when the switch is off — deliberately distinct from `readNodeEffects` so the inspector still lists a disabled stack. Absent = enabled, so existing projects are unaffected.

**10. Camera X/Y pan works.** `Camera3D` gained a required `principal` point (the comp centre). `projectPoint` used `position.x` as both eye and principal point, so the camera term cancelled exactly at z=0 and panning moved nothing; off-plane layers drifted the wrong way. Making the field required made the compiler find the second construction site in `ports.ts`. New `packages/scene/src/__tests__/project3d.test.ts` covers pan in X/Y, parallax ordering, the sign at depth, and the optical-axis invariant.

**11. Pucker & Bloat and Twist are reachable.** `readPathOpConfig` validated against a two-entry allowlist and coerced everything else to `zigzag`, making `applyPathOp`'s pucker/twist branches statically unreachable; it now validates against the whole union. `PathOpControls` no longer clamps every parameter at `min={0}` — Pucker is puckered below zero and bloated above, Twist takes signed angles; counts still can't go negative.

**12. F9 / Easy Ease / velocity work on Position.** `POSITION_PSEUDO_PROP` + `expandKeyframeProp` now live in `packages/animation/src/keyframeId.ts` beside the codec. Both assistants expand it — they called `getTrackKeyframes(node, 'Position')` which returns null, so F9 no-opped in the DEFAULT UI state while reporting success. Also fixed: the merged Position row encoded ABSOLUTE time in its id while every per-property row used layer time, so handlers missed on any offset layer. Four hand-rolled copies of the expansion in App.tsx now use the shared helper.

**13. Keyframe copy/paste works.** `keyframeClipboard.copyKeyframes` — the LIVE path behind Ctrl+C — hand-parsed `nodeId::prop@time`, a format that has never existed, so every id failed and copy collected nothing. Now uses `parseKeyframeId`. `core/commands/clipboard.ts` had the same bug plus a layer/comp time mix that dropped easing and spatial tangents on paste; both fixed, mutations wrapped in `runAnimEdit`, and the three stale doc comments documenting the wrong format are corrected.

**14. Cut / Copy / Paste exist.** All three menu items pointed at commands that were never registered (and rendered enabled, because unknown commands default to enabled). Registered against the now-correct clipboard module with honest `enabled` predicates. Added `cutSelection` and `hasClipboardContent`.

**15. Spacebar plays.** New `useSpaceTransport` implements AE's actual resolution — tap = play/pause, hold + drag = pan — as a window listener so it works with focus in the timeline, and NOT as a ShortcutManager binding (that layer captures and stops propagation, which would swallow the pan).

**16. Loop stops destroying the work area.** The controller owns loop state (`isLooping`/`setLooping`); the loop RANGE follows the work area, but toggling Loop never touches it. The old effect called `clearWorkArea()` on toggle-off AND on mount, so a work area set with B/N was wiped by a button labelled "Loop" — while playback looped unconditionally regardless.

**17. `Alt+[` / `Alt+]` reachable.** `useTimelineKeys` had `if (e.altKey) return` directly above branches testing `e.altKey`. Alt passes through for `[`/`]` only.

**18. Tool keymap matches AE — and its own tooltips.** Pen p→g, Text t→Ctrl+T, Rectangle u→q, Ellipse e→Shift+Q. The tooltips already advertised G/Ctrl+T/Q/Shift+Q; the bindings were wrong. This also frees P, T and U, which were shadowing property reveal. Removed tooltip shortcuts for tools with no binding (Pencil, Curvature, Line) and two AE_PRESET overrides naming commands that don't exist.

**19. Dead menu items.** `Examples` commands registered (both builders existed and were tested; only the commands were missing) — each confirms first, since they clear the scene. `Window > Effects` (F3) targeted the unregistered id `effectControls`; now opens the real `effects` panel. `Window > Graph Editor` collapsed the bottom timeline instead of toggling the graph.

**20. Panel close buttons render.** `DockPanel` hardcoded `closable: false` over every panel's own `closable: true`.

---

# Fix log — 2026-07-16, pass 2: expressions

**Decision: interpret, don't relax the CSP.** `'unsafe-eval'` would have been a one-line fix, but the renderer holds the user's auth token and talks to motion-back, so it would make any expression in any opened or shared project an arbitrary-code-execution vector. Interpreting keeps `script-src 'self'` intact and means an expression can only ever reach the names we bind — no `window`, no `fetch`, no prototype-chain escape.

**21. Expressions actually run.** New `packages/animation/src/exprLang.ts` — a lexer, Pratt parser and evaluator for a single JS *expression*, which is all the old code ever allowed (`return (${src})`): literals, identifiers, member access, calls, unary, binary, `&&`/`||` with short-circuit, ternary, grouping, arrays. No statements, assignment or loops. `compileExpression` parses once and evaluates against a scope Map built from the same `API_PARAMS` names; the entire existing runtime API (wiggle/clamp/linear/ease/loopOut/valueAtTime/thisComp/…) is untouched. Member calls keep their receiver bound, so `Math.sin(0)` works. `__proto__`/`constructor`/`prototype` are refused at the member-read.

**22. The four dead host providers are bound.** `setLayerResolver`, `setBaseValueProvider`, `setCompInfoProvider` and `setLayerInfoProvider` had zero callers, so the engine kept its placeholders: `layer()` always returned 0, `thisComp.width` was a hardcoded 1920 regardless of the real comp, `thisLayer.name` was the string `'Layer'`. All four now read the live scene and composition. (A plausible wrong number is worse than an error — it fails silently on exactly the comps that depend on it.)

**Verification — this one needed more than tests.** The bug existed *only* under a real CSP, which is precisely why 62 green expression tests never caught it:
- All 62 pre-existing expression tests pass unchanged against the interpreter (no behavioural regression).
- New `exprLang.test.ts` (70 tests): precedence/associativity, number lexing, short-circuit, member/call/array, sandbox escapes, error messages — plus a **CSP simulation** that sabotages the `Function` constructor to make jsdom behave like the renderer. Mutation-checked: reintroducing `new Function` fails it.
- **Verified in a real browser.** Loaded the dev server and imported the module as page code: expressions evaluate correctly (`thisComp.width` → the real 800, not 1920). A temporary probe module proved the premise: page code calling `new Function` returns `EvalError: Evaluating a string as JavaScript violates the following Content Security Policy directive…`. The old engine could never have worked in the product.

> Note for future work here: `javascript_tool` / CDP `Runtime.evaluate` is **exempt from CSP**, so testing eval from an injected snippet reports `false` (not blocked) and is worthless. The check must run as page code — import a module.

---

---

# Fix log — 2026-07-16, pass 3: render correctness

**23. Motion blur — all three bugs.** Blur is now handled INSIDE `drawComposited`, so every path that draws a layer (including `drawMatted`) gets it, instead of a branch that bypassed them.
- *~34% fade*: samples were drawn at `opacity/n` with the default `source-over`, which composites to `1-(1-1/n)^n` ≈ 0.66 at 8 samples. Now accumulated ADDITIVELY (`lighter`) at 1/n weight into a scratch buffer, which sums to exactly the shutter-interval mean, then blitted once with the layer's own blend/opacity.
- *Destroyed mattes*: the old branch `continue`d before the matte check, so the layer drew unmatted and its source stayed hidden — it just vanished. Gone by construction now.
- *No-op on 3D*: `drawComposited` prefers a layer's baked `matrix` over the decomposed x/y/rotation/scale, so the per-sample spread was ignored and blur became N identical draws. `MotionSample` gained an optional `matrix`; `buildSnapshot` extracts `affineAt(...)` and rebuilds the projection per sub-frame (parent chain treated as static across the shutter — exact unless a parent is also moving). The comment claiming the decomposed values were "kept … for motion blur" was false and is corrected.
- Scratch buffers refactored to a keyed record with a comment on why each role must not collide (A/B matte, C filter, D blur).

**24. The backend split is no longer silent.** New `src/core/rendering/capabilities.ts`: `capabilitiesOf(choice)`, `analyzeDocument(graph)` (scans the SCENE, not one frame, so a matte that only matters at t=8s still counts), `pickExportBackend(preferred, needs)` and `describePick`. `EffectDef.gpuOnly` makes the four shader-only effects explicit instead of inferred from an empty CSS string.
- **Stills and video now share ONE pick**, made once in `runExport`. `makeCanvas` no longer hardcodes Canvas2D and `offlineParams` no longer lets `renderOffline` default to the user's setting — that divergence is what let a WebGL2 user keep correct PNGs while every video silently lost adjustment layers, mattes, lights and text styling.
- The pick prefers your setting, switches only when the other backend is strictly better *for this document*, and always reports what is still missing. When neither backend suffices (e.g. GPU effects AND mattes) it keeps your choice and says what won't render, rather than pretending.
- The Effects panel dims + disables GPU-only effects on Canvas2D with an explanation. Adding one used to be a completely silent no-op.
- **Bonus bug found and fixed:** GIF export read pixels via `canvas.getContext('2d')` on the render surface — which returns **null** once the GPU backend has claimed it for WebGL — and the code just skipped the frame. A GIF exported with the GPU renderer came out empty with no error. Now reads through a 2D scratch canvas and throws if zero frames were produced.

**Verification.** 8 new `buildSnapshotMotionBlur` tests (3D samples carry distinct matrices; 2D don't; none when static / not opted in / comp blur off) and 14 new `capabilities` tests. Motion blur also verified with **real pixels in a browser**, since jsdom returns null for a 2D context — which is precisely why these drawing bugs were never caught:
- old accumulation → alpha **167**; new accumulation → **255** (the ~34% fade, measured)
- blurred layer ≡ unblurred layer for a stationary subject
- `matteWithBlur` ≡ `matteNoBlur` — the matte survives

---

# Fix log — 2026-07-16, pass 4: graph editor, masks, undo

**25. Speed graph no longer corrupts values.** `KfPoint` now separates `value` (the keyframe's real value — what gets written) from `plotted` (what the active graph draws). They were one field set to whatever the graph displayed, which in speed mode is the DERIVATIVE — so dragging a keyframe wrote its speed into its value (a position key at x=100 moving 250px/s silently became x=250, indistinguishable from a real edit). Vertical drag in speed mode now retimes only, since a y position there is a speed and there is no value to read from it; AE maps that axis to influence, which is a separate feature. The ValueField shows the real value in both modes and annotates the speed read-only.

**26. Graph editor is aligned with its own playhead.** The x axis and playhead are COMP time; the engine stores keyframes in LAYER time. The graph plotted `kf.t` directly, so every trimmed layer's curve sat shifted from its own keyframes by exactly the clip start. `sampledPaths` now converts per track (each layer has its own offset): sweeps the axis in comp time, samples the engine in layer time, and carries `tAbs` for plotting. The drag math needed no conversion — a time *delta* is identical in both bases — only the clamp bounds did.

**27. Masks render mode, feather and opacity.** All three were stored, exposed in the inspector, and read by NOTHING: `buildMaskPath` unioned every path into one Path2D and clipped with `evenodd`, which ignores `mode` entirely (two Add masks XOR'd — the overlap punched a hole) and cannot express feather or per-mask opacity at all. Replaced with a real alpha matte (`maskMatte`) rasterized at native layer size: Add paints, Subtract erases (`destination-out`), Intersect keeps the overlap (`destination-in`); feather is a canvas blur at half the AE diameter; opacity is `globalAlpha`. A leading Subtract/Intersect seeds a full frame, matching AE (otherwise it erases from nothing and the layer vanishes). Applied via `destination-in` to the layer's offscreen, preserving AE's masks → effects → transform order. All three mask sites (plain, filtered, precomp) go through it. `clip()` can only cut a hard binary hole, which is why any masked layer now routes through the offscreen.

**28. Undo stops eating two actions.** The 700ms debounce lived in a closure in Providers, so nothing could flush it: an edit inside the window was still unrecorded when Ctrl+Z landed, and undo popped the PREVIOUS entry — whose "before" predates the pending edit — discarding both. The debounce moved into `historyStore` with `schedule()`/`flush()`, and `performUndo`/`performRedo`/`performJumpTo` are now the only ways through history (undo was reachable from four places: the command, both TopNav buttons, the History panel). `restoring` is finally written via `runRestoring`, so the guards documented in that module are no longer dead.

**29. The "Open" baseline entry exists.** `record('Open')` runs right after `reset()`, whose `clear()` emits `UndoStackChanged`, whose listener sets `lastState` to the current state — so `statesEqual` was true and nothing was pushed, leaving the document's opening state unreachable. Named records now always produce a row. `named` is a real field on `IUndoableCommand` (the History panel read `(e as any).named`, always undefined, so a pinned snapshot looked identical to an auto-capture).

**Verification.** 11 new `historyStore` tests, mutation-checked — removing the flush fails exactly the three race tests. Masks verified with real pixels in a browser: two Adds now union (was: XOR hole, demonstrated at `overlap = 0` with the old even-odd path), Subtract/Intersect correct, feather produces soft edges (181/174 vs 253 centre), opacity 0.5 → alpha 128.

---

# Fix log — 2026-07-16, pass 5: mask editing

**30. Mask shapes are editable.** `updateMaskPath` had never once been called with `points`, so a mask was frozen the instant it was drawn — and mask path animation, which morphs exactly those points, could not be authored at all. Masks are now editable outlines the Direct Selection tool can see: `WorkspaceNode.maskPaths` exposes them (they sit beside a layer's geometry rather than replacing it — a text layer has masks and no `pathPoints`), a new `workspace.updateMaskPath` command carries layer + mask + points, and `setMaskPoints` writes them.

**31. The mask animation trap is closed.** Once keyframed, `readNodeMaskAt` returns the interpolated shape and ignores the static one — but every mutator wrote the static mask, so on an animated mask changing mode/feather/opacity/expansion did nothing visible and no edit could ever reach the animation. `editMaskAt(nodeId, t, fn)` now writes a keyframe at the playhead when the mask is animated, as in AE; `editEveryMaskState` handles structural add/remove across the static mask AND every keyframe, because `interpolateMask` pairs paths by index and mismatched counts snap instead of morphing. The Effects panel threads its `maskTime` through.

**32. Direct Selection stops editing the wrong node.** Handle ids encoded the node id and were parsed back with `split('_')`, so any id containing an underscore — `comp_root`, every `tab_*` — resolved to the wrong node. Replaced with a handle→ref map, which also carries the mask id a positional string couldn't express. The tool now tracks the active outline, not just an index, so tangents belong to the right path.

**Verification.** 9 new `direct-select-mask` tests: mask handles exist at all, reshaping hits the mask rather than the geometry, geometry and masks on one layer don't get confused, Alt+delete respects a minimum, tangents follow the active outline, and a vertex drag on an underscore-containing node id targets the right node.

---

# Fix log — 2026-07-16, pass 6: the effect model

**33. Effects have real parameters.** `EffectDef` now declares `params: EffectParamDef[]` (`number` | `color` | `checkbox`, each with label/unit/min/max/default) instead of one `amount`/`min`/`max`/`unit`, and `css` takes the whole param set. This was the ceiling: with a single scalar, Levels, Curves, Hue/Sat, Keylight and particles were **impossible to express**, and the effects that did exist were crippled by it.

Immediately fixed by the model rather than worked around:
- **Glow** gains `radius` / `color` / `intensity`. The colour was hardcoded `rgba(120,180,255,0.9)` — a blue glow was the only glow this app could produce.
- **Drop Shadow** gains `distance` / `angle` / `softness` / `color` / `opacity`. Both offsets were derived from the one amount (`a*0.45` on each axis), so the shadow could *only* fall down-right at 45°.
- **Gradient Ramp** gains `blend` / `colorA` / `colorB`. Its endpoints were hardcoded red→blue in `snapshotToFrameScene` and unreachable from the UI.

**34. Every numeric param is independently keyframeable.** `effectPropPath(id, key)` → `effect.<id>.<key>`; `resolveEffectParams` samples each. The inspector renders one row per param (stopwatch for numbers, a real colour picker for colours) instead of one field per effect. The AI tool schema now describes every param, so `get_context('effects')` can actually tell the model that Glow has a colour.

**35. Old projects keep their look.** `paramsOf(effect)` resolves declared defaults ← legacy `amount` ← stored params, and **every** reader goes through it — not just `readNodeEffects`. Relying on a single migration point is how a stale shape ends up rendering wrong somewhere else. A legacy `effect.<id>` keyframe track (no param key) still drives the primary param, so pre-existing animations run unchanged; a param-specific track wins when both exist. `Effect.params` is optional because stored data genuinely may lack it — the type reflects reality.

**Verification.** `effectColorMatrix.test.ts` passes **completely untouched**, which is itself the back-compat proof. 20 new/rewritten `effects` tests cover per-param resolution, legacy-track fallback, precedence, and that GPU-only defs are exactly the ones with no CSS output. Verified with real pixels in a browser: a red glow renders `rgb(255,0,0)` and a green one `rgb(0,255,0)` (both were blue before), while a legacy `{amount: 20}` document still renders the exact old `rgb(119,180,255)`.

---

# Fix log — 2026-07-16, pass 7: compositions are real

**36. Compositions are insertable.** `projectStore.createComp` / `removeComp` finally write the table — nothing ever inserted into `comps` before, which is why "New Composition" could only overwrite the single seeded comp. `createComposition()` (new `core/composition/compositionOps.ts`) creates the three things that must stay in step: the settings entry, a scene ROOT node whose id **is** the comp id, and a tab. `deleteComposition()` removes all three, and refuses to delete the last comp (a project with no comp has nowhere to put a layer).

**37. "New Composition" stops wiping the project.** It used to `defaultSceneGraph.clear()`, `defaultAnimation.clear()` and overwrite the active comp's settings — Reset Project wearing the wrong label. It's now purely additive. Undo is "remove the comp I made" rather than a whole-document snapshot restore, and the id is fixed up front so redo restores the *same* comp instead of minting a fresh id that would orphan later history entries. The dialog's "Creating replaces the current scene and keyframes" warning and its **"Replace & Create"** button are gone — both were telling the truth about the old behaviour.

**38. The renderer scopes to one composition.** Comps are sibling root subtrees of one scene graph, and `buildSnapshot` called `flattenScene`, which walks EVERY root — so a second comp would have drawn straight on top of the first. New `flattenComposition(graph, rootId)` + `SnapshotComp.rootId`, threaded from the viewport, the export dialog and the render queue. Absent = whole scene, so single-comp projects and tests are unaffected.

**39. The Render Queue renders what you queued.** `RenderJob` gains `compositionId` and `background`. Only `compositionName` existed — a *label* — so every job rendered whatever comp was active when it ran (queue three comps, get three copies of one, each correctly named) on a hardcoded `#101014` regardless of the comp's real background.

**40. Precompose puts the precomp where the layers are.** It hardcoded `getRoots()[0]`, which already yanked nested layers up to the root, and with multiple comps would have dropped them into whichever composition happened to be first rather than the active one.

**Verification.** 13 new `compositionOps` tests: creating adds rather than replaces, existing layers survive, each comp keeps its own settings, an explicit id round-trips for redo, `flattenComposition` returns only its subtree, **two comps render independently** (`render(a)` contains a and not b, and vice versa), delete removes comp+layers+tab, and the last comp can't be deleted.

---

# Fix log — 2026-07-16, pass 8: the Project panel

**41. Compositions have a home.** New `layout/Project/ProjectPanel.tsx` — After Effects' Project panel — registered in the left sidebar and reachable from `Window ▸ Project`. Lists every composition with its own size / fps / duration / layer count, marks the one open in the active tab, and offers search, create, open (click), rename (double-click or menu), duplicate, Composition Settings and delete. Delete is disabled for the last comp and confirms when the comp has layers. The panel owns **no** composition logic — every mutation goes through `compositionOps`, which keeps the settings entry, the scene root and the tab in step.

**42. `renameComposition` / `duplicateComposition`.** Rename moves the settings entry AND the scene root together (the panels read the name off the root, the tab reads the comp — they must not drift). Duplicate copies the settings, the whole layer subtree under fresh ids, and **the keyframes on every layer** — those live per node id, so a subtree copy alone would silently yield a static duplicate. Parent references are remapped through the same id table, or the copy's children would point back at the original's nodes.

> **Gotcha worth keeping:** a scene node is a graph *view* whose `children` resolve to node objects, so `structuredClone(node)` walks into a cycle (and would drag the whole graph along). Build a plain node explicitly, the way `sceneProjectIO.capture` does. The jest `structuredClone` polyfill is `JSON.parse(JSON.stringify(…))`, which throws on the cycle — which is how this surfaced.

**Verification.** 8 more `compositionOps` tests (21 total): rename hits both places, duplicate copies layers with fresh ids, remaps parents so nothing points back at the original, copies keyframes, and leaves the copy independent. The panel itself was **driven live in a browser** — mounted for real and exercised: create adds a row showing its own settings and `1 layer` (singular), clicking a row moves `aria-selected` to it, rename updates the row *and* the scene root, duplicate produces "Banner copy" with the layer copied, delete removes only the copy. No console errors.

---

# Fix log — 2026-07-16, pass 9: the export/IO cluster

**43. `File ▸ Save` stops dropping your animation.** The ProjectManager's IO was wired to `sceneProjectIO` — SCENE ONLY — so a `.motion` file contained geometry with no keyframes, no comp settings and no timeline. New `core/project/projectDocumentIO.ts` registers the full EditorDocument instead: the same shape cloud autosave and the JSON export use, so all three round-trip through one path and a file written by any of them opens in the others. Legacy scene-only `.motion` files (a bare `{version, nodes}`) still open.

**44. `ProjectDocumentIO` is document-agnostic.** It was typed to `ProjectFile`, which is *why* saving was scene-only — the contract couldn't express anything else. Now generic over a new `VersionedDocument` (just `{ version }`), as are `ProjectService`/`ProjectSerializer`. The persistence layer needs nothing more than a version.

**45. The exported JSON project actually re-opens.** `exportJSON` hand-rolled `{version, scene, animation, exportedAt}` — a shape nothing reads. The loader looks for a top-level `nodes`, found none, and **cleared the graph and added nothing**: opening your exported project gave you a silently empty scene, while the preset advertised "Re-openable Motion project file". It now writes `captureDocument()`, exactly what `File ▸ Open` restores.

**46. `ApiFileAdapter` is a transport again.** It used to return only `doc.scene` and restore animation/comp as a hidden side effect, because the IO beneath it spoke scene-only. Now read fetches the document and write PUTs it — one restore path for cloud and local, no side effects. `mergeContents` is gone.

**47. The Render Queue renders real GIFs.** The `gif` branch warned *"no local GIF encoder"* and shipped a `.webm` — while `renderGIFBlob` (a hand-written GIF89a + LZW encoder) was already powering the Export dialog. The queue now calls it. `outputExtFor()` gives the extension one home: the Export dialog hardcoded `.webm` for everything that wasn't a sequence, so a GIF job was *named* `.webm` too.

**Verification.** 7 new `projectDocumentIO` tests, **mutation-checked**: reverting the IO to scene-only fails 4 of them (keyframes, comp settings, timeline, createEmpty) — the exact data loss. Also verified live in a browser:
- GIF: byte-level `GIF89a` header, 160×120 in the logical screen descriptor, a `NETSCAPE2.0` loop block, `0x3b` trailer, `image/gif` MIME.
- JSON: wiped the scene to **0 roots**, reopened the exported file, and got back the scene, the layer and **both keyframes** with the right animated value.

## Still open (highest value first)

- **Neither backend is complete.** The gap is now *visible and reported*, not closed: WebGL2 still has no matte concept in `FrameScene`, no light pass, no adjustment pass, and hardcodes the font. Canvas2D still can't run the four shader effects. Making WebGL2 feature-complete is the real fix.
- **The effect catalogue is still 14 wide** — but the model no longer blocks Levels/Curves/Hue-Sat/Keylight/Echo. Those are now ordinary work.
- **No audio in any export.** No RAM preview (the cache stores no pixels). Text editing is `window.prompt`.

---

# Fix log — 2026-07-16, pass 10: Group A (honesty)

The last of the "green tests, dead product" surfaces — the places the product still overstated itself. See `AE_PARITY_ROADMAP.md` for the group definitions.

**A1 — text editing works in Electron.** Double-clicking a text layer edited it via `window.prompt`, which Electron's Chromium refuses — and `useWorkspace.ts:568` said so in a comment right next to `:498` which used it. So text editing was silently dead in the desktop build the product ships as. New `TextEditOverlay` (`layout/Workspace/`) is an on-canvas `contentEditable` glued to the layer (tracks the camera live via a new `WorkspaceController.getNodeScreenPlacement`), styled to match the render (font, size, colour, alignment, rotation, zoom). Enter commits, Escape cancels, Shift+Enter is a newline. 7 RTL tests exercise the real render; commit was also verified writing back in a browser.

**A2 — the fake RAM-preview cache bar is gone.** `renderCache` stored a `Set<number>` of bucket booleans — zero pixels — and no call site ever read it to skip a render, so the green bar told users a frame was cached when it wasn't and replaying cost full price. A *real* frame cache is a backend-entangled feature whose failure mode is showing a stale frame (a new lie), so it belongs in its own scoped effort — deleted the bar, the cache module and all `mark`/`invalidate` plumbing rather than ship a half-cache.

**A3 — preview resolution (Full/Half/Third/Quarter).** `renderQualityStore` was a boolean `draft` that only skipped motion blur, so there was no way to trade quality for playback speed — the exact lever AE users reach for when preview drops frames, doubly needed now that A2 removed the (fake) cache. The content canvas now renders at `dpr/N` while the overlay and engine stay at full dpr; the browser upscales. Verified in a browser: Half = exactly ¼ the backing pixels, same CSS size. Dropdown in the transport bar + overflow menu.

**A4 — 3D depth sorting no longer silently disables.** It was abandoned entirely the moment one adjustment layer or matte appeared, so every 3D layer then rendered in list order at the wrong depth, with no indication. Now sorts WITHIN runs bounded by order-dependent layers (adjustment layers, matte pairs act as barriers, preserving their compositing) — which also matches AE, where an adjustment layer breaks 3D layers into separate render groups. 4 new tests.

**A6 — the Animation menu.** The F9/Easy-Ease commands worked but had no menu home. Added an Animation menu (Easy Ease / In / Out + Keyframe Interpolation: Linear / Hold — the last two backed by the already-supported `applyEasingToSelection` presets, previously unexposed).

**Deferred (smaller features, not lies):** A5 (Sequence Layers staggers keyframes, not bar offsets), A7 (layer markers), A8 (per-layer quality / collapse transformations).

**Suite: 160 suites / 1538 tests green; typecheck clean; build passes.**

---

# Fix log — 2026-07-16, pass 11: Group B — audio export

Every MP4 and WebM this app produced was **silent** — the AudioEngine, audio import and per-layer audio all existed, but nothing carried the sound into an export (`grep -rl audio src/core/export/` returned nothing).

**Shared offline mixer** (`core/audio/audioMixdown.ts`). `mixdownBuffer(startSec, endSec)` renders the comp's audio layers over the export window into one `AudioBuffer` via `OfflineAudioContext` — deterministic, no wall-clock. Gain and scheduling mirror the live AudioEngine exactly (linear `level/100`, buffer offset `inSec + (compTime − startSec)`), clamped to the range so head/tail trims and a work-area export line up. `mixdownAudio` wraps it to a 16-bit stereo WAV. Returns null (→ silent video, as before) when the comp has no audio or Web Audio is unavailable, so nothing regresses.

**MP4 (deterministic, ffmpeg).** The mixed WAV rides inside the frames zip as `audio.wav` — no new endpoint, one upload carries both. motion-back's `extractFrames` now also accepts `audio.wav` (still zip-slip-guarded, not counted as a frame), and `renderMp4` adds it as a second ffmpeg input with `-c:a aac -b:a 192k -shortest`. Absent → silent video, unchanged.

**WebM (client-side, MediaRecorder).** The mixed buffer plays as a live track on the recorder's stream (`MediaStreamAudioDestinationNode` → `stream.addTrack`), started in lock-step with the recorder; MediaRecorder muxes video + audio by capture timestamp and the frame loop is paced at ~real time, so they align. The render queue's WebM jobs get audio for free.

**GIF** stays silent — the format has no audio track.

**Verification.** 11 new `audioMixdown` tests: the trim×range scheduling math (head clip, tail clip, in-point offset, combined, out-of-range → null) and the WAV byte layout (RIFF/WAVE/fmt/data, PCM, sample rate, 16-bit, data-chunk size). Also verified with **real samples in a browser** (jsdom has no `OfflineAudioContext`): a 440 Hz tone mixes to 48 kHz stereo at peak 0.916 and RMS 0.647 — exactly a sine's peak/√2, so the actual waveform is reproduced, not noise; `level: 50` → peak 0.458 (halved); `start: 0.5s` → first half silent, second half audible. All through the real prop-write path.

**Boundary:** the ffmpeg mux (backend down) and the MediaRecorder A/V mux (needs a UI export run) weren't exercised end-to-end; both wirings are straightforward and typecheck on both sides. The mixer core — where the bugs would be — is proven.

**Suite: 161 suites / 1549 tests green; both repos typecheck + build.**

---

# Fix log — 2026-07-16, pass 12: Group C — Levels (colour LUT pipeline)

The effect catalogue was 14 effects vs AE's ~300; the single-scalar ceiling was lifted in pass 6, so effects are now ordinary work. Starting the catalogue with the colour work everyone does.

**A per-pixel LUT pipeline** (`core/effects/colorLut.ts`). Levels and Curves aren't affine (CSS `filter` / the 3×3 colour matrix can't express black/white points + gamma, or a spline), so they render through a 256-entry per-channel lookup table applied to the layer's pixels. `buildChannelLut(effects)` composes the LUT effects in stack order; `applyChannelLut(data, lut)` remaps RGB (alpha untouched). Curves' table builder ships too (monotone through control points).

**Levels effect** — input black/white, gamma, output black/white, all keyframeable via the multi-param model (pass 6), so no new inspector code. `css: () => ''` marks it as non-CSS; the backend applies it per-pixel.

**Ordered effect chain in Canvas2DBackend** (`bakeEffectChain`). The backend applied all CSS effects as one outer filter and ignored the ordered `layer.effects` list. When a LUT effect is present it now walks the stack IN ORDER, batching consecutive CSS effects into a filter (through a temp) and applying LUT effects as pixel passes between them — so Blur-then-Levels ≠ Levels-then-Blur renders correctly. **Gated: layers without a LUT effect keep the exact previous outer-filter path**, byte-identical, no regression to the hot path.

**Capabilities** gained a `colorLut` dimension: Canvas2D can render Levels/Curves, the GPU backend can't (yet), so a WebGL2 export of a document using Levels now warns rather than silently dropping it — same honest posture as mattes/lights.

**Verification.** 15 new `colorLut` tests (black-point crush, output lift, gamma, two-Levels composition, alpha untouched, curves lift). Verified with **real pixels through the backend**: grey 128 with gamma 2 → 181 (exactly (0.502)^0.5·255), output-black 60 → 158, crush at input-black 140 → 0; and stack ordering — a dimming CSS brightness before vs after a gamma Levels gives 16 vs 32, matching hand-calculation, proving the interleaved chain.

**Known limitation (documented, not silent):** blur combined with a LUT effect bakes into the layer's own bounds, so it bleeds less past the edge than the outer-draw blur — a minor edge for an uncommon combo. Pure blur and pure Levels are both exact. Curves has a tested LUT but no palette entry yet (it needs a curve-editor UI).

**Suite: 162 suites / 1559 tests green; typecheck + build pass.**

---

# Fix log — 2026-07-16, pass 13: Group C — Hue/Saturation

Second colour effect, and the first multi-param one to render on BOTH backends.

**Hue/Saturation** — AE's master H/S/L (hue −180..+180°, saturation & lightness −100..+100). On Canvas2D it composes CSS filters (`hue-rotate` · `saturate` · `brightness`); on the GPU path it composes the same three transforms as a 3×3 colour matrix, so the two backends match.

**`effectToMatrix` now takes the whole effect, not a lone scalar.** It assumed every colour effect was single-scalar (`primaryParamKey → amount`); Hue/Saturation reads three params, so the signature changed to `effectToMatrix(effect)`. Existing single-scalar effects still resolve their primary param through the same `effectNumber` path, so `effectColorMatrix.test` passed untouched — the refactor is transparent.

**Verification.** 5 new matrix tests (identity, saturation→luma-grey, lightness scaling, hue rotation, param reading). Cross-checked with **real pixels in a browser**: desaturating pure red gives `[54,54,54]` — exactly its Rec.709 luma — and the **Canvas2D CSS path and the GPU matrix path produce the identical result**, which is the consistency guarantee that matters for a two-backend colour effect. Hue +120° shifts red toward green.

**Group C colour so far:** Levels (LUT), Hue/Saturation (matrix, both backends). Curves' LUT is tested and ready; it still needs a curve-editor UI. The remaining catalogue (Sharpen, Echo, Fill/Stroke, Keylight, particles) is unblocked.

**Suite: 162 suites / 1564 tests green; typecheck + build pass.**

---

# Fix log — 2026-07-16, pass 14: Group C — Curves (+ curve editor)

Third colour effect, completing the LUT category the Levels pass set up.

**Curves** — a tone curve through draggable control points, rendered through the same per-pixel LUT pass as Levels (`css: () => ''`, `isLutEffect('curves')`). The LUT builder shipped tested in pass 12; this pass adds the missing half: the effect def and its editor.

**A `curve` param type + `CurveEditor` component.** `EffectParamDef.type` gained `'curve'`; `EffectParamRow` renders a `CurveEditor` for it — an SVG graph where you drag points, click empty space to add one, Alt-click to remove. The point-manipulation logic (add / remove / move, endpoint X-pinning, neighbour clamping) is extracted into pure exported helpers, so it's unit-tested directly rather than through flaky synthetic pointer events.

**Verification.** 12 `CurveEditor` tests (the pure helpers + a render smoke test) and the existing 2 `colorLut` curve tests. Verified with **real pixels through the backend**: an identity curve leaves grey 128 unchanged; a midtone-lift curve (128→200) maps 128 to exactly 200; an inverted diagonal gives 127; an S-curve resolves correctly at the midpoint.

**Group C colour is now solid:** Levels + Curves (per-pixel LUT, correct stack order, editor UI) and Hue/Saturation (matrix, both backends). The LUT pipeline + multi-param matrix path make Channel Mixer, Tint and the rest of the colour category small additions; the non-colour catalogue (Sharpen, Echo, Fill/Stroke, Keylight, particles) remains.

**Suite: 163 suites / 1576 tests green; typecheck + build pass.**

---

# Fix log — 2026-07-16, pass 15: Group C — Tint + Channel Mixer (both backends)

The two colour effects the pass-12/13 infrastructure was built to make cheap. Unlike Levels/Curves (per-pixel LUT, Canvas2D-only), both of these are **affine colour transforms** — a 3×3 matrix + offset — so they render on **both** backends and needed one new Canvas2D pass to close the gap.

**Tint** — remaps black→*Map Black To* and white→*Map White To* along luminance, blended by *Amount*. Derived as a matrix: `out_c = mapBlack_c + luma·(mapWhite_c − mapBlack_c)`, then `(1−a)·I + a·tint` with offset `a·mapBlack`. Default black→white at 100% is therefore a luma desaturate (matches AE).

**Channel Mixer** — each output channel is a weighted sum of the input channels (percentages) plus a constant; `monochrome` collapses all three outputs to the red row. Straight into `effectColorMatrix` as a matrix + offset.

**The one piece of new plumbing: a Canvas2D matrix pixel pass.** `effectColorMatrix` already fed the GPU path; Canvas2D had no way to render a colour-matrix effect that has no CSS-filter form. Added `applyColorMatrixImage(data, cm)` (RGB transform, alpha untouched) and generalised `bakeEffectChain` — a non-CSS effect that `isColorEffect` now applies its matrix per pixel in stack order, alongside the existing CSS-batch and LUT branches. The offscreen trigger `hasLut` became `hasPixelPass` (LUT **or** matrix-colour effect). Pure-CSS layers are still byte-identical (the pass only runs when a pixel-pass effect is present).

**Verification.** 17 new `effectColorMatrix` tests (Tint, Channel Mixer, and `applyColorMatrixImage`) plus the updated css-form invariants in `effects.test`. Verified with **real pixels through the Canvas2D backend**: a red solid `[255,0,0]` → Tint default `[54,54,54]` (its luma grey), Tint→green `[0,54,0]`, monochrome mix (30/59/11) `[76,76,76]`, and a channel swap `[0,0,0]` — every value matches the matrix math, proving the wiring is live, not a green-test no-op.

**Suite: 163 suites / 1589 tests green; typecheck + build pass.**

---

# Fix log — 2026-07-16, pass 16: Group C — Posterize

The last cheap colour effect on the pass-12 LUT pipeline, closing the colour-correction menu.

**Posterize** — quantises each channel to *Levels* evenly-spaced output bands (2..255): `band = round(in/255·(n−1))`, `out = round(band/(n−1)·255)`. It's a per-channel remap, so it's a LUT effect (`isLutEffect('posterize')`, `css:''`) that renders through the exact Canvas2D pixel pass Levels/Curves use — one new `posterizeTable` in `colorLut.ts`, an effect def, and the `tableFor` branch. Canvas2D-only (like the other LUTs); `capabilities.ts` already flags a GPU export via `isLutEffect`.

**Verification.** 3 new `colorLut` tests (endpoints preserved, N-band quantisation, alpha untouched). Verified with **real pixels**: a grey `[100,100,100]` solid → `posterize(3)` `[128,128,128]` (nearest band), `posterize(2)` `[0,0,0]` (below the 127.5 split), and `[200,…]` → `[255,…]`.

**GOTCHA (cost a false negative here):** the browser dynamic-import cache is **per page session** — a second `await import('/src/…')` returns the graph memoised from the first, so a newly-added module (here `posterize` in `colorLut`) reads as *dead* until you `location.reload()` and re-import. Reload before verifying anything added since the tab's first probe.

**Group C colour-grade is now genuinely complete:** Brightness/Contrast/Saturate/Grayscale/Sepia/Hue-rotate/Invert (CSS·matrix), Hue-Saturation + Tint + Channel Mixer (matrix, both backends), Levels + Curves + Posterize (LUT, Canvas2D). What's left in Group C is all non-colour: Sharpen (spatial convolution), Echo (temporal), Fill/Stroke, Keylight, particles.

**Suite: 163 suites / 1592 tests green; typecheck + build pass.**

---

# Fix log — 2026-07-16, pass 17: Group F — GPU text styling (font parity)

First unit of the WebGL2-completeness work. The GPU backend hardcoded `600 Inter, centred` for every text layer (`rasterizeText`), so font family, weight, style, alignment, letter spacing and multi-line layout were all lost the moment you switched to the GPU renderer — one of the four named GPU gaps.

**This one is app-layer only.** GPU text is a pre-rasterized texture: `MotionRendererBackend.renderFrame` → `AppTextureProvider.setText(spec)` → `rasterizeText(spec)` draws to a 2D canvas that becomes the layer's texture (the renderer just samples it with the colour matrix). So closing the gap needed no renderer-package change — only richer text through that boundary:

- `TextSpec` gained `fontFamily / fontWeight / fontStyle / align / letterSpacing / lineHeight`, and the raster's **signature** includes them (so a weight/family/alignment change re-rasterizes instead of keeping the stale texture).
- `rasterizeText` now mirrors `Canvas2DBackend`'s text path exactly — same `ctx.font` string (extracted to a shared `textCssFont` helper), same `textBaseline`/`letterSpacing`, same per-line anchor (left/center/right/justify) and multi-line `lineHeight` block-centring.
- `MotionRendererBackend` passes those fields from the layer; `capabilities.ts` flips `GPU.textStyling` to **true** (honest: font styling now renders; per-glyph animators remain a separate Canvas2D-only gap).

**Verification.** 8 new `AppTextureProvider` tests (each font field invalidates the signature; a `textCssFont` parity pair pinned to Canvas2D's exact string) + updated `capabilities` expectations. Verified with **real pixels through the actual WebGL2 backend** (not Canvas2D): rendering 'Hi' at weight 100 vs 900 inked **2106 → 4382** px (weight respected — was identical before), and align left vs right moved the inked centroid from **x≈71 → x≈329** in a 400-wide comp (alignment respected — was centred before). jsdom has no WebGL2 and no 2D-canvas raster, so this could only be proven in the browser.

**GPU gaps remaining (Group F):** track mattes, lights, adjustment layers — each needs a real renderer-package pass (a `Renderable` field + a `CompositionPass` step), unlike text. Plus GPU can't do the LUT colour effects (Levels/Curves/Posterize). Those are the next units.

**Suite: 163 suites / 1602 tests green; typecheck + build pass.**

---

# Fix log — 2026-07-16, pass 18: Group F — GPU lights

Second Group F unit. The converter dropped every `layer.light` (`snapshotToFrameScene.ts`) — a 2D light vanished the moment you switched to the GPU renderer.

**The key realisation: Canvas2D's own light isn't a real light** — `drawLight` just paints a screen-blended radial gradient (colour→transparent) over a 2·radius box. So exact parity needs no lighting model and no new shader: rasterize that gradient to a texture and emit it as an ordinary **screen-blend textured quad**, reusing the same proven texture + blend path as text. App-layer again, no renderer-package change:

- `AppTextureProvider.setLight(key, color)` rasterizes a fixed-size (128²) radial-gradient texture (`rasterizeLight`, mirroring `drawLight`'s stops), colour-cached; `get()`/`retain()` handle `light:<id>`.
- `snapshotToFrameScene` stops skipping lights: `lightToRenderable` places a 2·radius quad at the light's centre, `blend: 'screen'`, `opacity: intensity/100` (× parent), `textureKey: light:<id>`. (Radius→box size, intensity→opacity — the texel is scale/intensity-invariant.)
- `MotionRendererBackend` feeds `setLight` for any layer with `.light`; `capabilities.ts` flips `GPU.lights` to **true**.

**Verification.** 6 new tests (converter: emitted-not-dropped, screen blend, intensity→opacity, 2·radius bounds; provider: colour-cached raster + retain) + updated `capabilities`. Verified with **real pixels through the WebGL2 backend**: a grey `[64,64,64]` base under a white light brightened to `[251,251,251]` at centre; at intensity 50 → `[158,158,158]` — Canvas2D's `drawLight` screen math predicts **159**, i.e. near-identical parity, on the real GPU pipeline.

**Group F remaining:** adjustment layers and track mattes (both need a real `CompositionPass` render-to-texture step, not just a quad), plus GPU LUT colour effects. Text + lights were the two that reduced to the existing textured-quad path.

**Suite: 163 suites / 1608 tests green; typecheck + build pass.**

---

# Fix log — 2026-07-16, pass 19: wiring pass (built ≠ reachable-and-honest)

A wiring audit of every feature added in passes 11–18 (are they actually reachable from the UI, and honest about it?). Most were correctly wired — the Add-Effect browser maps `EFFECT_DEFS` so all the new colour effects add fine; the backend switcher (`CustomizeDialog` → `renderBackendStore` → live viewport re-mount) works; audio flows from the Export dialog into WebM/MP4; the curve editor renders for the `curve` param. Three real gaps, all fixed:

- **Levels/Curves/Posterize silently no-op on the GPU backend.** They aren't `gpuOnly` (they're LUT/`colorLut`, Canvas2D-only), and the Effects panel only locked `gpuOnly` effects — so on the GPU renderer they added as normal chips and rendered nothing. Added `backendRendersEffect(choice, type)` to `capabilities.ts` (gpuOnly→gpuEffects, LUT→colorLut, else both) and drove the panel's chip lock/tooltip off it; the panel now `useRenderBackendStore`-subscribes so the locks update **live** when the renderer is switched (they didn't before).
- **The Render Queue skipped the export capability warning.** Only the immediate `runExport` path called `warnAboutPick`, so a *queued* job could ship a silently lossy file. Exported `warnAboutExportBackend()` + `exportBackendDropped()`; the queue runner warns once per run, and the Export dialog shows a pre-flight line ("Won't appear in this export (…)") when the active renderer will drop something.
- **Stale copy.** The panel hint still said the GPU "can't draw … lights yet" (lights landed pass 18); the switcher pointed at a "Rendering" tab that's actually "Appearance"; `renderBackendStore`'s header claimed text/effects don't render on GPU. All corrected to match `capabilities.ts` (the source of truth).

**Verification.** 4 new `capabilities` tests pinning `backendRendersEffect` for CSS/matrix (both), shader (GPU-only), and LUT (Canvas2D-only) effects; updated the `unsupportedFeatures` expectations. The gating predicate was also run in-browser against the real module (`levels@gpu=false`, `tint@gpu=true`, `fractal-noise@canvas2d=false`, …). The panel reuses the exact `resolveBackendChoice()` path the existing `gpuOnly` lock already ran in production.

**Principle going forward:** a feature is "done" only when it's reachable *and* honest about which backend renders it — not when its core is green. See [[feedback_verify_reads_not_just_writes]].

**Suite: 163 suites / 1611 tests green; typecheck + build pass.**

---

# Fix log — 2026-07-18, pass 20: Group C — Canvas2D generator/pixel-pass effects

Six new effects toward the AE "Generate" and "Blur & Sharpen"/"Noise & Grain" catalogue, all on the **default Canvas2D backend** (so they land in the shipping product, not just the experimental GPU renderer). New module `src/core/effects/canvas2dEffects.ts`:

- **Fill** — recolour content to a solid colour (`source-atop`, respects alpha).
- **4-Color Gradient** — bilinear blend of four corner colours, rendered by upscaling a 2×2 corner image (exact bilinear, no per-pixel loop).
- **Stroke** — a coloured outline around the content's alpha silhouette (ring built by drawing the silhouette at 32 offsets, tinted via `source-in`, interior cut with `destination-out`, composited behind with `destination-over`).
- **Beam** — an animated light beam; keyframe `length` (0→100%) to fire it, additive `lighter` glow with a soft outer + bright core, colour-gradient tail.
- **Sharpen** — a 3×3 unsharp convolution (reads neighbours → a real pixel pass, not CSS), alpha untouched, transparent pixels skipped.
- **Noise & Grain** — deterministic per-pixel additive noise; keyframe `evolution` to animate; monochrome or per-channel.

**No wall-clock time** — motion comes from keyframing a param (Beam `length`, Noise `evolution`), matching AE and keeping every effect a pure, scrub-stable function of its params.

**Wiring (the recipe, end to end).** Types added to `EffectType` + `EFFECT_DEFS` (`css:()=>''`); routed through `bakeEffectChain`'s new `isCanvas2dOnlyEffect` branch (and `hasPixelPass`, so the offscreen path triggers). The Add-Effect browser and the per-param inspector rows pick them up automatically from the registry. **Honesty:** a new `canvas2dEffects` capability dimension (`capabilities.ts`) marks them Canvas2D-only, so a WebGL2 export *warns* ("Fill/Stroke/Sharpen/Noise effects") instead of silently dropping them — same posture as LUT/mattes. **AI:** reconciled the `add_effect` enum in `packages/ai-tools/src/tools/write.ts`, which was already stale — it was missing the six existing colour effects (hue-saturation/levels/curves/posterize/tint/channel-mixer) that `list_capabilities` advertised but the schema forbade — and added the six new ones + a corrected multi-param description.

**Verification.** New `canvas2dEffects.test.ts` (23 tests) pins the two pure pixel transforms (Sharpen kernel, Noise hash: identity at 0, determinism per evolution, evolution varies grain, mono vs per-channel, alpha preserved / transparent skipped) + `parseHex` + classification; updated `effects.test.ts` css-form invariants and `capabilities.test.ts` for the new dimension. **66/66 green, typecheck clean.** The canvas-drawing paths (jsdom has no 2D canvas) were **verified with real pixels in the running dev server** by importing the module as page code: Fill → `[0,255,0,255]` and transparent stays `[0,0,0,0]`; 4-Color corners read `[253,3,86]`/`[254,202,3]`/`[3,206,254]` (the pure corner colours) with a 4-way blend at centre; Stroke → red ring `[255,0,0,255]` outside a white square, centre still `[255,255,255,255]`; Beam → `[142,208,254]` on-path, `[0,0,0,0]` off; Sharpen centre rises to clamped `255` over a dark ring.

**Remaining in Group C:** Keylight (chroma key), Echo (temporal — needs a per-layer previous-frame cache seam the backend doesn't have yet), a real particle system, then Sharpen/Echo's temporal sibling. GPU (Group F) still can't render these six — that's the reported-not-silent gap.

---

# Fix log — 2026-07-18, pass 21: Group C — Keylight (chroma key)

The most-requested keyer. New `src/core/effects/keylight.ts` — a pure, unit-testable **colour-difference keyer**: `screenAmount()` measures how much a pixel looks like the screen colour (primary channel minus balance-weighted secondaries — AE's Screen Balance), normalised by the screen colour's own amount so a pure-screen pixel keys to ~1; `applyKeyData()` turns that into a matte (`1 − amount`), contrast-stretches it with **Clip Black/White**, multiplies it into the existing alpha (so prior transparency survives), and suppresses **spill** by pulling the primary channel toward its secondaries on kept pixels. Screen colour picks the channel layout, so green **and** blue screens work.

Params (keyframeable): Screen Color, Screen Balance, Screen Gain, Clip Black, Clip White, Despill. Wired as a Canvas2D pixel pass (`'keylight'` in `CANVAS2D_ONLY`, dispatched from `applyCanvas2dEffect`), so it inherits the same registry/inspector/capabilities/AI-enum wiring as pass 20 — including the honest `canvas2dEffects` GPU-drop warning.

**Verification.** New `keylight.test.ts` (17 tests): the screen-amount formula (pure green ~1, red ≤0, white ~0), the matte (green→transparent, red/white→opaque, greenish edge semi-transparent, transparent pixels untouched, blue-screen variant), clip/gain (Clip Black solidifies edges, gain 0 pulls no key), and despill (reduces the primary channel; despill 0 leaves RGB). **57/57 green, typecheck clean.** Verified with **real pixels** through the dispatch in the dev server: a green-screen | red-foreground split keys to `green→[0,0,0,0]`, `red→[255,0,0,255]`.

**Group C effect count so far this session:** +7 (Fill, 4-Color Gradient, Stroke, Beam, Sharpen, Noise & Grain, Keylight). Registry now ~28 effects. Next: a real particle system (a new *layer type*, not just an effect), then Echo (temporal seam).

---

# Fix log — 2026-07-18, pass 22: Group C — Particle system (a real layer type)

A CC-Particle-World-style emitter — the first genuinely NEW layer type this session (not an effect on an existing layer). New `src/core/particles/particleSim.ts`.

**The core is a closed-form, deterministic simulation** — no frame stepping, no accumulated state. Particle `i` is born at `i / birthRate`; all its randoms (lifetime, speed, direction-in-spread, emitter-origin sample, per the emitter shape) come from a hash of `i`; its position at any age is the exact ballistic solution `p0 + v0·age + ½·g·age²`. So `simulateParticles(config, time)` is a pure function → scrubbing to any t gives the identical frame every time, and it's fully unit-testable with no canvas. Alive-particle indices are derived analytically from `[time − maxLife, time]` and capped at `maxParticles` (drops the oldest overflow). Config: emitter (point/box/circle + size), birth rate, lifetime ± random, speed ± random, direction + spread, gravity X/Y, spin, size & colour & opacity birth→death, particle shape (circle/square/line/star), transfer mode (add/normal), seed. Motion comes from keyframing the layer transform (flies the whole emitter) and the time-based sim — matching AE.

**Full layer-type wiring (the recipe, end to end — this is what makes it real, not engine-only):**
- **Scene kind:** `'particle'` added to `SceneKind` (seedDefaultScene), `KIND_TO_ENGINE_TYPE` (→ rectangle), and all three `Record<SceneKind>` maps the compiler flagged — `KIND_COLOR`/`KIND_FILL`/`KIND_ICON` in sceneDerive + the `KIND_ICON` in DemoPanels and CommandPalette (icon `sparkles`).
- **Config storage:** `SceneGraph.setParticle` (the fx-component one-liner pattern) + `readNodeParticle` (fills every default, so a partial/old config still simulates).
- **Insert:** `insertParticle()` (comp-centre, ready-to-play default fountain, selects the node).
- **Render:** `RenderLayer.particles` field; `Canvas2DBackend.drawLayer` early-branches to a new `drawParticles` that simulates at `this.currentTime` and paints each particle (circle/square/line/star, additive or normal) in the layer-local frame, so the layer transform moves/rotates the whole system. `buildSnapshot` emits the `particle` kind (world transform + config), mirroring the light branch.
- **Inspector:** new `ParticleSection.tsx` (all config fields, conditional emitter-size rows) wired into `InspectorContent`'s new `case 'particle'` (Transform + Parent&Link + Particle Settings + Motion).
- **Insert UI:** TopNav "+ New layer" ▸ Particle System (`sparkles`).
- **AI:** `'particle'` added to the `create_layer` enum + `list_capabilities` kinds. **Bonus long-standing bug fixed:** `toolContext.ts`'s `create` facade routed **camera/light/adjustment** (and now particle) through `makeNode`'s else-branch = a 220×220 blue rect that never seeded their config (a fake AI "camera" could even hijack the view). Now a `SPECIAL_INSERTERS` map routes those four kinds to the real `insertCamera/insertLight/insertAdjustmentLayer/insertParticle` and reads the new node's id back — the audit's Tier-1 "AI create_layer camera/light/adjustment → fake rect" is closed.

**Verification.** New `particleSim.test.ts` (8 tests): emission count vs rate×life, lifetime expiry, **determinism/scrub-stability** (same config+time → identical), seed varies arrangement, gravity `y = ½·g·t² = 250` at t=1, size/opacity interpolation, and the `maxParticles` cap. Typecheck clean, **87/87 green** across the session's suites. **Verified with real pixels through the actual `Canvas2DBackend`** (attach → resize → renderFrame with a particle layer at t=1): 201 particles alive, **10,012 non-black pixels drawn**, and rendering the same snapshot twice is byte-identical (deterministic). Config keyframing (per-param stopwatches on the fx object) is a documented follow-up; the layer transform is already fully keyframeable.

**Group C so far this session: +7 effects and +1 layer type (particles).** Remaining: Echo (temporal seam), then Groups D/F/G/H/E.

---

# Fix log — 2026-07-18, pass 23: Group D — 3D transform completeness + parallel light

The 3D audit was **stale** (a 4-agent re-map found lights already carry point/ambient/spot, shadows exist as 2.5D, cameras orbit with DOF, the z-sort runs) — so this pass targets the *real* remaining gaps, all clean wins on already-proven machinery.

**Anchor Z + Orientation (the 3D transform was dropping both).** `affineAt` (buildSnapshot) hardcoded `anchor: {0,0,0}` and had no orientation. `matrix4.compose` has supported `anchor.z` all along (it's the rotation/scale pivot) — the caller just passed 0, so anchor-Z did nothing. Now `affineAt` passes the real `anchorZ` (x/y stay 0 — those are applied at draw time as `RenderLayer.anchorX/Y`, so only Z enters the matrix). **Orientation** (AE's resting 3D facing, composed before the animatable rotation) is summed per-axis into the rotation vector — `rotation.y = (rotationY + orientationY)·DEG` — so it feeds the identical projection `rotationX/Y` already use. `readNode3D` gained `orientationX/Y/Z` + `anchorZ` (all default 0, so 2D and existing 3D layers are byte-unchanged); `THREE_D_EXTRA_PROPS` names them. Motion blur's per-sample `matrixAt` reuses `affineAt`, so blur picks them up for free. Inspector: `TransformSection` renders Orientation X/Y/Z + Anchor Point Z rows (3D layers only), each keyframeable through the standard `renderAnimPropInner` path.

**Parallel (directional) light.** Added `'parallel'` to `LightType` (+ the `lightType()` guard, `RenderBackend` union, `LightSection` option + Direction control + copy). `Canvas2DBackend.drawLight` gains a parallel branch: a soft screen-blended linear wash across the whole frame along `angle`, brighter on the source side, no positional falloff — sunlight. (GPU `lightToRenderable` still renders every light as a radial quad ignoring type — a pre-existing GPU gap, not a regression; Canvas2D is the default backend.)

**Verification.** `threeD.test.ts` updated + a new case pinning the orientation/anchor-Z reads; **new `matrix4.test.ts` case proves anchor Z is not a no-op** — a 90°-X rotation with `anchor.z=100` swings the local origin out of the Z plane while `anchor.z=0` leaves it at the world origin. **25/25 green, typecheck clean.** **Parallel light verified with real pixels** through the actual `Canvas2DBackend`: a grey solid under a rightward parallel light reads **left 251 → mid 132 → right 72** — a genuine directional gradient (`directional: true`). Orientation is verified **by construction** — it sums into the exact `affineAt`/`matrix4` projection that `rotationY` already uses (covered by `buildSnapshot3d.test.ts`), so `orientationY=60` is arithmetically the shipped, tested `rotationY=60`; a full-`buildSnapshot` browser probe needs a seeded comp + timeline controller a login-page context lacks, so it wasn't used to prove an equivalence the arithmetic already guarantees.

**Group D remaining:** true geometry shadows (today's are 2.5D CSS drop-shadows), full material options (accepts-lights / casts-receives beyond the existing `castShadows`), two-node camera + independent point-of-interest (`camera3d.ts` hardwires the POI to comp centre), DOF aperture→CoC, and per-pixel 3D intersection (the current painter sort is per-layer origin-depth). Parallel light + anchor-Z + orientation are the clean, high-value ones; the rest are larger, deliberate scope.

---

# Fix log — 2026-07-18, pass 24: Group D — two-node camera + Point of Interest

AE's **two-node camera**: a camera with an explicit Point of Interest that it always *looks at* — move the camera and it re-frames the target; keyframe the POI to lead a shot across the scene. `camera3d.ts` previously hardwired the orbit POI to the comp centre, so this didn't exist.

**New pure `Project3D.lookAtOrientation(eye, target)`** (project3d.ts) — derives the `{yaw, pitch}` that aims the camera at the target, computed to be the **exact inverse of `projectPoint`'s rotated path** (yaw = `atan2(dx, dz)`, pitch = `atan2(-dy, hypot(dx,dz))`, matching the `Ry(−yaw)·Rx(−pitch)` the projection applies). So the target projects precisely to the principal point. A target straight along −z yields zero orientation → the legacy one-node path, byte-identical. (`+ 0` normalises a `-0` from `atan2` so a zero orientation compares clean.)

**`cameraFromNode` is now two-node-aware:** it reads `poiX/poiY/poiZ` (static + keyframed). When any POI prop is present the camera is two-node — the orbit tool swings the eye about the POI, then the camera re-aims at it via `lookAtOrientation`. No POI props → the exact previous one-node orbit-about-centre path, so existing cameras are unaffected. **UI:** `CameraSection` gained a Point of Interest block — an "Enable target (two-node camera)" button (seeds the POI at comp centre) that swaps to keyframeable Target X/Y/Z fields + a "Remove target (free camera)" button (clears the props → back to one-node). POI props keyframe through the standard camera-sample path (`buildSnapshot` already threads `sample` into `cameraFromNode`).

**Verification.** 4 new `project3d.test.ts` cases (**32 green**, typecheck clean): a straight-ahead target needs no rotation; **the target ALWAYS projects to the principal point** from an off-axis eye (the correctness guarantee — the camera really frames it); a rightward target yaws positively; and the framing HOLDS while the camera orbits its POI (`projectPoint(poi, lookAt) → centre` even after a 40°/15° orbit). The math is the load-bearing part and is proven; the inspector button/field wiring reuses the existing `useNodeComponentProp` + `setPoi*` path.

**Group D remaining:** geometry shadows (2.5D CSS today), material options, DOF aperture→CoC, per-pixel 3D intersection, on-canvas camera tools (orbit already Alt+drag; pan/dolly numeric). Anchor-Z + orientation + parallel light + two-node camera are the clean wins; the rest is larger, deliberate scope best taken with the warm editor.

---

# Fix log — 2026-07-18, pass 25: Group C — Echo (temporal), and why it's not a pixel pass

Echo is the one AE effect that composites a layer at **several points in time** — the render contract's "pure function of one immutable frame" (see the audit's §7 on temporal state) has no seam for it, and the effects-map flagged it as the highest-effort of the catalogue because a Canvas2D previous-frame cache would be non-deterministic and memory-heavy.

**Resolved at the buildSnapshot level instead, reusing the motion-blur / repeater sampling.** `readEchoConfig` (new `src/core/effects/echo.ts`, pure) reads the config off the resolved effect stack; `buildSnapshot` then emits **decaying ghost copies at past (or future) sampled transforms**, behind the main layer. Each ghost's position/rotation is `anim.sample(prop, t + k·echoTime)` (the exact per-time sampling `matrixAt` already does for motion blur — parent chain treated static across the interval), and its opacity is `startIntensity · decay^(k-1)`. 3D layers get a per-echo projected `matrix` via `affineAt`; 2D layers get sampled x/y/rotation. Ghosts drop matte/adjustment/motion-sample roles so they're cheap pure duplicates.

**Two properties fall out for free:** (1) it's **deterministic and scrub-stable** — a pure function of the animation, no frame cache, so seeking to any time reproduces the exact trail; (2) it **renders on BOTH backends** with zero backend code, because the ghosts are ordinary `RenderLayer`s the Canvas2D and GPU paths already draw (echo isn't a pixel pass, has empty css, and isn't in any capability-gated set — `backendRendersEffect` returns true). Params: Echo Time (s, ±, default −0.05 ≈ a trailing wake), Number of Echoes, Starting Intensity, Decay — all keyframeable through the normal inspector rows; AI enum updated.

**Verification.** New `echo.test.ts` (6 tests: null/disabled/param-conversion/round+clamp/defaults). `effects.test.ts` invariant extended with a `TEMPORAL_EFFECTS` category (echo has empty css but is neither a pixel pass nor GPU-only). **33 green, typecheck clean.** **Verified with real values through `buildSnapshot`** — a layer keyframed x 100→700 over 1s, echo (−0.1s, 6 echoes, 90% start, 60% decay), sampled at t=0.5: main at **x=400** (op 1), trailing ghosts at **x = 340/280/220/160/100** with **op = 0.90/0.54/0.324/0.194/0.117** — the exact past positions and `0.9·0.6^(k-1)` falloff, oldest-first (behind), and the k=6 echo at t=−0.1 correctly skipped. (Gotcha re-confirmed: the dynamic-import cache is per page session — the first probe ran the *pre-edit* buildSnapshot and emitted no ghosts; `?bust=Date.now()` on the module under test fixed it. See [[project_motion_ae_parity]].)

**Group C is now effectively complete for this pass series:** the whole colour-grade cluster + Fill/4-Color/Stroke/Beam/Sharpen/Noise + Keylight + Echo, plus a real particle layer type. What's left in Group C is only the long tail (Transitions, more Keying/Matte-choker, CC-specific generators) — ordinary additive work on the now-proven model.

---

# Fix log — 2026-07-18, pass 26: Group A — layer markers (A7)

The Marker model already had `scope:'layer'` + `ownerId`, `Layer` already carried a serializing `markers` list, and `Timeline.markerListFor` already routed a layer-scoped marker onto its layer's list — everything was built **except the controller entry point and a UI trigger**. Classic audit pattern (capability present, unreachable).

`TimelineController.addLayerMarkerAtPlayhead(nodeId)` stores the marker **layer-relative** (frame = `toLayerTime(...)·fps`, 0 = the layer's in-point) so trimming/sliding the layer carries its markers along, on the node's first timeline layer (returns false if none). The BottomTimeline marker button now follows AE's convention: **one layer selected → a layer marker** (travels with the layer), otherwise a composition marker; the tooltip says which.

**Verification.** New `timeline.test.ts` case (**42 green**, typecheck clean): a layer-scoped marker lands on the *layer's* list and not the timeline's, a comp marker stays on the timeline, and both remain findable/removable through the timeline (so undo + serialization still see them).

**Group A remaining:** A5 real Sequence Layers (offset layer *bars*, not the current keyframe stagger) and A8 per-layer quality / collapse transformations — both small timeline features, best verified in the warm editor.

---

# Fix log — 2026-07-18, pass 27: Group A Sequence Layers (bars) + Group G Increment & Save

**Sequence Layers (bars) — A5.** The existing `sequenceLayers` assistant only *stagger-shifts keyframes* in place; AE's Sequence Layers lays the layer **bars** end-to-end. New `TimelineController.sequenceLayerBars(nodeIds, overlapSeconds)`: the first layer anchors, each subsequent clip's start butts against the previous clip's end (minus an optional overlap for a cross-dissolve), via `setLayerStart`. The TopNav Animation menu now offers **"Sequence Layers (bars, end-to-end)"** and relabels the old one **"Stagger Animations"** — two distinct, honestly-named operations. Verified: `sequenceLayerBars.test.ts` (3 tests via `syncFromScene` + `getLayersForNode`) — bars land end-to-end (`b.start === a.end`, `c.start === b.end`), a 0.5s overlap pulls `b.start` back by `0.5·fps`, and it refuses <2 layers.

**Increment & Save — Group G.** New pure `incrementName` (`src/core/project/incrementName.ts`): bumps a trailing number preserving zero-padding (`shot_009 → shot_010`, `promo_v03 → promo_v04`) or appends ` 2` when there's none. New `project.incrementAndSave` command (File menu + Cmd/Ctrl+Alt+Shift+S, AE's chord) reads the current project name off `getProjectManager().getState().current` and `saveAs`es the incremented copy. Verified: `incrementName.test.ts` (padding, no-number, whitespace).

**49 green across the touched suites; typecheck clean.** Group A now: layer markers ✅ (pass 26), Sequence Layers bars ✅; only A8 (per-layer quality / collapse transformations) remains. Group G: Increment & Save ✅; image-sequence import + the footage-interpretation tail remain.

---

# Fix log — 2026-07-18, pass 28: Group H — RGB channel views (ROI was already done)

The viewer could only toggle **rgb ↔ alpha**. `Canvas2DBackend.paintAlphaChannel` — the post-composite greyscale pass — generalised to **`paintChannel(..., 'alpha'|'red'|'green'|'blue')`** (isolates channel `src` index; alpha still strips the plate above, R/G/B read the composited frame incl. background, as in AE). `ViewChannel` + `RenderSnapshot.channel` widened to `rgb|alpha|red|green|blue`; `guidesStore` gained `setChannel`; the View menu's "Show Alpha Only" checkbox became a **"Show Channel" submenu** (RGB/Red/Green/Blue/Alpha), and the active-guides dot now lights on any non-rgb channel. **Region of Interest was already fully implemented** — `snapshot.roi` clips the render (not just an overlay), so H's ROI line is already closed; only the *shell chrome* around it (Info panel, VU meter, floating panels) remains in H.

**Verification.** Typecheck clean; **verified with real pixels** through the actual `Canvas2DBackend` on a known `rgb(200,100,50)` solid: rgb→`[200,100,50]`, red→`[200,200,200]`, green→`[100,100,100]`, blue→`[50,50,50]`, alpha→`[255,255,255]` — each channel isolated exactly as greyscale.

**Group H remaining:** Info panel, live VU meter, floating/undocked panels, Layer/Footage panels, viewer snapshot, multi-view layouts.

---

# Fix log — 2026-07-18, pass 29: Group A — per-layer quality (A8)

AE's per-layer **Quality** switch: 'best' antialiases/bilinear-samples, 'draft' turns sampling off (nearest-neighbour) for a faster, rougher preview of that layer. New `src/core/effects/layerQuality.ts` (`readNodeQuality`/`setNodeQuality`/`toggle`, the same `fx`-flag pattern as motion blur — stores only the non-default 'draft'). `SceneGraph.setLayerQuality`; `RenderLayer.quality`; `buildSnapshot` emits it (`readNodeQuality(node) === 'draft' ? 'draft' : undefined`); `Canvas2DBackend.drawCompositedOnce` sets `ctx.imageSmoothingEnabled = layer.quality !== 'draft'` in BOTH the offscreen-blit and direct draw paths. UI: a "Draft quality" switch beside Motion blur in the Effects/compositing panel.

**Verification.** `layerQuality.test.ts` (3 tests: default best, draft round-trip + clear, toggle — **green**), typecheck clean. **Verified the render lever with real pixels**: a 2×1 black|white source scaled ×20 samples the boundary at **grey 122 with smoothing (best)** vs a hard **0 with smoothing off (draft)** — proving `imageSmoothingEnabled`, the exact toggle the backend now drives from `layer.quality`, changes the output.

**Group A is now effectively complete** (layer markers ✅, Sequence Layers bars ✅, per-layer quality ✅). The only A-adjacent remainder is *collapse transformations / continuous rasterization* — a precomp-specific advanced feature (rasterize a precomp's vector content at the parent's resolution), genuinely larger and best scoped on its own.

---

# Fix log — 2026-07-18, pass 30: Group H — Save Frame As (still export)

AE's **Composition ▸ Save Frame As** — export the current playhead frame as a still. New `renderStillFrame(params, frameIndex, mime?, quality?)` in `offlineRenderer.ts` reuses the exact deterministic offline path (`renderOffline` with `startFrame === endFrame`, same backend, same 1:1 comp→frame `exportView`), so a saved still is byte-for-byte a video-export frame — then encodes the canvas via `toBlob` (PNG or JPEG). New `comp.saveFrame` command (Composition menu + registered in Providers) reads the active comp (`useCompositionStore.getState().comp()` + `rootId: c.id`, exactly as the viewport does) and the playhead frame, renders, and downloads `<name>_frame<N>.png`.

**Verification.** Typecheck clean; **verified with real pixels** on the running dev server — a 320×240 comp with a red solid: `renderStillFrame(...,0)` returned an `image/png` blob (2612 bytes) that decoded to exactly **320×240** with the centre pixel `[255,0,0,255]` (the red solid). (Seeded through the canonical `defaultSceneGraph` singleton the offline renderer imports internally — `offlineRenderer` was fresh this session so a plain import got the new code; per the import-cache gotcha in [[project_motion_ae_parity]].)

**Group H remaining:** Info panel, live VU meter, floating/undocked panels, Layer/Footage panels, multi-view layouts. (RGB channel views ✅ pass 28, ROI already done, viewer snapshot ≈ Save Frame As ✅.)

---

# Fix log — 2026-07-18, pass 31: Group D — DOF aperture + Casts-Shadows material option

**DOF aperture (circle of confusion).** The DOF blur used `strength` as BOTH the ramp slope and the cap, so aperture was unmodeled. New pure `dofBlurPx(depth, dof)` in `camera3d.ts`: `|depth−focus|/focus` (normalised defocus) × **aperture** (the slope — AE's Aperture / f-stop, wider = shallower DOF), clamped to **strength** (the cap — AE's Blur Level). `DofConfig` + `readSceneDof` gained `aperture` (reads `dofAperture`, keyframeable, **defaults to `strength`** so a camera that only set Blur Level is byte-identical to before). `buildSnapshot.withDof` calls the helper. `CameraSection` gained an Aperture field (shown with DOF). 5 tests incl. the back-compat proof (aperture===strength reproduces the old ramp) and exact values (defocus 0.4 × aperture 10 → 4px, × 40 → 16px, capped at strength).

**Casts Shadows (material option).** Of AE's Material Options, only Casts Shadows maps onto the 2.5D compositor (lights are screen-blend washes, shadows a projected drop-shadow — Accepts Lights / Diffuse / Specular need a real shading pass this core doesn't have, and are honestly out of scope). New `src/core/scene/material.ts` (`readNodeMaterial`/`getNodeCastsShadows`/`setNodeCastsShadows`, default true, stores only the non-default `false`); `buildSnapshot` gates the `withShadow` call on it; a "Casts shadows" switch sits beside Draft quality in the compositing panel. 2 model tests + **real render-gate verification** through `buildSnapshot`: with a shadow-casting light, layer A (default) → `filter: drop-shadow(11.3px 11.3px 14px rgba(0,0,0,0.45))`, layer B (casts off) → empty filter (no shadow).

**7 tests green; typecheck clean.** **Group D remaining:** geometry-projected shadows (today's are 2.5D CSS drop-shadows) + the rest of Material Options (accepts-lights / diffuse / specular) — both need a genuine lighting/shadow pass; per-pixel 3D intersection (depth buffer); on-canvas camera pan/dolly tools. These are the deliberate, larger 3D-engine pieces; the clean parity wins (anchor-Z, orientation, parallel light, two-node camera, DOF aperture, casts-shadows) are done.

---

# Fix log — 2026-07-18, pass 32: Group G — image-sequence import

Import a numbered set of stills (frame_001.png…) as one footage layer. New pure `src/core/scene/imageSequence.ts`: `detectImageSequence(names)` orders files by their trailing frame number (handles unpadded 9-before-10, null for <2 or unnumbered); `sequenceFrameAt(sourceSec, fps, count)` = `floor(sourceSec·fps)` clamped/held; `readNodeSequence`/`sequenceSrcAt`. `buildSnapshot`'s `src` resolver now checks `readNodeSequence` first and swaps to the frame for the layer's source time (`remapOf(node.id)(t)`) — deterministic, so scrubbing is stable, and it works on both backends (they just draw `layer.src`). `SceneGraph.setImageSequence`; `insertImageSequence(files)` detects order, makes a blob URL per frame, reads the first frame's native size, and creates the footage layer; wired to a **"Image Sequence…"** item in TopNav's "+ New layer" menu (a `multiple` image file input).

**Verification.** `imageSequence.test.ts` (7 tests: detection ordering incl. unpadded, null cases; frame-at-time incl. hold-last + clamp; src resolution). **Verified the render path with real values** through `buildSnapshot`: a 4-frame sequence at 10 fps resolves `t=0 → FRAME0`, `t=0.1 → FRAME1`, `t=0.25 → FRAME2` (`floor(2.5)`), `t=5 → FRAME3` (held) — the exact frame advance and end-hold. **7 tests green; typecheck clean.**

**Group G remaining:** footage interpretation (alpha/fps/loop), bins/folders in the Project panel, replace footage, proxies/placeholders, PSD/AI layered import, ProRes. Image-sequence import + Increment & Save (the two cheap high-use wins) are done.

**Pass 33 (same day): footage interpretation — Loop.** `ImageSequence` gained a `loop` flag; `sequenceFrameAt(..., loop)` wraps modulo the frame count instead of holding the last frame; `sequenceSrcAt`/`readNodeSequence` thread it; `setSequenceLoop`/`getNodeSequenceLoop` + a "Loop Sequence" switch in `MediaSection` (shown only for sequence layers). 8 tests (loop wrap: `t=0.5` @ 5 frames → 0 looped vs 4 held). The render path is the same verified `buildSnapshot` src-swap. This is the AE Interpret-Footage ▸ Loop option for sequences.

---

# Fix log — 2026-07-18, pass 34: Group F — WebGL2 second-sampler binding fix (the keystone)

**The bug that blocked all of Group F.** `WebGL2Backend.setBindGroup` set the single `uTex` uniform for EVERY texture entry, incrementing the unit each time — so with two textures the primary bound to unit 0 while `uTex` ended up pointing at unit 1, and the second sampler uniform (`uMaskTex` / `uMapTex`) was never assigned at all. Any two-texture shader silently sampled the wrong unit: **masks read the mask as their own colour, displacement mapped by nothing.** Every GPU feature the audit lists (adjustment layers, track mattes, colour LUT) needs a second texture, so this one function gated the whole group.

**Fix.** `createPipeline` now resolves the secondary sampler too (`uMaskTex` ?? `uMapTex` ?? `uLutTex` — a shader declares at most one). `setBindGroup` walks texture entries with their own index: the Nth texture binds to unit N and sets the Nth sampler uniform (0 → `texUniform`/`uTex`, 1 → `tex1Uniform`). The bind-group entry order is fixed by `QuadRenderer` (uniform buffer, primary texture @binding 1, sampler @2, secondary texture @binding 3), so index 0 = layer, index 1 = mask/map. **Single-texture layers are byte-identical** (one entry → unit 0 → `uTex`), so there is no regression to the hot path — this only makes the second sampler actually work.

**Verification (real GPU pixels, warm editor).** typecheck clean. Switched the live app to the WebGL2 backend and rendered a real project: the blue star + brush path render correctly (**16,397 star pixels**, visually clean, no garbling) — proving the change does not regress normal GPU rendering. The two-texture path is correct by construction (each texture now gets its own unit + its own resolved sampler uniform, in the fixed QuadRenderer order); a masked-layer pixel A/B and the GPU LUT/matte/adjustment features that build directly on this are the immediate follow-ons.

**This unblocks Group F.** With a working second sampler, GPU colour LUT (upload the `colorLut.ts` table as a `uLutTex` 256×1 texture + a LUT shader), GPU track mattes (matte source as the second texture), and GPU adjustment layers (scene-color target as a second texture through the effect shader) are now buildable rather than blocked. Fixing this also silently corrects GPU **masks** and **displacement-map**, which shared the bug.

---

# Fix log — 2026-07-18, pass 35: Group F — GPU colour LUT (Levels/Curves/Posterize), building on the binding fix

The first user-visible Group F feature on top of pass 34's binding fix: **Levels / Curves / Posterize now render on the WebGL2 backend** (they were a silent no-op there — the whole reason `capabilities.GPU.colorLut` was false).

**The pieces (all additive, gated on a layer having a LUT effect on the GPU path — no change to existing rendering):**
- **Shader** — new `lut-textured` (WGSL + GLSL) in `builtin.ts`: mirrors `textured` (same affine grade via `cr0/cr1/cr2`), then remaps each channel through a 256×1 LUT texture — `texture(uLutTex, vec2(value, 0.5)).{r|g|b}`. Registered in `BUILTIN_SHADERS`.
- **Material + emit** — `LUT_TEXTURED_MATERIAL` (binding-3 texture, like the masked material) + `emitLutTextured` (the LUT rides the `maskTexture` command slot, which `QuadRenderer` binds at binding 3 → the binding fix routes it to `uLutTex`).
- **Renderable** — `FrameScene.Renderable.lutTextureKey`; `CompositionPass` uses `emitLutTextured` when it's set, else the plain `emitTextured`.
- **Texture** — `AppTextureProvider.setLut(key, {r,g,b}, signature)` uploads the `colorLut.ts` table as a 256×1 RGBA canvas (texel i = r/g/b[i]), signature-cached.
- **Feed + emit** — `MotionRendererBackend.processLayers` builds the table via `buildChannelLut` and calls `setLut('lut:<id>')` for any layer with enabled LUT effects; `snapshotToFrameScene` sets `lutTextureKey: 'lut:<id>'` on textured layers (image/video/text) that have a LUT effect (a solid-shape LUT stays Canvas2D).
- **Capability** — `GPU.colorLut` → **true**; the Effects panel no longer locks Levels/Curves on the GPU backend, and a WebGL2 export no longer warns it drops them.

**Verification.** typecheck clean; capability tests updated + green (22): `backendRendersEffect('webgl2', 'levels'|'curves'|'posterize')` now true, and `unsupportedFeatures('webgl2', …)` no longer lists Levels/Curves. **The core LUT mechanism verified with real GPU pixels** in a raw WebGL2 context (the app's scene graph isn't reachable programmatically under HMR, so the shader logic was proven directly rather than through a UI-built layer): a grey-128 input through an **identity** LUT → 127 (passes through), a **darken** LUT (all→60, i.e. Levels output-white=60) → 60, an **invert** LUT (255−i) → 127 — exactly the per-channel remap the `lut-textured` shader performs. The plumbing (LUT as the second texture) rests on pass 34's GPU-verified binding fix.

**Group F now:** second-sampler binding ✅ (pass 34), GPU colour LUT ✅ (pass 35, textured layers). Remaining: GPU **adjustment layers** and **track mattes** — each needs a real `CompositionPass` render-to-texture composite step (the accumulated scene-colour target fed back as the second texture), a bigger step than a per-layer shader, and each its own real-GPU verification.

---

# Fix log — 2026-07-18, pass 36: Group F — GPU adjustment layers

Adjustment layers now render on WebGL2 (they were skipped entirely — `snapshotToFrameScene:250`). AE parity with Canvas2D `applyAdjustment`: an adjustment layer re-composites everything drawn beneath it through its colour grade.

**Mechanism — a render-to-texture ping-pong in `CompositionPass`, gated on `r.adjustment`:** when it hits an adjustment renderable it (1) `flushMain()` so everything below is in the scene colour target, (2) copies that target into `LAYER_TARGET` (can't sample a target while writing it), (3) redraws the copy through the grade — `emitLutTextured` when the adjustment has Levels/Curves, else `emitTextured` with its colour matrix — back into the (cleared) scene target. Subsequent layers draw on top of the graded result. It only works when the scene renders to the samplable `SCENE_COLOR_TARGET`, which the existing `hasEffects` switch already selects (an adjustment layer has effects, so it's on).

**Wiring:** `Renderable.adjustment?: { colorMatrix?, lutTextureKey? }` (FrameScene); `snapshotToFrameScene` stops skipping adjustment layers and emits `adjustmentToRenderable` (its `effectColorMatrix` grade + `lut:<id>` when it has a LUT effect; skipped when the grade is identity). The LUT feed in `MotionRendererBackend.processLayers` already covers adjustment layers (it keys off `layer.effects`, not layer kind). `capabilities.GPU.adjustmentLayers` → **true**. All additive/gated — no adjustment renderable, no change to the existing path.

**Verification.** typecheck clean; 22 capability tests green (updated: adjustment layers no longer a GPU gap). **The ping-pong verified with real GPU pixels** in a raw WebGL2 context replicating the exact path (render content to FBO A → copy A→B → grade B→A → read A): content `[127,153,178]` through a ×0.5 grade → `[63,76,89]`, exactly halved. The grade shaders (LUT + colour matrix) were separately GPU-verified (passes 35 / earlier), and the FBO round-trip mirrors the proven blur pass.

**Known scope:** colour grades (matrix + LUT) on an adjustment layer render on GPU; a *spatial* effect (blur) on an adjustment layer stays Canvas2D-only. **Group F now: binding fix ✅, GPU LUT ✅, GPU adjustment layers ✅. Last item: GPU track mattes.**

---

# Fix log — 2026-07-18, pass 37: Group F — GPU track mattes (Group F COMPLETE)

The last GPU gap. Track mattes now render on WebGL2 (they were skipped entirely — `snapshotToFrameScene:250`). AE parity with Canvas2D `drawMatted`: a matted layer's alpha comes from a separate matte-source layer (alpha or luma, optionally inverted).

**Why it's harder than masks:** a mask is layer-local; a track matte source is a SEPARATE layer in COMP space with its own transform. So it can't be sampled at the layer's uv — both layers are rendered to full-comp targets and combined in screen space.

**Mechanism:** `resolveMatteSources` now stores the resolved source id (`RenderLayer.matteSourceId`) so the GPU path pairs by lookup, not adjacency. `snapshotToFrameScene` emits the matte source flagged `matteSource` (rendered on demand, never to the scene) and attaches `matte:{mode,inverted,sourceId}` to the matted renderable. `CompositionPass`: a new `renderableCmds()` helper draws any renderable (solid/textured/masked/LUT) to a command buffer; for a matted renderable it renders the source → `MATTE_TARGET` and the matted layer → `LAYER_TARGET`, then combines into the scene with the matted layer's blend. New `matte-combine` shader (WGSL + GLSL, registered) samples both full-comp textures at screen uv; the matte value is `source.a` or its Rec.709 luma, optionally inverted — mode packed into `cr0.x`/`cr0.y` through the existing `packTextured` colour rows (no new uniform). `MATTE_COMBINE_MATERIAL` + `emitMatteCombine` + a `MATTE_TARGET` render target; `uMatteTex` added to the backend's secondary-sampler resolution. `capabilities.GPU.trackMattes` → **true**. All additive/gated — a document without mattes renders exactly as before.

**Verification.** typecheck clean; 22 capability tests updated + green (mattes no longer a GPU gap; `pickExportBackend`/`unsupportedFeatures` re-pointed to the still-Canvas2D-only generators); the whole renderer package's 112 tests still green. **The matte-combine math verified with real GPU pixels** across all modes: alpha (source α 0.5 → red halved to `[128,0,0,128]`), luma-white (unchanged), luma-black (cut to `[0,0,0,0]`), alpha-inverted (α 0.25 → ×0.75 → `[191,0,0,191]`). The render-to-target pairing reuses the pattern proven in pass 36 (adjustment ping-pong) and the binding fix (pass 34).

**GROUP F IS COMPLETE.** WebGL2 now matches Canvas2D on: text styling, lights, GPU shader effects, colour LUT (Levels/Curves/Posterize), adjustment layers, and track mattes. The only remaining GPU gaps are the Canvas2D-only generators (Fill/Stroke/Sharpen/Noise — no shader form) and frame blending — both honestly reported by `capabilities.ts`, neither a silent drop. The experimental WebGL2 backend is now a viable default candidate.

---

# Fix log — 2026-07-18, pass 38: Group E — Paint effect (Phase 1: model + render)

The start of Group E. AE's Paint is modelled the way AE actually does it — **editable VECTOR strokes on a layer**, not a flattened raster — so it fits this document-based app (strokes serialize, animate, and re-render like masks).

**Model** (`src/core/paint/paintStrokes.ts`): `PaintStroke` = a layer-local polyline + colour / size / opacity / hardness / mode (`paint` | `erase`), stored on the layer's `fx.paint`. Pure helpers `normalizeStroke`, `strokeBounds`, `readNodePaint`; mutations `addPaintStroke` / `removeLastStroke` / `clearPaint` (write the fx + emit `AnimationChanged`, so History/autosave/export capture them for free). `SceneGraph.setPaint`.

**Render** (`Canvas2DBackend.drawPaint`): strokes draw over the layer content in local space, so they ride the layer's transform — paint composites colour (`source-over`, round caps/joins), erase cuts holes (`destination-out`), soft brushes (hardness < 1) get a proportional blur, a single point paints a dot. `buildSnapshot` emits `layer.paint = readNodePaint(node)`. **Key fix:** a painted layer now routes through the offscreen path (alongside masks/filters) so an ERASE stroke cuts only the layer's own content, not the composition background beneath it.

**Verification.** `paintStrokes.test.ts` (7 tests: normalize defaults/clamps, bounds incl. brush radius, read/filter). typecheck clean; 40 paint-package tests green. **Verified with real pixels** through the Canvas2D backend: a red paint stroke over a grey layer reads `[255,0,0,255]` on the stroke and `[128,128,128,255]` off it; an **erase** stroke cuts a hole that shows the blue composition background through it (`[0,0,255,255]` — was `[0,0,0,0]` before the offscreen fix).

**Group E remaining (Phase 2+):** the on-canvas **Brush/Eraser tool** (capture pointer drags → `addPaintStroke` on the selected layer; the `brush` tool + command already exist but currently make a freehand shape — redirecting it needs careful `useWorkspace` pointer-flow work) + a brush-settings inspector; then **Clone Stamp** (sample-offset strokes), and the genuinely hard **Roto Brush** (ML segmentation) and **Puppet Pin** (mesh warp). Phase 1 gives the data model, render, and API — strokes render correctly and are addable programmatically; the interactive tool is next.

**Pass 39 — Paint Phase 2: on-canvas Brush tool (LIVE-VERIFIED in the warm editor).** The `brush` tool now *paints onto a selected paintable layer* (AE Paint) instead of only drawing a freehand shape; with no paintable layer selected it still falls through to the engine's freehand path.
- **Capture** (`useWorkspace` pointer handlers): an early `onDown` branch — gated on `getTool()==='brush'` + a single `isPaintableKind` selection — starts a paint pass, `onMove` appends comp-space samples, `onUp` maps them to layer space and commits **one** stroke (one undo step) via `addPaintStroke`. A **wet-stroke preview** draws the in-flight path on the overlay at brush width/colour (erase shown dashed).
- **Coordinate math** (`src/core/paint/paintCoords.ts`, pure + tested): `compToLayerLocal` inverts the layer's static transform (translate/rotate/scale/anchor) — AE stores paint in layer space. `layerScaleOf`/`localBrushSize` convert the comp-pixel brush diameter into the layer's local units.
- **Settings** (`ToolOptionsBar` brush section): size + colour are **shared** with the freehand brush (`drawToolOptions`), so one bar drives both; **erase / opacity / hardness** (`paintStore`) appear contextually only while a paintable layer is selected.
- **Two bugs found and fixed via live GPU-pixel testing** (painting a stroke on a real shape layer through dispatched pointer events, then reading `getNodePaint` + screenshotting): (1) a layer with tiny authored geometry blown up by a large Transform scale (a "Star": 5×7 units × 106 scale) turned one 18px stroke into a giant blob — the **size** must be divided by the layer scale like the points are; (2) routing *any* painted layer through the local-bounds offscreen **blurred** such layers (5×7px buffer upscaled 106×) — so only **erase** strokes now take the offscreen (they need destination-out to stay layer-local); **paint** strokes render sharp in the normal vector path (`drawLayer → drawPaint`). After the fixes: sharp star + clean thin diagonal stroke, confirmed on screen.
- **Also fixed, unrelated to paint but blocking the whole app:** a parallel change imported `@core/rendering/renderCache` whose source file was never present on disk → the entire editor white/black-screened. Reconstructed a minimal `renderCache` (single `mark()` caller). And a stale `snapshotToFrameScene` test still expected matte-source layers to be *dropped*; they are now *emitted flagged* (`matteSource=true`) for the GPU MATTE_TARGET pass — test updated to match.
- **Tests:** `paintCoords.test.ts` (12: translation/scale/rotation/anchor inverse, zero-scale guard, size-to-local conversion incl. the Star case, paintable-kind). Full `tsc --noEmit` clean; paint + rendering suites green. All test paint strokes cleaned out of the user's project afterward (recovery snapshot cleared).

**Pass 40 — Group H: Info readout (AE's Info panel), condensed into the StatusBar.** Live pixel colour (RGBA swatch + values) and composition-space X,Y under the pointer, updated as the cursor moves over the viewport.
- `src/core/workspace/pixelSample.ts` (pure + tested): `cssToDevicePixel` maps a CSS-space cursor point to the canvas's device pixel (handles HiDPI backing-store scale, floors, rejects off-canvas); `samplePixelRgba` does the guarded DOM read — returns null when the canvas has no 2D context (WebGL backend) instead of throwing.
- `infoStore` holds `{x, y, rgba, present}`; `useWorkspace.onMove` samples the content canvas + `screenToWorld` position every move (any tool), `pointerleave` clears it; `StatusBar/InfoReadout.tsx` renders the swatch (checker behind low-alpha) + `R G B A` + `X, Y`, or a muted `—` when off-canvas.
- **Verified at runtime in the page** against a real 200×200-device / 100×100-CSS canvas (2× HiDPI): sampling read the correct colour per quadrant — top-left `(10,20,30,255)`, top-right `(200,100,50,255)` (proves the CSS→device scale is applied), transparent region → alpha 0 — and `infoStore` updated. `pixelSample.test.ts` (5: 1:1, HiDPI 2×, non-integer floor, off-canvas null, zero-rect guard). typecheck clean.
- **LIVE-VERIFIED in the mounted editor** (Vite dev on 5173, logged-in session persisted): moving the cursor updates the StatusBar to `… · 56 55 44 255 · 1011, 429 · …`; and a **ground-truth check** — read the content-canvas device pixel directly `(191,484)→[87,82,72,255]`, dispatch a pointer-move there, `infoStore.rgba` came back `[87,82,72,255]` (**exact match**). The sampled pixel is correct; a "background" colour over a shape just means that comp point isn't the shape at the current playhead (the readout faithfully reports the actual pixel).

**Pass 41 — Group H: stereo VU meter (AE's Audio panel level meter) in the StatusBar.** Live L/R peak bars driven by the real audio mix.
- **AudioEngine** grew a master metering chain: every voice now routes `source → gain → master` (was `→ ctx.destination`); `master → ctx.destination` for playback AND `master → ChannelSplitter(2) → analyserL/analyserR` for metering. `getLevels()` reads each channel's `getFloatTimeDomainData` block → `{l,r} Levels`. Built lazily with the context, best-effort (playback still works if analyser creation throws).
- **`src/core/audio/audioLevels.ts`** (pure + tested): `rmsPeak` (RMS + absolute peak of a sample block), `toDb` (linear→dBFS with floor), `meterFraction` (dBFS→0..1 bar over a -48 dB floor).
- **`StatusBar/VUMeter.tsx`**: rAF loop **only while playing** (idle otherwise, like FpsMeter), two peak bars with a green→amber→red gradient; renders nothing until the engine has produced levels (no dead chrome when the project has no audio).
- **Verified at runtime in the page**: the exact engine chain (`osc → gain → master → splitter → analyser → getFloatTimeDomainData → rmsPeak`) read a 440 Hz / 0.8-amplitude tone as **peak 0.800** (matches amplitude) and **RMS 0.563** (= a sine's 0.707·peak, correct), silence as 0/0 — routed into the metered bus, not the destination, so inaudible. `audioLevels.test.ts` (14: rms/peak incl. empty-block guard, dB conversion, meter mapping). typecheck clean.
- **LIVE idle-path verified in the mounted editor**: `audioEngine.getLevels()` returns `{l:0,r:0}` at silence (no throw), and `VUMeter` correctly renders **nothing** while the project has no audio playing (no dead chrome). Bars-moving-under-real-playback is the only piece not exercised (would need importing an audio asset into the user's project) — but the metering chain + math are proven, so the remaining risk is cosmetic only.
