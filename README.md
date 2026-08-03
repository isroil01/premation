<img width="2555" height="1389" alt="Screenshot 2026-07-30 010317" src="https://github.com/user-attachments/assets/e6922bfd-423b-46f7-8b67-a15babe7322e" />



# Premation

An open-source motion editor for the desktop. Compositions, layers, keyframes, a
graph editor, 3D space with cameras and lights, effects, masks and mattes,
per-glyph text animators, mesh rigging, particles, and a deterministic export
pipeline — built on a GPU render engine that runs on WebGPU or WebGL2.

It is modelled on After Effects' Classic 3D workflow: if you know AE, the tools,
the panel layout and most of the keyboard shortcuts are already where you expect
them.

Electron + React + TypeScript. Everything renders through one engine, the same
engine that exports, so what you see in the viewport is what lands in the file.

**License:** [GNU AGPL v3.0](LICENSE) · **Status:** pre-1.0, in active development

We're live on Product Hunt — an upvote helps more people find the project:

<a href="https://www.producthunt.com/products/premation?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-premation" target="_blank" rel="noopener noreferrer"><img alt="Premation - An open-source AI alternative to After Effects | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1210281&theme=dark&t=1785426501859"></a>

---

## Contents

- [Two editions](#two-editions)
- [Quick start](#quick-start)
- [Requirements](#requirements)
- [What's in the box](#whats-in-the-box)
- [Export](#export)
- [Projects on disk](#projects-on-disk)
- [The AI assistant](#the-ai-assistant)
- [Repository layout](#repository-layout)
- [Plugins](#plugins)
- [Testing](#testing)
- [Packaging a release](#packaging-a-release)
- [Contributing](#contributing)
- [Documentation](#documentation)
- [License](#license)

---

## Two editions

The same source tree builds two editions, chosen at build time with
`VITE_EDITION`. This exists because the editor is open source while the hosted
backend service is not.

| | **local** (`VITE_EDITION=local`) | **server** (default) |
|---|---|---|
| Accounts / sign-in | none — opens straight into the editor | required |
| Projects | on disk, `.motion` bundle | cloud, with autosave |
| Assets | on disk, content-addressed | cloud library |
| Export | local ffmpeg | local ffmpeg |
| AI assistant | not included | via the hosted gateway |
| Billing / sync / plugin registry | absent | available |

**The local edition is the one to build from this repository.** It makes no
network requests at all: the API layer refuses to send, so an offline build
cannot quietly phone home. The `server` edition targets a backend service that
is not part of this repository, so its cloud features will not work without one.

Read the edition as a *capability*, never as a flag — see
[`src/core/config/edition.ts`](src/core/config/edition.ts).

## Quick start

```bash
git clone https://github.com/isroil01/motion-editor.git
```

```bash
cd motion-editor && npm install
```

Run the desktop app:

```bash
npm run electron:dev:local
```

That compiles the Electron main process, starts Vite, and opens the app. Edits to
renderer code hot-reload.

To run just the renderer in a browser tab (faster, but no filesystem, native
menus or ffmpeg export):

```bash
npm run dev:local
```

Both `:local` scripts set `VITE_EDITION=local`. Dropping the suffix
(`npm run electron:dev`) builds the `server` edition, which will sit on a sign-in
screen unless you point it at a backend.

## Requirements

- **Node.js 20 or newer** and npm.
- **A GPU that supports WebGPU or WebGL2.** The engine picks WebGPU when
  available and falls back to WebGL2; there is no software rasteriser.
- **ffmpeg**, for `.mp4` / `.mov` export only. Everything else — including the
  editor itself and webm/GIF/PNG/Lottie export — works without it. The app looks
  for ffmpeg in this order:
  1. `$FFMPEG_PATH`
  2. a binary bundled next to the packaged app
  3. `ffmpeg` on your `PATH`

  If it finds none, mp4 export fails with a message saying exactly that, and
  nothing else is affected.

Linux, macOS and Windows are all supported by the toolchain. CI currently
exercises the render tests only.

## What's in the box

Counts below were taken from the source, not from memory — if you change a
registry, this section is expected to drift, so re-check before quoting it.

**Compositing and layout**
- Nested compositions and comp instances, with collapse-transformation
- 2D and 3D layers in one space, with cameras and lights (parenting included)
- Masks, track mattes, blend modes, layer styles
- Shape layers, paths, trim paths, repeaters, path operations
- **57 effects** ([`src/core/effects/effects.ts`](src/core/effects/effects.ts))

**Animation**
- Keyframes with full easing control and a graph editor
- **39 presets** — 15 animation, 18 text, 6 behaviour
- Per-glyph text animators with a real selector stack
- Expressions
- Bone and puppet mesh rigging (FK, linear-blend skinning, FABRIK IK, ARAP)
- Particles, motion blur, motion paths

**Import**
- Video, audio and images
- SVG — static files import as one intact layer; animated SVG (CSS or SMIL)
  converts to keyframes
- Lottie / Bodymovin

**Engine**
- One GPU render graph, WebGPU or WebGL2, used by the viewport *and* the exporter
- 3D transforms, extrusion, bevels, per-fragment shading
- Golden-image render tests to keep output stable across refactors

## Export

mp4, mov, webm, GIF, PNG/JPG sequences, and Lottie/JSON.

Frames are rasterised by the same engine that draws the viewport, streamed to
disk one at a time (so peak memory is one frame, not the whole render), and muxed
by a local ffmpeg process. A long export leaves the app usable.

## Projects on disk

A project is a **`.motion` directory bundle**, not a single opaque file:

```
MyProject.motion/
├── manifest.json          written last, so a crash can't corrupt the bundle
├── scene.json             ├─ separate chunks, content-hashed, so a save
├── animation.json         │  writes only what actually changed
├── timeline.json          │
├── meta.json              ┘
├── assets/                imported media, addressed by SHA-256
└── versions/              local version history, structurally shared
```

Saving is incremental and version history is local — snapshots share unchanged
objects rather than storing full copies, so an animation-only change costs one
new object.

## The AI assistant

The editor contains a complete AI layer: **62 tools** it can call, an agent loop,
a deterministic "caster" pipeline that assembles motion from a hand-authored
technique library, and a self-critique pass.

**The local edition does not include it.** Not "disabled pending work" — the
surface is absent: no panel in the sidebar, no commands, no settings tab, and no
AI IPC registered in the desktop shell at all.

That is a distribution decision, not a technical limit, and the previous wording
here implied the opposite — so it is worth being exact. The bring-your-own-key
path exists and works: the shell holds provider keys in the OS keystore and makes
the model call from the main process, which is how a desktop build reaches a
provider without the key ever entering renderer scope. None of that code was
removed. `aiEnabled()` in `src/core/config/edition.ts` is the entire gate.

What it means for a build from this repository: **it makes no network requests at
all.** The API layer refuses to send, and the one piece of code here that
contacts a third-party host — the provider proxy — is never registered. That
guarantee now holds in the main process rather than resting on the UI declining
to offer a button.

Everything else in the editor works fully offline.

## Repository layout

```
src/
├── core/          document model, engine glue, commands, export, AI, plugins
│   └── config/    edition + feature flags
├── layout/        panels — timeline, inspector, workspace, effects
├── components/    reusable UI primitives
├── stores/        Zustand state
└── routes/        app shell and routing
packages/
├── scene/         scene graph, transforms, hit-testing
├── animation/     keyframes, easing, evaluation
├── timeline/      timeline model
├── renderer/      GPU render graph (WebGPU + WebGL2)
├── audio/         audio graph
├── workspace/     viewport interaction, gizmos
├── ai-tools/      the tool registry the assistant calls
├── caster/        deterministic generative pipeline
├── technique-library/ hand-authored motion techniques
├── design-system/ look packs and design tokens
├── product-motion/ UI-motion technique packs
└── render-tests/  golden-image harness
electron/          main process, IPC, native integration
```

## Plugins

Plugins are packages — a `plugin.json` manifest plus an ES module — that run in a
dedicated Worker sandbox. Permissions are shown and accepted *before any plugin
code is loaded anywhere*, and packages are signed.

See [`docs/PLUGINS.md`](docs/PLUGINS.md) for the architecture and the authoring
guide. Installing from a local file works in every edition; the hosted registry
does not exist in the local edition.

## Testing

```bash
npm test
```

Roughly 440 suites and 4,800 tests, and they are fast (under a minute). Also:

```bash
npm run typecheck
```

```bash
npm run lint
```

Golden-image render tests compare real GPU output against committed reference
frames:

```bash
npm run render-tests
```

```bash
npm run render-tests:update
```

Only update goldens when you have looked at the diff and can say why the new
pixels are correct.

## Packaging a release

```bash
npm run dist:local
```

Produces an installer in `release/` via electron-builder. `npm run pack:local`
builds an unpacked directory instead, which is much faster for testing.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for how to set
up, what the review bar is, and which areas need help. By participating you agree
to the [Code of Conduct](CODE_OF_CONDUCT.md).

Security issues should **not** be filed as public issues — see
[SECURITY.md](SECURITY.md).

## Documentation

Deep dives on individual subsystems:

- [`docs/3d-layer-model.md`](docs/3d-layer-model.md) — the 3D model, and where it
  departs from After Effects
- [`docs/BONE_AND_PUPPET_RIGGING.md`](docs/BONE_AND_PUPPET_RIGGING.md) — mesh
  deformation, the math and the current gaps
- [`docs/ANIMATED_SVG_PIPELINE.md`](docs/ANIMATED_SVG_PIPELINE.md) — SVG import,
  end to end
- [`docs/PLUGINS.md`](docs/PLUGINS.md) — plugin architecture and authoring

Prose drifts faster than code. Where a document and the source disagree, the
source is right — and a PR fixing the document is very welcome.

## License

Copyright © Premation contributors.

Licensed under the **GNU Affero General Public License v3.0 only**. The full text
is in [LICENSE](LICENSE).

In short: you may use, study, modify and redistribute this software, but derived
works must also be licensed under the AGPL and must carry the same source-code
offer. Section 13 matters in particular — **if you run a modified version as a
network service, you must offer its users the corresponding source.**

The AGPL covers this repository. It does not cover the separate hosted backend
service, which is not distributed here.
