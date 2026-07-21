# Motion Editor — Master Plan (from the full AE-comparison audit)

**Date:** 2026-07-16
**Basis:** three audit rounds (4-agent AE-parity audit → implementation feedback round → full from-zero sweep of menus, 3D, export, UI chrome). All findings code-verified. Current state: 163 test suites / 1,613 tests green.

**Where we are:** ~60–65% of an After Effects core. The consistent pattern: **engines are stronger than the UI lets users feel.** The plan therefore front-loads perception-changing UI work, then closes real capability holes, then deepens pro features.

---

## Phase 1 — Inspector overhaul: inline styles (the perception unlock)

**Why first:** every "styles are thin" complaint traces to one pattern — grid cells that open popovers, so no control is ever visible. The style inventory is already competitive; presentation hides it.

Tasks:
1. Replace the popover-in-grid pattern in `TransformSection`, `AppearanceSection`, `TextSection` with always-visible inline rows (ValueField / ColorPicker / select per row). Keep the stopwatch left of each row label, AE-style.
2. Merge the Effects dock content into the Properties inspector as sections: *Effects* (browser + stack), *Masks*, keeping the standalone panel as an optional dock.
3. Section order per AE convention: Transform → Fill → Stroke → Text → Effects → Layer Styles → Blend & Opacity → Masks → Geometry ops.
4. Multi-select styling: drop the `selected[0]`-only read in `DemoPanels.tsx:InspectorContent`; write to every selected node; show mixed-state dashes.
5. Curated **Camera** inspector (position/POI, focal length with zoom presets, DOF placeholder) and **Light** inspector (type, color, intensity, radius) replacing the raw `NodeInspector` dumps.

Done when: fill color, stroke width, font weight, shadow are each **one click or less** away for a selected layer (today: 3).

## Phase 2 — Timeline & keyframe control polish

