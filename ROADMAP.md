# Roadmap

Where this project is going, and what it honestly is today. Ordered by priority,
not by date — this is a small project and dates would be fiction.

If you want to help, the **Now** section is where help changes the most.

---

## Where it stands today

Working and used daily: compositions and nesting, 2D/3D layers with cameras and
lights, keyframes and the graph editor, 183 effects, masks and mattes, shape
layers, per-glyph text animators, expressions, bone and puppet rigging,
particles, SVG and Lottie import, and export to mp4/mov/webm/GIF/PNG/Lottie
through a local ffmpeg.

Added 2026-08-17: a named ease-curve library, a disk tier under the frame cache,
onion skinning, text and colour Essential Properties, cloners with effectors and
layer-driven fields, and 2D rigid-body physics.

Added 2026-08-18: the frame cache is keyed on scene content and survives undo
and restart; output-module templates; cloner cascade, push and path modes; and
physics rotation (opt-in per body — real OBBs, contact torque, rolling).

Added 2026-08-30: a headless CLI (`premation render`) over the same
deterministic pipeline the editor exports with; data-driven batch rendering, one
file per row of a CSV; captions — `.srt`/`.vtt` in and out as ordinary text
layers, plus generation from the composition's own audio; auto-reframe to
another aspect ratio, following the subject and jumping at cuts; the pick-whip,
for parenting and for expressions; a download-on-demand installer for the Object
Matte model; and idle caching of the whole work area rather than five seconds
ahead.

Added 2026-09-02, in three passes over an audit of the editor. Most of what it
found was not missing engine work but finished engine halves with no control, so
a lot of this is *reach* rather than *build*.

The footage path became an editing loop: a **Source Monitor** (in/out in source
seconds, JKL shuttle, Insert / Overwrite / Add to end / New comp from range),
**timeline edit tools as visible modes** — Selection, Razor, Slip, Slide and Roll
on `Shift+S/C/Y/U/R`, with roll being a real two-sided trim that did not exist
before — **clip-edge snapping** and Fit Composition / Fit Work Area, **per-cut
transitions** held as records you can select, lengthen and remove, **Assemble
from Footage** and New Composition from Selected Clips, a **Scopes** panel
(waveform, parade, vectorscope, histogram), a **Transcript** panel with
text-based editing, **silence removal** and **ducking**, chapters from labelled
markers on MP4/MOV export, and a render queue that **pauses and resumes** (within
a session) with Discard as the separate destructive verb.

Motion got **one graph editor** — the Motion panel's private copy is gone, and
the survivor carries Animated / Selected modes, a frozen reference curve and a
saved-curve ease library — plus **parametric stagger** with a Re-apply that
replaces rather than layers, **modifier stacks** (ordered offset / multiply /
clamp / wiggle / smooth / spring / loop / delay / audio / oscillate rows compiled
to one expression), **audio-reactive drivers**, **bake dynamics to keyframes**,
The Smoother and The Wiggler as real dialogs, Keyframe Velocity and an
Interpolation submenu, onion-skin settings, and caret autocomplete in the
expression editor.

3D got **image skies from any image or EXR asset** and, with them,
**reflections** — a prefiltered specular atlas and split-sum IBL in both shader
dialects; the **full glTF PBR map set** (normal, metallic-roughness, occlusion,
emissive) and **external `.gltf` files with their sidecars**, behind a File ▸
Import 3D Model entry; **real curved primitives** (sphere, cylinder, cone, torus,
capsule, box) as meshes with editable segment counts; a **material editor and
persisted library**; **Composition Settings ▸ World**; light presets and a Kelvin
row; bevel styles; morph-target sliders; **3D IK** on parented layers; and the
gizmo and DOF focus plane working in every 2-up / 4-up pane.

And around the edges: a **knife tool** and pathfinder for shape paths, an
on-canvas **gradient editor**, **smart guides** with distance badges and
equal-spacing detection, **project swatches**, an interactive **onboarding
tour**, one home for the preview controls (with Cache Work Area Now, Purge RAM
and Purge Disk), and Window ▸ Workspace.

