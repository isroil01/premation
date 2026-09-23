# Premation native core (`native/`)

C++20 libraries under the existing editor, per `docs/NATIVE_CORE_PLAN.md`
(§2 ground rules, §3 layout). The evaluation half of phase D1 lives here, each
library ported from the TypeScript and gated against it by golden tables that
the TypeScript itself generates:

| Library | Ports | Golden gate |
|---|---|---|
| **`motion_eval`** | keyframe sampling — `packages/animation/src/interpolate.ts` | `golden_bezier.inc` |
| **`motion_jsmath`** | V8's `Math` (its fdlibm port) and ECMAScript Number ⇄ String | `golden_jsmath.inc`, `golden_numconv.inc` |
| **`motion_expr`** | the expression language — `exprLang.ts`, `expressions.ts`, `sourceText.ts` | `golden_expr.inc`, `golden_expr_engine.inc` |
| **`motion_transform`** | layer transforms, parent chains, 3D compose, the camera — `packages/scene/src/utils/{matrix,matrix4,project3d}.ts`, `src/core/scene/{worldTransform,nodeMatrix,camera3d,layerSpace}.ts`, `buildSnapshot.ts` `affineAt` | `golden_transform.inc` |

```text
native/
  CMakeLists.txt, CMakePresets.json, vcpkg.json     workspace + presets
  cmake/warnings.cmake, cmake/sanitizers.cmake       motion::options
  include/motion/                                    the ONE public C ABI: motion_abi.h, motion_eval.h,
                                                     motion_expr.h, motion_transform.h
  libs/motion_eval/                                  eval.hpp/.cpp (internal), motion_eval.cpp (C wrappers);
                                                     its CMakeLists also adds the libraries below
  libs/motion_jsmath/                                fdlibm.cpp (V8 Math), numconv.cpp (Number ⇄ String)
  libs/motion_expr/                                  expr.hpp (C++ API), parser/interp/stdlib/sourcetext, motion_expr.cpp (C ABI)
  libs/motion_transform/                             transform.hpp/.cpp, motion_transform.cpp (C ABI)
  tests/                                             Catch2 + the gen_golden*.ts generators and their .inc tables
  bench/                                             Google Benchmark (bench_eval, bench_expr); tests/bench_ts.ts is the TS twin
  bindings/wasm/, bindings/napi/                     Emscripten glue, node-addon-api addon
```

The TypeScript side of the boundary is `packages/native-bridge` (the only
place that may import a WASM or N-API build; falls back to `@motion/animation`).

## Rules that CI enforces (from `CLAUDE.md`)

- Clang on every platform (`clang-cl` on Windows); Ninja; CMake ≥ 3.25 presets;
  vcpkg manifest mode with a committed baseline.
- `-Wall -Wextra -Wpedantic -Werror -Wshadow -Wconversion` (`/W4 /WX` + the same
  `-W` flags under clang-cl), `-ffp-contract=off` for bit-determinism.
- ASan+UBSan and TSan suites, and `clang-tidy`
  (`cppcoreguidelines-*, bugprone-*, performance-*, modernize-*`, warnings as
  errors) are blocking. `.clang-tidy` lists the disabled checks with reasons.
- No raw `new`/`delete`; no exceptions across the C ABI (every exported function
  returns `motion_status` + writes `motion_error`); no wall clock, no RNG.
- Both WASM and N-API builds must pass; one is not done.

## Installing the toolchain

Nothing in the repo downloads a compiler. Install once per machine.

### Windows

```powershell
winget install --id LLVM.LLVM                 # clang-cl, clang-tidy, clang-format, llvm-lib
winget install --id Kitware.CMake
winget install --id Ninja-build.Ninja
# The Windows SDK + MSVC CRT that clang-cl compiles against (C++ workload):
winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive"

# vcpkg (manifest mode reads native/vcpkg.json; VCPKG_ROOT must point here)
git clone https://github.com/microsoft/vcpkg C:\dev\vcpkg
C:\dev\vcpkg\bootstrap-vcpkg.bat
setx VCPKG_ROOT C:\dev\vcpkg

# Emscripten, only for the wasm preset (EMSDK must point here)
git clone https://github.com/emscripten-core/emsdk C:\dev\emsdk
C:\dev\emsdk\emsdk install latest
C:\dev\emsdk\emsdk activate latest --permanent      # sets EMSDK and PATH
```

