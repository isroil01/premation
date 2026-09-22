# Premation — rules for anyone (human or agent) changing this repo

The architecture and its migration order live in `docs/NATIVE_CORE_PLAN.md`.
Read §0 (decisions) before proposing structural change; those decisions are
settled and are not re-opened in a code change.

## Layering (lint-enforced, see eslint.config.js)

```
Electron (electron/)  →  Editor (src/layout, src/components, src/stores, src/hooks)
                      →  Engine (src/core, packages/*)  →  GPU (packages/renderer)
```

- `src/core/**` and `packages/**` never import `react`, `react-dom`, `zustand`,
  `@/layout/*`, `@/components/*`. Hooks go in `src/hooks`, Zustand stores in
  `src/stores`, components in `src/components` or the layout that owns them.
- `packages/**` never import from `src/**`.
- `packages/renderer` never touches the DOM outside its canvas-binding files.
- Editor state (selection, zoom, panel layout, scroll) never enters the project
  document. If it needs to persist, it goes in `sceneViewStore`/prefs, not the
  scene.
- New engine features are decided by ownership first: Motion engine / Render
  engine / Media / Render infrastructure / Plugins / Electron / Editor UI. An
  effect is a registry entry + shader/kernel + metadata; never a React
  component with special rendering.

## Performance discipline

- No React render per played frame. Playback and scrubbing update through
  store subscriptions and refs (see `src/core/perf/framePump.ts`,
  `KeyframeLane`'s subscription pattern).
- Every performance change quotes before/after numbers from `npm run bench`
  or the viewport HUD. `npm run bench:check` must stay green.
- No per-frame allocations in `framePerf`, the texture feed, or the render
  loop hot paths without a comment explaining why.

## Reliability discipline

- A single bad layer, effect, plugin, asset or decode never blanks a frame or
  crashes the editor: isolate, record on `snapshot.layerErrors`, continue.
- Project saves are temp-file + rename. Never write over the user's file.
- Rendering is deterministic: no wall-clock, no unseeded RNG, no DOM layout
  inputs.

## Native code (`native/`, C++20) — applies once N0 lands

- Clang on every platform (clang-cl on Windows). CMake presets + vcpkg
  manifest. Both WASM (Emscripten) and N-API builds must pass; one is not done.
- ASan/UBSan/TSan suites and `clang-tidy` (cppcoreguidelines, bugprone,
  performance, modernize) are blocking. `-Wall -Wextra -Wpedantic -Werror
  -Wshadow -Wconversion`.
- No raw `new`/`delete`. RAII everywhere. `unique_ptr` by default;
  `shared_ptr` needs a justifying comment. `std::span`/`string_view`/plain
  structs at boundaries.
- No exceptions cross the C ABI in `include/motion/`. Exported functions
  return an error code + message buffer.
- FFI to ffmpeg/Skia/OS lives only in `*_ffi.cpp` files.
- The N-API module is never loaded into the editor's renderer process. It
  runs in the export process and the worker-engine host only.
- Every native replacement ships behind a flag with the TypeScript fallback
  intact, and flips default only when bit-identical on the golden gate.

## Repo traps

- Files are CRLF. `sed -i` strips CR — use the Edit tool or PowerShell.
- The Vite dev server hot-reloads a running app on every edit; agents must not
  start it, and heredoc edits during HMR can wedge it.
- `npm run lint` has a warning budget (`--max-warnings`); a change may add
  zero new errors and should not add warnings.
- Golden render tests (`packages/render-tests`) are the parity gate; any
  change to snapshot, shaders or passes runs them before merge.
