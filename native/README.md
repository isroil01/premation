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
node native/tests/gen_golden_expr.ts        # golden_expr.inc (6 264 samples, 1 591 expressions), golden_expr_engine.inc (195)
node native/tests/gen_golden_transform.ts   # golden_transform.inc (3 336 rows, 60 410 doubles)
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

**What `motion_expr` covers.** The whole language (lexer, Pratt parser, error
text, the shared 200 000-step / depth-512 budget across cross-layer re-entry)
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

**TypeScript behaviours reproduced but flagged** (parity first; each is a
candidate fix on BOTH sides, together):
- `Math.random()` is reachable from expressions and is V8's unseeded random —
  non-deterministic rendering, against the plan's determinism rule. The port
  answers from a separate seeded sequence (so never equal to the TS); it is
  excluded from the goldens.
- `Math.pow` is platform-dependent in the TS engine (above).
- The TS parser has no depth guard: roughly 1 500–2 500 nested parentheses or
  ~12 000 prefix operators overflow V8's stack, and the exact threshold moves
  with JIT state (measured). The port stops at 2 000 levels / 12 000 prefix
  operators with the same "Maximum call stack size exceeded" message.
- `valueAtTime()` (no argument) on a ONE-keyframe track throws a TypeError
  inside `sampleTrack` (`kfs[1]` is undefined when `t` is NaN); on longer
  tracks it returns the last segment's NaN arithmetic. The engine Host must
  keep that (motion_eval's C API rejects NaN times; the internal `sample` does not).
- `worldMatrixOf` recurses without a cycle guard (a parent cycle is a stack
  overflow); `world_matrices_2d` is iterative and reports the cycle.
- `marker.key(NaN)` returns `undefined` (so `.time` throws) while `key(NaN)`
  returns `{index: NaN, time: 0}` — two answers to one question.
- `humanize` turns ANY runtime message containing "Unexpected"/"missing" into
  "Syntax error: …" (e.g. a layer named "missing").
- Sorting markers with NaN times is comparator-inconsistent in both languages.

**Transforms.** All scene-side TS math is float64 (Float32 appears only in
`packages/renderer`'s Mat3/Mat4 — the GPU side, D2), so the port is exact
double arithmetic in the TypeScript's operation order with V8's sin/cos/tan/
atan/atan2/hypot. Two compositions (`layerSpaceAt`'s 3D branch and
`buildSnapshot`'s `affineAt`) live inside scene-graph-bound functions; the
generator composes the same exported primitives in the same order, quoted in
`gen_golden_transform.ts`.

**Sanitizers on Windows.** The `windows-clang-cl-asan` preset does not link
today, for reasons outside these libraries: `cmake/sanitizers.cmake` hands
`/fsanitize=address` to lld-link, and the vcpkg Catch2 is not ASan-built
(`/failifmismatch: annotate_string`). The D1 suites were run under
ASan + UBSan by compiling the libraries and the three test files directly with
clang-cl against a tiny Catch2 stand-in: clean (UBSan's `alignment` check off —
it fires inside the UCRT's `wchar.h`). Sanitizer frames are large, so the
deepest goldens need more than Windows' 1 MB default stack; `motion_tests`
links with a 16 MB stack.

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

## Adding a library (N2+)

`libs/<name>/CMakeLists.txt` with a `STATIC` target linking `motion::options`
and the libraries below it in the §3 order; its C ABI in
`include/motion/<name>.h`; Catch2 tests in `tests/`; bench in `bench/`. FFI to
ffmpeg/Skia/OS lives only in `*_ffi.cpp`. Add the vcpkg ports to `vcpkg.json`
and bump `MOTION_ABI_VERSION_MINOR` (or MAJOR for a breaking struct/enum change)
in `include/motion/motion_abi.h`.