Open a **"x64 Native Tools Command Prompt for VS 2022"** (or run
`vcvars64.bat`) before configuring: clang-cl finds the SDK and CRT through the
`INCLUDE`/`LIB` variables that shell sets, and the N-API addon's `.def → .lib`
step needs `lib.exe` on `PATH`.

### macOS

```sh
xcode-select --install          # Apple clang (fine for N0/N1)
brew install cmake ninja llvm   # llvm for clang-tidy / clang-format
git clone https://github.com/microsoft/vcpkg ~/dev/vcpkg && ~/dev/vcpkg/bootstrap-vcpkg.sh
export VCPKG_ROOT=~/dev/vcpkg
git clone https://github.com/emscripten-core/emsdk ~/dev/emsdk && ~/dev/emsdk/emsdk install latest && ~/dev/emsdk/emsdk activate latest
source ~/dev/emsdk/emsdk_env.sh   # sets EMSDK
```

### Linux (Debian/Ubuntu)

```sh
sudo apt-get install -y clang clang-tidy clang-format ninja-build cmake git curl zip unzip tar pkg-config
git clone https://github.com/microsoft/vcpkg ~/dev/vcpkg && ~/dev/vcpkg/bootstrap-vcpkg.sh
export VCPKG_ROOT=~/dev/vcpkg
git clone https://github.com/emscripten-core/emsdk ~/dev/emsdk && ~/dev/emsdk/emsdk install latest && ~/dev/emsdk/emsdk activate latest
source ~/dev/emsdk/emsdk_env.sh
```

## Configure / build / test

From the repo root (`scripts/native.mjs` picks the preset for this OS —
`windows-clang-cl`, `macos-clang`, `linux-clang` — and accepts `--asan`,
`--tsan` or `--preset NAME`):

```sh
npm run native:configure          # cmake --preset <os>
npm run native:build              # cmake --build --preset <os>
npm run native:test               # ctest --preset <os>
npm run native:bench              # build/<preset>/bench/motion_bench
npm run native:tidy               # run-clang-tidy over native/libs
npm run native:wasm               # configure + build the wasm preset + Node smoke test
npm run native:napi               # npm install + cmake-js compile in bindings/napi + smoke test
npm run native:golden             # regenerate tests/golden_bezier.inc from the TypeScript
```

Or the presets directly, from `native/`:

```sh
cmake --preset linux-clang            # macos-clang | windows-clang-cl | wasm
cmake --build --preset linux-clang    #   plus linux-clang-asan, linux-clang-tsan,
ctest --preset linux-clang            #   macos-clang-asan, macos-clang-tsan, windows-clang-cl-asan
```

Build trees go to `native/build/<preset>/` (git-ignored). The wasm preset
turns tests and bench off (no vcpkg) and writes
`build/wasm/bindings/wasm/motion_wasm.{mjs,wasm}`.

### N-API addon

```sh
cd native/bindings/napi
npm install
npx cmake-js compile                      # Linux/macOS: CC=clang CXX=clang++ npx cmake-js compile
npx cmake-js compile -G Ninja --CDCMAKE_C_COMPILER=clang-cl --CDCMAKE_CXX_COMPILER=clang-cl   # Windows
node smoke.cjs
```

For Electron's ABI: `npx cmake-js compile --runtime electron --runtime-version <electron version>`.

## The golden contract

`tests/gen_golden.ts` RUNS the TypeScript `sampleTrack` over a 3-keyframe
bezier track and writes `tests/golden_bezier.inc` (X-macros). The Catch2 suite
checks the C++ against it twice: `[golden]` within 1e-9 relative, and
`[golden][bits]` with exact `==`. Both N-API and WASM smoke tests run the same
table through their packed `Float64Array` protocol with exact equality, and
`packages/native-bridge`'s jest test checks its fallback against the same file.
Change the sampler on either side → regenerate → all four gates move together.

