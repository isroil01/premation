# Roadmap

Where this project is going, and what it honestly is today. Ordered by priority,
not by date — this is a small project and dates would be fiction.

If you want to help, the **Now** section is where help changes the most.

---

## Where it stands today

Working and used daily: compositions and nesting, 2D/3D layers with cameras and
lights, keyframes and the graph editor, 57 effects, masks and mattes, shape
layers, per-glyph text animators, expressions, bone and puppet rigging,
particles, SVG and Lottie import, and export to mp4/mov/webm/GIF/PNG/Lottie
through a local ffmpeg.

The engine is one GPU render graph (WebGPU, falling back to WebGL2) shared by the
viewport and the exporter, covered by golden-image render tests.

Pre-1.0. Expect rough edges in the UI and occasional breaking changes to the
`.motion` bundle format before 1.0.

---

## Now

### A local project browser

The local edition opens straight into the editor because the existing dashboard
is cloud-backed. Recent files work, but there is no home surface for browsing
local projects, thumbnails or version history. The local index (SQLite) and
version store already exist and are tested; they need a UI.

### Finish verifying local-first on-device

The `.motion` bundle, content-addressed asset store, local version history and
their Electron IPC are written and unit-tested, but the disk-backed paths have
not been exercised end-to-end on a real device. Specifically: `better-sqlite3`
needs an `electron-rebuild` against the Electron ABI, and the binary blob IPC
needs a real save/load cycle. Concrete, verifiable, and a good way to learn the
storage layer.

---

## Next

- **After Effects parity.** Rotoscoping, more of the effect set, richer
  expression bindings. Open an issue for the specific gap you hit — that is far
  more useful than a general "more parity" wish.
- **Timeline and graph-editor polish.** The graph editor is capable but not yet
  pleasant for dense compositions.
- **Performance on large projects.** The engine handles high layer counts, but
  the UI has hot spots under heavy scenes. Profile before optimising, and bring
  the profile to the PR.
- **Broader render-test coverage.** Subsystems with only unit tests can regress
  visually without anything going red. The harness is in
  `packages/render-tests/`.
- **Colour management.** Currently sRGB throughout; no working-space or LUT
  support.

## Later

- **Audio.** Waveform display and basic audio layers exist; real mixing does not.
- **Plugin ecosystem.** The sandbox, permission model and signing all ship. What
  is missing is discovery outside the hosted registry, and more host API surface
  for plugin authors.
- **Collaboration.** Real-time multiplayer would need a substantial
  re-architecture. Not planned, not refused.
- **Advanced 3D.** Imported 3D models, PBR materials and HDRI environments are
  explicitly out of scope — see
  [`docs/3d-layer-model.md`](docs/3d-layer-model.md). The target is AE's
  *Classic* 3D, plus extrusion and bevels.

---

## Not planned

- **A web version.** The app depends on the filesystem, native menus and a local
  ffmpeg. The renderer runs in a browser tab for development, but that is a
  development convenience, not a product.
- **Re-implementing the hosted backend in this repo.** Accounts, billing, the
  metered AI service and the encrypted sync vault are a separate closed service.
  The local edition is designed to need none of them, and that is the intended
  shape — not a temporary state.
- **Shipping the AI assistant in the local edition.** This section used to open
  with "Bring-your-own-key AI — the biggest gap, and the best contribution
  available", followed by a four-step plan. All four steps were completed: the
  transport in `streamTurn` is injectable, the provider call happens in the
  Electron main process, keys are stored with `safeStorage` in the OS keystore,
  and `aiEnabled()` was flipped.

  It has since been flipped back, deliberately. The local edition does not ship
  the assistant — no panel, no commands, no settings tab, and no AI IPC
  registered in the shell. The machinery all still exists and is unchanged; what
  changed is the decision about what the open-source build includes. Worth
  stating plainly so nobody rebuilds it: the work is done, the gate is one line
  in `src/core/config/edition.ts`, and the local build's no-network guarantee is
  now enforced in the main process rather than by the UI declining to offer a
  button.

---

## How this list changes

Roadmaps drift. If something here contradicts the code, the code wins and a PR
fixing this file is welcome. Priorities move based on what people actually
contribute — an area with a motivated contributor beats an area with a plan.