The engine is one GPU render graph (WebGPU, falling back to WebGL2) shared by the
viewport and the exporter, covered by golden-image render tests.

Pre-1.0. Expect rough edges in the UI and occasional breaking changes to the
`.motion` bundle format before 1.0.

---

## Now

### A local project browser — SHIPPED 2026-08-20

The start screen is now a real project browser: a card grid backed by the
local index (comp facts, save revision, thumbnail), joined with the MRU for
anything the index has not seen. What made it possible was less UI than
plumbing — the index had a full API, an IPC bridge and tests but ZERO
writers, so it had been empty since it shipped. Saves and opens now write it
(`indexWriter.ts`), a `LocalThumbnailWorker` captures project thumbnails to
a content-addressed cache dir (`thumb:*` IPC), and the `thumbHash` column
the SQLite schema always had finally gets values. In a browser tab it
degrades to the MRU list, as before.

### Finish verifying local-first on-device

ASSETS are done. A bundle now COLLECTS session-local footage on save — the
bytes content-addressed into `blobs/`, recorded in `assets/registry.json`, and
the document repointed at them — and RESTORES that registry on open, so a
project moved to another machine renders the footage it was authored with and
its Assets panel comes back populated.

Verified end to end by rendering a hand-built bundle whose document carried
nothing but a dead `blob:` URL and an asset id, and by the control: with the
registry removed, the export refuses with "media offline" rather than shipping
a frame with a hole in it.

The rest of the disk-backed paths have still not been exercised end-to-end on
a real device. Specifically: `better-sqlite3`
needs an `electron-rebuild` against the Electron ABI, and the binary blob IPC
needs a real save/load cycle. Concrete, verifiable, and a good way to learn the
storage layer.

---

## Next

- **A real video decoder — subsystem AND renderer swap SHIPPED 2026-08-19.**
  `src/core/video/` is the WebCodecs path: mp4box demux (pure JS, so the
  demux and the GOP/B-frame index are jest-pinned against real ffmpeg
  fixtures), a frame index answering "which samples decode frame N", and
  `ExactVideoSource` (feed key→target, flush, cache the GOP). Consumers: the
  footage preview's Frame-by-frame mode, and the RENDER PATH —
  `exactVideoFrames.ts` serves exact frames to viewport and export first,
  with the element-seek path (`videoFrameCache`) as the permanent fallback
  tier for WebM/odd containers, oversized files and WebCodecs-less runtimes.
  Export exactness rides the existing `takeMediaWaits` convergence loop.
  Real-machine visual pass: DONE the same day, in a real Chromium tab —
  frame-by-frame stepped an ffmpeg fixture with pixel readback, and the
  render path's cache reported all 24 frames decoded for the composited
  clip. The tracking column has since landed on top of it — see the next
  bullet.
- **After Effects parity.** The tracking column SHIPPED 2026-08-20, all four
  modes: Track Motion on video layers (`src/core/tracking/` — NCC matching
  with Lucas-Kanade sub-pixel refinement, anchor-template drift correction,
  occlusion coasting) runs on the exact decoder, walks any number of points
  through one decode pass, and applies as **Follow** (position keyframes on
  any layer), **Stabilize** (inverse motion on the footage), **Corner pin**
  (keyframes a Corner Pin effect on a target — screen replacement), or
  **Track mask** (every mask vertex tracked, written as mask keyframes —
  rotoscoping's first step), and **Follow + rotation & scale** (2-point
  solve: anchor drives position, the anchor→reference vector drives
  rotation and scale, angle-unwrapped past ±180°). Still open on the
  column: a roto brush / edge-aware masks — though the ROTO BRUSH's neural
  half is now reachable, because the piece that was missing was never code.
  The segmenter, the ONNX wrapper and the runtime have all been in the tree;
  what nobody had was a way to GET a model, since a build-time environment
  variable is not something a person does. Settings ▸ Object Matte downloads
  one on an explicit press and caches it for every later launch. The PICK-WHIP
  shipped too, for parenting and for expressions — the most-felt gesture gap.
  Beyond tracking: more of the effect set, richer expression bindings. Open an
  issue for the specific gap you hit — that is far more useful than a general
  "more parity" wish.