Why exact equality is achievable: the port keeps the TypeScript's operation
order, uses only `+ - * /`, `fabs` and `floor` (all correctly rounded IEEE
operations), and is compiled with `-ffp-contract=off` so no platform fuses a
multiply-add. If `[bits]` fails while `[golden]` passes, a platform is fusing
or reordering — find the flag, do not loosen the test.

### The D1 tables (expressions, transforms, JS math)

Regenerate from the repo root (Node ≥ 22.6; the transform and bench scripts
bundle the app modules with the repo's esbuild because they use tsconfig path
aliases):

```sh
node native/tests/gen_golden_jsmath.ts      # golden_jsmath.inc (8 400 rows), golden_numconv.inc (5 245 rows)
node native/tests/gen_golden_expr.ts        # golden_expr.inc (7 840 samples, 1 779 expressions), golden_expr_engine.inc (220)
node native/tests/gen_golden_transform.ts   # golden_transform.inc (3 364 rows)
node native/tests/bench_ts.ts               # TypeScript timings for the bench_expr.cpp cases (not a golden)
```

Every row is checked by BITS (`-0 ≠ +0`, NaN matches NaN) plus a secondary
"within 1e-12 relative" count; error messages and Source Text results are
compared as exact strings. The one tolerance anywhere is `Math.pow` (below).

**Why a JS math library.** V8 does not use the platform libm for `Math.sin`
& co.: it carries fdlibm. fdlibm is not correctly rounded, so any other libm
differs in the last bit for a few percent of inputs, and the expression noise
(`hash01 = frac(sin(n·127.1)·43758.5453)`, behind `wiggle`/`random`/`noise`)
amplifies one ulp into a different wiggle. `motion_jsmath` is fdlibm as V8 has
it (plus V8's `hypot`, `round`, `sinh`/`cosh`), soaked at 40 000 inputs per
function with zero differences. **`Math.pow` is the exception:** V8 hands the
general case to the platform `std::pow` (measured: an fdlibm `e_pow` port
differed on 4.6 % of inputs; `std::pow` matched), so the TypeScript's own
`Math.pow` differs between Windows, Linux and macOS — and between the static and
DLL MSVC runtimes (1 row in 8 400 is one ulp off here). The pow rows are
therefore checked to ≤ 1 ulp and counted; nothing else is.

**What `motion_expr` covers.** The whole language (lexer, Pratt parser with the
shared 2 000-level parse limit, error text, the shared 200 000-step / depth-512
evaluation budget across cross-layer re-entry)
and the whole `expressions.ts` scope: `time value audio ctrl wiggle clamp linear
ease easeIn easeOut timeToFrames framesToTime random seedRandom gaussRandom
noise Math valueAtTime velocity speed velocityAtTime layer layerAt loopOut
loopIn (cycle/pingpong/offset/continue) thisComp thisLayer thisProperty
sourceRectAtTime toComp toWorld fromComp fromWorld numKeys key nearestKey
marker (+ thisComp.marker, key(n|name), nearestKey) posterizeTime add sub mul
div dot cross length normalize text plugin` — with JavaScript semantics for
every operator and coercion (`+` concatenation, `==`, relational string
compare, ToNumber/ToString/ToPrimitive), all of `Math`, the Number /
String / Array / Function / Object prototype methods people use in AE text
expressions (`toFixed`, `split`, `padStart`, `join`, `map(Math.sqrt)`, …) and
`sourceText.ts` (the String object, all 24 style getters, all 25 setters,
per-character ranges, `coerceSourceTextResult`). Cross-layer reads, spaces,
markers and text go through `motion::expr::Host`; `test_expr.cpp` includes a
Host that mirrors `AnimationEngine.sampleInternal` (visited-set cycles,
depth > 16, vector component pick, `stringSeed` prop seeds) and matches
`AnimationEngine.sample` on 195 samples.

**Not ported (reads `undefined`, so calling it is "not a function"):**
regex-backed string methods (`match`, `matchAll`, `search`, RegExp arguments
to `split`/`replace`), locale methods (`localeCompare`, `toLocaleString`),
`normalize`, the Annex B `trimLeft`/`trimRight` aliases report the wrong
`.name`, generic array methods called on non-arrays, and
`Function.prototype.bind`.
Case mapping covers ASCII, Latin-1, Latin Extended-A, Greek and Cyrillic (V8
uses full ICU). Grapheme counting (for style ranges) is a UAX #29 subset
(CR LF, combining marks, ZWJ, emoji modifiers, flags, Hangul), where the TS
uses `Intl.Segmenter`. A function's `toString` is a fixed text (V8 prints the
transpiled source). The C ABI does not carry Source Text yet (C++ API only).