1. Switch-column header row (icons for Shy · fx · MB · Adj · 3D) so the five toggles are self-explanatory.
2. Drawn SVG easing-pill icons replacing the text glyphs (◆⌒◆ …).
3. Per-layer In/Out/Duration numeric columns (toggleable, AE's column model).
4. Layer markers (comp markers exist; add per-layer, with labels).
5. Speed-graph influence editing (vertical drag on speed mode = influence, not retime) + Keyframe Velocity dialog (engine support exists: `applyVelocityToKeyframes`).
6. `Alt+Shift+P/S/R/T` add-keyframe chords.

## Phase 3 — Workspace feel (pro hands)

1. Tool-options strip under the top bar (contextual: star inner-radius, stroke width for pen/pencil, font for text tool). Future brush home.
2. Middle-mouse-drag pan; zoom % toast while wheel-zooming; cursor feedback when Space is held.
3. Theme every remaining hardcoded overlay color (snap `#ff3ba7`, HUD pill, camera/light guides) via `--color-*` tokens (pattern: `useWorkspace.ts:725`).
4. Populate the viewport corner-HUD slots (`workspaceExtras`, currently dead) with resolution + view controls.

## Phase 4 — Effects: close the dead-GPU hole + families

1. **Canvas2D fallbacks for gradient-ramp and fractal-noise** (the two most-used mograph effects; value-noise implementation is fine for fractal noise). Then displacement-map and motion-tile.
2. Add families in priority order: Distortion (warp, bulge, twist), Time (echo, posterize-time), Keying (color key, luma key — even basic versions).
3. Per-effect masking/compositing options (mask reference per effect).

## Phase 5 — Drawing & shape pro tools

> **Status 2026-07-17: items 1 + tool-options strip DONE** (BrushTool pressure
> ribbon w/ taper in packages/workspace `ribbonOutline`; `drawToolOptions`
> singleton; ToolOptionsBar under the toolbar with brush size/taper/pressure/
> color, pencil width/color, polygon sides, star points/inner ratio; filled
> live preview; 'brush' registered across uiStore/TOOL_MAP/TopNav/palette;
> unit tests in packages/workspace/src/__tests__/brush.test.ts).

1. ~~**Brush engine v1**~~ ✅ pressure-driven width, taper, options UI.
2. ~~Multiple fills/strokes + gradient strokes~~ ✅ fx.fills[]/fx.strokes[] stacks w/ legacy mirroring (fills[0]↔fx.fill), renderer draws stacks bottom→top, Stroke.paint gradient (Canvas2D), Appearance UI add/remove rows + stroke Paint select.
3. ~~Shape operators~~ ✅ COMPLETE incl. **Merge Paths**: boolean union/subtract/intersect/exclude across selected shape layers (right-click → Merge Paths), backed by `polygon-clipping` (Martinez–Rueda); beziers flattened, world transforms honoured, base layer donates style, holes emit as separate layers (documented v1).
4. ~~On-canvas gradient handles~~ ✅ angle knob (linear) + center/radius knobs (radial) on the overlay, drag-wired, keyframe-aware.
5. Panel thumbnails: real rendered previews for Components; styled shape icons.

## Phase 6 — 3D usability package

1. ~~Camera navigation~~ ✅ COMPLETE: pan (drag glyph), Alt+wheel dolly, Reset button, and **real ORBIT** — Camera3D gained yaw/pitch orientation in Project3D.projectPoint (identity-preserving at 0/0), orbitCamera() swings the eye about the comp-centre POI keeping it framed, keyframeable orbitYaw/orbitPitch camera props, **Alt+drag with the camera selected orbits on canvas**, Yaw/Pitch rows in the Camera inspector. Selection overlay unified onto readSceneCamera so outlines track orbit.
2. ~~Light types~~ ✅ point / **ambient** (uniform lift) / **spot** (direction+cone, radial falloff), keyframeable angle/cone, inspector Type select. Shadows still open.
3. ~~Depth of field~~ ✅ camera dofStrength + focusDistance props (keyframeable), linear |depth−focus|/focus ramp capped at strength, appended to the layer filter. Inspector: Blur strength + Focus distance.
4. Draft-3D toggle; camera POI (point of interest) model with auto-orient. (open)

## Phase 7 — Text depth

1. ~~Variable font weights~~ ✅ fontCatalog.ts maps installed fonts' style names → numeric weights per family; Weight dropdown now lists what the family actually ships (fallback: standard five).
2. ~~Per-character static styling (rich runs), text-on-path, paragraph spacing~~ ✅ **ALL THREE DONE.**
   - **The real deliverable was a shared layout pass.** `Canvas2DBackend`'s text case and `AppTextureProvider.rasterizeText` were parallel copies of the same line-split/align/lineHeight arithmetic kept in sync by a test comment (`textCssFont` was *documented* as shared but Canvas2D re-inlined it). New pure `core/text/textLayout.ts` — `layoutText(text, style, measure, {runs, transforms, boxWidth})` → placed glyphs; measurement is injected so it is unit-testable without a canvas.
   - **Two live bugs fixed on the way in:** `drawGlyphs` ignored `align` and `lineHeight` entirely (hard-set `textAlign:'center'`, one baseline at y=0), so an animated left-aligned or multi-line layer silently drifted from the whole-string path; and the Canvas2D fast path ignored `paragraphSpacing`, which would have shipped the new control dead for ordinary text. **Both paths now pixel-verified identical** (spread 62/62 unspaced, 100/100 at spacing 40).
   - **Model:** `__runs: RichRun[]` on `Text.props`, following the `__animators` precedent (hidden from the generic inspector, JSON round-trips for free). Indexed over `[...text]` code points — the same index space `unitPositions()` uses. `richText.ts` normalizes (disjoint/sorted/clamped, overlaps merge field-wise last-wins), re-indexes across content edits, and reports `styleOverRange` + `mixed` so the inspector can say "Mixed" instead of showing char 0 and overwriting the selection.
   - **Wiring:** `textEditStore` gained a real `{start,end}` selection driven by a `selectionchange` listener on the overlay's contentEditable (it force-selected all and nothing read it); DOM offsets → code points via a walker that counts `<br>` as a newline (a Range's `toString()` does not, so every offset after a line break was short by one). `TextSection`'s six character controls route to the range when one exists and stay layer-wide when it doesn't; `align`/`lineHeight` stay layer-wide always (paragraph properties); the keyframe toggle is disabled over a range because runs are static by design.
   - **Verified real pixels (Canvas2D):** four identical glyphs, run over the first two → red 1473 / white 1475 (exact half-split), red centroid x=158 left of white x=241, straddling the plain centroid 199. Per-run `fontSize` 60→100 widens the line 163→216px, proving per-glyph measurement re-places downstream glyphs. **GPU path is wired + typechecked but NOT pixel-verified** — a standalone `MotionRendererBackend` probe renders nothing at all (even baseline text), so it needs the app's texture provider; re-verify in the real viewport.
   - **Text on a path** ✅ `core/text/textPath.ts`. The path is one of the text layer's **own masks**, exactly as AE models it — which also means it inherits a real on-canvas path editor (Direct Selection already edits `maskPaths`) instead of needing cross-layer geometry refs, which nothing in the scene graph has. `trimPath.ts` gained `arcTable` (cumulative lengths, built once) + `pointAndTangentAtLength` (binary search; `pointAtLength` computed the segment direction and threw it away, and was O(n) per lookup = O(glyphs x verts) per frame). Off an open path it **extrapolates along the end tangent rather than clamping** — clamping piles every overflowing glyph on the last vertex. `applyTextPath` maps laid-out glyphs onto the curve: horizontal offset within the line → arc length, vertical offset → displacement along the path normal (so multi-line rides in parallel and animator `dy` still lifts a glyph off it), and `align` keeps meaning (left starts at the path start, right ends at its end, centre straddles the middle). Config is `fx.textPath` via the `setTrimPath`/`setMask` one-liner pattern (`SceneGraph.setTextPath`); `firstMargin` is keyframeable = the text crawl. Flattening is 24/segment (the 8 used for boolean ops is visibly faceted at glyph scale) and happens once per frame in buildSnapshot, so backends get plain geometry.
   - **Text-path UI**: Path Options in TextSection — Path select (lists the layer's masks, None clears), First Margin (keyframeable), Reverse Path, Perpendicular. With no masks it says *why* it's empty ("Draw a mask on this layer to use it as a text path") rather than showing a dead dropdown.
   - **Verified real pixels**: on a semicircle (r=90, apex at local y=−90), centred text moves from the flat baseline y≈148 to **y 57–77** — the apex after the 0.92 fit is y≈67 — while staying centred at x≈200; `firstMargin: 80` crawls it to x 242–285 / y 73–121, descending the right-hand side. 19 geometry tests + 6 boundary tests (mask deleted → falls back to ordinary text rather than empty geometry).
   - Suite **173/1764** green (local mirror). GOTCHA for future probes: a mask is in **layer-local** space (centred 0,0), not comp space — building a test arc around the layer's comp position puts the text in the wrong quadrant and reads as a bug.
3. ~~Animator upgrades (partial)~~ ✅ **wiggly selector** (deterministic per-unit noise over time, keyframeable Wiggles/sec) + **per-glyph Skew** (keyframeable, sheared in Canvas2D). Open: second selector per animator, per-glyph blur.

## Phase 8 — Preview & media performance

1. ~~Real frame cache (RAM-preview)~~ ✅ `frameCache.ts`: byte-budgeted (512 MB) LRU of rendered frames, keyed by scene rev + anim rev + view + quality + comp + guides; viewport blits cached frames (Canvas2D backend); honest green cache bar under the timeline ruler (`cachedRanges` on the model, 250 ms-throttled).
2. ~~Frame blending for retimed video; audio waveform in timeline; convert-audio-to-keyframes~~ ✅ ALL DONE. `waveform.ts` draws the envelope in the track; `audioKeyframes.ts` writes an `audioAmplitude` track from per-frame RMS, wired to a button in `AudioControls.tsx`.
   - **Frame blending** ✅ `core/rendering/videoFrameCache.ts`. **`frameBlend` was not a missing feature — it was a lying one**: `layerTime.ts` has defined `FrameBlend = 'none' | 'mix'` and the Time Controls dropdown has written it since Prompt E6, and nothing ever read it (`layerTime.ts` even said "applied to real frames once the asset pipeline exists"). The flag was never the missing part: **a second frame was.** Both backends kept ONE `HTMLVideoElement` per source, which holds exactly one frame, so seeking to "the frame after" destroyed "the frame before" — and a `> 0.05s` seek deadband (≈1.5 frames at 30fps) actively rejected the sub-frame seeks blending needs. So: a hidden element per source now does nothing but fill a byte-budgeted LRU of decoded frames (queue → seek → capture-on-`seeked` → store), the renderer asks synchronously, a miss schedules a decode and repaints via the `AnimationChanged` contract that already existed. `buildSnapshot` resolves the bracket (it knows the comp fps; a backend does not) and emits `frameBlend: {a, b, weight}` for video layers only.
   - **KNOWN LIMIT, stated in the module header:** we cannot read a source's real frame rate. `requestVideoFrameCallback` is the only API that exposes true frame times and **it does not fire for a detached element — measured, paused AND playing, every probe timed out**. So we bracket on the comp's rate: exact when source fps == comp fps; degrades to nearest-frame (never a wrong image) when lower; slightly soft when higher. Exactness needs a demuxer (WebCodecs + mp4box) or an ffprobe pass in `electron/`. An earlier draft *did* ship an rVFC probe — it was deleted rather than kept, because it silently fell back to 30 every single time and would have read as a measurement.
   - `capabilities.ts` gained `frameBlending`: **true** on Canvas2D, **false** on GPU (it uploads one video texture per layer, overwritten in place — no second frame to blend toward), so an export warns instead of quietly dropping it.
   - **Verified real pixels** through the backend on a generated 10fps clip whose frames are known greys (A≈24, B≈50): weight 0.25 → 31, 0.50 → 37, 0.75 → 43 — linear, monotonic, and every value lies strictly between the two source frames, which a nearest-frame pick can never produce. Suite **175/1785**.

## Phase 9 — Hardening & release readiness

1. ~~Wiring sweep~~ ✅ agent-audited all 8 remaining surfaces (Project/Assets/Scene/History/Comments/RenderQueue/Export/menu bar): **zero dead or stub handlers**. Fixed the two findings: Graph Editor tooltip said Shift+G but the AE preset binds Shift+F3; unregistered menu commands now render disabled instead of silently no-oping.
2. ~~Perf baseline + first fix~~ ✅ measured (50 L 1.6 ms · 150 L ~5–10 ms · 300 L ~17 ms), and the identified O(n²) — `getLayersForNode` full-filter per node per frame — is FIXED with a memoized sourceId→layers index (invalidated on track/array/length change + explicitly in syncFromScene).
3. ~~Backend render pipeline: finish the remaining 4-of-5 export formats server-side~~ ❌ **WITHDRAWN — the premise was wrong.** The editor renders every format client-side (webm/gif/png-seq/json/lottie via `core/export/exportManager` + the offline renderer); the server never rendered 4-of-5, it muxes **mp4 only**. The server's json/lottie/png/webm paths were dead code the app never called (png/webm hardcoded to throw) and were deleted along with `render.payload.ts` and the `drain()` queue. `render.dto.ts` now pins `@IsIn(['mp4'])`. Rasterizing is client-owned by design (the client has the scene graph, fonts and GPU) — building these server-side would undo that deliberately.
   ~~Real remainder in motion-back~~ ✅ **ALL THREE DONE** (motion-back, 5 suites/39 tests green, verified against real ffmpeg 8.1.1):
   - **`FFMPEG_PATH`** — `RenderWorker.ffmpegBin` reads it (whitespace = unset → `ffmpeg` from PATH). `validateEnv` refuses to boot when it points at nothing, on the same "half-configured is a trap" rule as `MOTION_AI_API_KEY`: a path that looks set kills every mp4 export at its final step, hours into someone's day, instead of at startup. The ENOENT message now names the binary it actually tried and how to fix it — the old one claimed "ffmpeg is not installed on this server", which is a guess (it may be installed and simply not on this PATH). Documented in `.env.example`.
   - **Streaming upload** — new `StorageService.uploadFile(folder, id, filePath, mime)`: Cloudinary gets `createReadStream().pipe(upload_stream)`, local copies the file. `readFileSync` held an entire mp4 (hundreds of MB) in the heap purely to hand it to a stream that chunks it anyway — two concurrent long renders were an OOM.
   - **Cancel is real** — `renderMp4` takes an `isCanceled` probe and re-checks every second WHILE ffmpeg runs, `SIGKILL`s it, and throws `RenderCanceledError`, which the service records as `canceled` (not `failed` — the user asked for it). Previously `processFrames` refused an already-canceled job and then never looked again, so cancelling a long mux flipped a database row while the encoder ran to completion and still uploaded. A cancel-check that throws is swallowed: a database blip must not kill a healthy render. **Mutation-checked** — disabling the poll makes the test fail exactly as the old cosmetic cancel behaved.
4. ~~Docs~~ ✅ `docs/SHORTCUTS.md` — full keyboard + mouse-gesture reference.

---

## Standing quick-win list (slot into any phase)
- Column headers/tooltips wherever 3+ icon buttons sit in a row.
- Replace remaining `?? default` display fallbacks that mask unset props (inspector read-gap pattern).
- Empty-state hints per panel (Components has one; Shapes/Effects don't).

## Effort ordering rationale
Phases 1–3 are UI-only (no engine risk), deliver the "pro tool" feel the user keeps asking for, and are individually shippable. Phase 4 unblocks the most-requested AE looks. Phases 5–7 deepen creation. Phase 8–9 are performance/production.