- ~~**A video editing loop.**~~ **SHIPPED 2026-09-02** — source monitor, edit-tool
  modes (razor / slip / slide / roll), clip-edge snapping, per-cut transitions,
  Assemble from Footage, scopes, transcript-based editing, silence removal and
  ducking, and render-queue pause/resume. See "Where it stands today".
- **Timeline and graph-editor polish.** The two graph editors became one on
  2026-09-02, with Animated / Selected visibility modes, a frozen reference
  curve and an ease library — which was most of what "not yet pleasant for dense
  compositions" meant. What is still open is *density* rather than capability:
  the panel is not yet fast or legible with hundreds of tracks on screen.
- **Performance on large projects.** The engine handles high layer counts, but
  the UI has hot spots under heavy scenes. Profile before optimising, and bring
  the profile to the PR.
- **Broader render-test coverage.** Subsystems with only unit tests can regress
  visually without anything going red. The harness is in
  `packages/render-tests/`.
- **Colour management.** Linear working-space and linear RT storage shipped;
  display-referred upload tagging (`displayReferred`, `rgba8unorm-srgb` backend
  support, `HARDWARE_SRGB_UPLOADS` kill switch default off) shipped;
  project working-space UI (Composition Settings → Color), ACES display ODT, and
  32-bpc intermediate depth shipped (2026-08-14). HDR output still open.

## Later

- **Audio.** Waveform display, audio layers, offline mixdown, dB automation,
  per-clip effects and the `audio` expression all exist (`src/core/audio/`).
  What does not: a mixing console — buses, sends, and live metering.
- **Plugin ecosystem.** The sandbox, permission model and signing all ship. What
  is missing is discovery outside the hosted registry, and more host API surface
  for plugin authors.
- **Collaboration.** Real-time multiplayer would need a substantial
  re-architecture. Not planned, not refused.
- **Advanced 3D.** Almost all of what this entry listed as open closed on
  2026-09-02. Imported glTF/GLB models (embedded **and** external-file, with
  sidecars), CPU skinning, morph targets, baked animation clips, 3D IK, an
  SH-probe Environment Light fed by **any image or EXR asset**, **split-sum
  reflections** off that same sky, the **full glTF PBR map set**, and **real
  curved primitives** all ship — see
  [`docs/3d-layer-model.md`](docs/3d-layer-model.md) for how they map onto
  ordinary layers. **Shadow maps shipped too** — opt-in per light, PCF-filtered,
  byte-identical when off (`packages/renderer/src/rendergraph/passes/shadowMap.ts`);
  one mapped light per run, point lights along their aim. What remains is
  **SSAO** (blocked: every 3D run draws into a multisampled target, so neither
  backend can sample its depth — it needs a linear-depth prepass bound before
  the run draws) and **height displacement** (not started). The target remains
  AE's *Classic* 3D, plus extrusion/bevels and this imported-model foothold —
  full parametric Advanced 3D is not planned.
- **Local AI conversation persistence.** The assistant ships in the local
  edition (BYOK via OS keystore + `aiProxy`, including `ai:image`). Thread
  history still only persists when a backend is present; in-session history
  works. Wiring `aiBundleIO` into the chat UI would close the gap.

---

## Not planned

- **A web version.** The app depends on the filesystem, native menus and a local
  ffmpeg. The renderer runs in a browser tab for development, but that is a
  development convenience, not a product.
- **Re-implementing the hosted backend in this repo.** Accounts, billing and the
  encrypted sync vault are a separate closed service. The local edition is
  designed to need none of them for editing — BYOK AI talks to the user's
  provider directly from the desktop shell.

---

## How this list changes

Roadmaps drift. If something here contradicts the code, the code wins and a PR
fixing this file is welcome. Priorities move based on what people actually
contribute — an area with a motivated contributor beats an area with a plan.