**Behaviours fixed on BOTH sides together** (D1 found them by porting; each
was changed in the TypeScript and the C++ in one step and is pinned by the
goldens, so the engines stay bit-identical):
- `random()` / `gaussRandom()` vary with time as in AE: the stream is
  `hash01(seed·1013.7 + call·71.3 + frame·7.919)` with
  `frame = round(time · fps)` (comp fps; non-finite → 0), and
  `seedRandom(s, true)` (timeless) drops the frame term. Rounding to the frame
  keeps every motion-blur sub-frame sample of a frame on that frame's values.
  Before, the frame was never mixed in and `timeless` was ignored, so every
  `random()` was constant per property — **old projects' `random()` now
  changes every frame, as it does in After Effects**; `seedRandom(s, true)`
  keeps the old constant values exactly.
- `Math.random()` in an expression draws from that same sequence
  (`propSeed`, `seedRandom`, the frame unless timeless, one call counter
  shared with `random()`/`gaussRandom()`, reset per evaluation) instead of
  V8's unseeded RNG. It still jitters per frame, but reproducibly: the same
  frame gives the same values on every draw, scrub and export, in both engines.
- Parse depth: both parsers stop at 2 000 levels (the expression, each
  bracketed sub-expression, binary right operand and prefix operator) with
  "Syntax error: This expression is nested too deeply to read (more than 2000
  levels)." The TS parser now spends one JS frame per level, as the C++ does,
  so V8's stack is never the limit. Goldens at 1 999 / 2 000 / 2 001 levels.
- `valueAtTime()` / `velocityAtTime()` with a missing or non-numeric time is
  the stated error "valueAtTime() needs a time in seconds, e.g.
  valueAtTime(time - 0.5)." (was a TypeError inside `sampleTrack` on a
  one-key track, NaN arithmetic otherwise).
- Parent cycles: every node ON a cycle is a root (world = local) and is
  reported (`worldMatrixOf`'s `onCycle`, `world_matrices_2d`'s `on_cycle`
  flags); nodes parented into the cycle compose onto it. Independent of
  resolution order. Was a stack overflow in the TS and a whole-batch failure
  in the C++.
- `key(n)` and `marker.key(n)` share one index rule: rounded, clamped to
  1..count, NaN → 1 (was `{index: NaN}` vs `undefined`).
- "Syntax error: …" labels exactly the parse failures (all of them), never a
  runtime message that happens to contain "Unexpected"/"missing".
- Markers sort ascending, stable, NaN times last (a total order, so V8's
  TimSort and `std::stable_sort` agree).

`Math.pow` stays platform-dependent in the TS engine (above).

**Transforms.** All scene-side TS math is float64 (Float32 appears only in
`packages/renderer`'s Mat3/Mat4 — the GPU side, D2), so the port is exact
double arithmetic in the TypeScript's operation order with V8's sin/cos/tan/
atan/atan2/hypot. Two compositions (`layerSpaceAt`'s 3D branch and
`buildSnapshot`'s `affineAt`) live inside scene-graph-bound functions; the
generator composes the same exported primitives in the same order, quoted in
`gen_golden_transform.ts`.

**Sanitizers on Windows.** `node scripts/native.mjs configure|build|test
--asan` (the `windows-clang-cl-asan` preset) builds and runs every suite under
AddressSanitizer (clang-cl has no UBSan runtime for the MSVC target here; the
Linux/macOS presets run ASan + UBSan). `cmake/sanitizers.cmake` explains the
three Windows specifics: CMake links with lld-link, so the ASan runtime
libraries are named explicitly (the clang-cl driver's own link line); the
vcpkg Catch2 is not ASan-built, so the MSVC STL container annotations are
switched off everywhere (`_DISABLE_STRING_ANNOTATION` /
`_DISABLE_VECTOR_ANNOTATION`, which only costs the container-overflow check);
and the runtime DLL is copied next to `motion_tests.exe`. Sanitizer frames are
large, so `motion_tests` links with a 16 MB stack.

**Speed** (this machine, Release-ish `RelWithDebInfo`, clang-cl; Node 24 for TS):

| Case | C++ | TypeScript |
|---|---|---|
| `value + Math.sin(time * 2) * 40` | 0.56 µs | 6.5 µs |
| `wiggle(3, 40)` | 0.56 µs | 8.9 µs |
| `loopOut('pingpong')` | 0.38 µs | 9.2 µs |
| `linear(…) + clamp(…)` | 0.62 µs | 9.6 µs |
| bounce idiom | 1.5 µs | 11.6 µs |
| vector `add([…], mul([…], 3))` | 1.2 µs | 11.7 µs |
| compile `wiggle(3, 40) + linear(…)` | 3.2 µs | 7.8 µs |
| 2 000-layer 2D world matrices (forest) | 0.11 ms | 0.52 ms |
| 2 000-deep chain | 0.11 ms | 0.59 ms |
| `composeNodeWorld3d` × 2 000 | 0.23 ms | 0.37 ms |

## The render graph (engine/src/render_graph, D2 + D3)

`premation-render` renders exported FrameScenes (`npm run render-tests` runs it
as the `native` backend: 436/436 frames bit-identical to the TS WebGPU frame).
Its PNGs pass through the webgpu pass's MEASURED readback table
(`--readback-table`, see `harness_readback` in tools/premation_render.cpp):
the harness's PNG encode re-quantises low-alpha pixels, and a native PNG must
carry the same re-quantisation to be comparable byte for byte. `--raw 1`
writes the surface bytes untouched.

- **Bit depth** (`bit_depth.hpp`): project 32 → rgba32float intermediates (no
  MSAA; the device must filter and blend rgba32float), 16 → today, 8 → unorm.
- **Colour management** (`color/`): OpenColorIO 2.5 (vcpkg `engine` feature,
  only `ocio_ffi.cpp` includes it). Programs are OCIO's LOSSLESS-optimized op
  list interpreted in WGSL (`shaders/color_wgsl.hpp`, CPU twin
  `color_program.cpp`), or a baked log2-shaped lattice for ops the list cannot
  express. `test_render_graph_gpu_d3.cpp [measure]` prints the error and cost
  of both routes.
- **clang-tidy**: `node scripts/native.mjs tidy --engine` gates
  `engine/src/render_graph` too (its `.clang-tidy` states each disabled check).
- **ASan with Dawn + OCIO**: the render graph links uninstrumented vcpkg Dawn
  and OCIO under clang-cl ASan (same container-annotation rule as Catch2
  above). Configure an engine tree with the sanitizer on, e.g.
  `cmake --preset windows-clang-cl-engine -B build/windows-clang-cl-engine-asan -DMOTION_SANITIZE=asan-ubsan -DCMAKE_BUILD_TYPE=RelWithDebInfo`,
  build `premation-render engine_gpu_tests`, and put the clang resource
  directory's `lib/windows` on PATH. Verified 2026-09-23 in a tree built with
  exactly these flags (cmake/sanitizers.cmake over the render-graph targets):
  every render-graph test and all 436 golden FrameScenes run clean and
  byte-identical under ASan.

## Adding a library (N2+)

`libs/<name>/CMakeLists.txt` with a `STATIC` target linking `motion::options`
and the libraries below it in the §3 order; its C ABI in
`include/motion/<name>.h`; Catch2 tests in `tests/`; bench in `bench/`. FFI to
ffmpeg/Skia/OS lives only in `*_ffi.cpp`. Add the vcpkg ports to `vcpkg.json`
and bump `MOTION_ABI_VERSION_MINOR` (or MAJOR for a breaking struct/enum change)
in `include/motion/motion_abi.h`.
