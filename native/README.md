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

## Media — footage decode (engine/src/media, E1)

`MediaSystem` decodes footage for the engine: ffmpeg 8.1 from vcpkg (`engine`
feature: avcodec/avformat/swscale/swresample + dav1d + libvpx; hwaccels d3d11va,
d3d12va, dxva2 on Windows, videotoolbox on macOS, nvdec via `nvcodec` on
Windows/Linux, vulkan on Linux). Clean vcpkg build 27 min, then from the binary
cache. libav* is included only by `decoder_ffi.cpp`, D3D11 only by
`d3d11_ffi.cpp`, Dawn-native/OS calls only by `platform_ffi.cpp`.

- **Probe** (`VideoDecoder::probe`): codec + profile, exact rational rate
  (24000/1001 stays that), duration, frame count, bit depth, chroma
  subsampling, alpha (ProRes 4444, VP8/VP9 `alpha_mode`), rotation, and colour
  as the file states it (H.273 primaries / transfer / matrix / range) plus the
  resolved matrix/range; HDR10 mastering display + MaxCLL/FALL (container side
  data, or the first frame's SEI).
- **Frame index** (`frame_index.cpp`): the TS `frameIndex.ts` rules — samples
  sorted by pts, rebased to the first displayed frame, integer µs, floor over
  `[start, next)` with the `+1 µs` lookup, ends clamp. From the container index
  when it lists every sample with presentation times (MOV/MP4 intra or
  non-reordered streams); else constant-rate at once and the exact index from a
  demux-only scan on a background thread (swapped in when done). Open-GOP
  leading B-frames start at the previous keyframe (the TS index starts them at
  their own and gets them wrong).
- **Decode**: a worker thread per source; hardware when the platform decoder
  takes the stream (a refusal at the first frame — H.264 High 10, 4:2:2 —
  reopens the codec in software, fully threaded), software otherwise
  (slice threads for intra codecs = single-frame latency; frame+slice for
  long-GOP). **Latest-wins**: a scrub request replaces the pending one and bumps
  a generation the decoder checks between packets; the in-flight GOP decode is
  retargeted (same GOP, further on), finished (≤ 120 ms left, or nothing
  delivered for 400 ms) or abandoned. `exact` requests (export) never are.
  Readahead fills a window ahead of the playhead. `FrameCache`: LRU by bytes,
  separate CPU and GPU budgets, keyed (source, frame).
- **To the GPU** (`frame_convert.cpp`): CPU frames upload their planes as-is
  (8/16-bit UINT textures, the decoder's own stride) and one WGSL pass applies
  the Y'CbCr matrix + range (`yuv.cpp`, BT.601/709/2020/240M/FCC/YCgCo, any
  bit depth), bilinear chroma (co-sited horizontally, centred vertically) and
  premultiplies alpha → RGBA16F, the stream's own R'G'B'. **Zero-copy on
  Windows**: a D3D11VA decoder slice is copied GPU→GPU into a pooled
  SHARED_NTHANDLE + keyed-mutex NV12 surface on Dawn's adapter (LUID) and
  imported into Dawn as a multi-planar texture — no byte crosses the CPU.
  10-bit (P010) surfaces are downloaded instead: the pinned Dawn does not offer
  `MultiPlanarFormatP010` on D3D12.
- **Render graph hook** (the one change outside src/media):
  `rg::ExternalTextureSource`, consulted by `PassContext::texture` for a
  `RenderTextureRef` whose hash has no blob; `SceneRenderer::set_external_textures`
  installs it; `RendererOptions::optionalFeatures` requests the video features.
  `MediaTextures` implements it for `media:<source>:<frame>` (and
  `media:<source>:<top>~<bottom>` pulldown weaves): preview never blocks
  (nearest cached frame, as `exactVideoFrames.ts`), export waits for the exact
  frame. `inputSpace` from `yuv.hpp input_space_of` feeds D3's OCIO input.
- **Time mapping** (`time_map.cpp`): loop, posterize, stretch/reverse/freeze,
  pulldown picks and frame-blend brackets (conform > probe > comp rate), ported
  from the TS formulas; the comp half (clip map, Speed %/Frames retime) is the
  document's (D1b `timeline.cpp`).

**Hookup** (for the engine's scene builder, once footage layers are in the C++
FrameScene): per footage layer, `sourceTime` (the document chain) →
`plan_frames(*media.index(src), …)` → one `RenderTextureRef{key, hash =
media_hash(src, frame), ready, inputSpace}` per frame (frame mix: `vfa:`/`vfb:`
as the TS exporter) with no blob; the render thread owns one `MediaTextures`
over the engine's `MediaSystem` (created with `create_hw_context({adapterLuid =
platform::adapter_luid(device)})`); transport play calls `media.playhead(src,
frame, dir)`.

`premation-decode-bench probe|scrub|play` measures it (header of
`tools/premation_decode_bench.cpp`); `engine_media_tests` makes its own
fixtures with libavcodec's encoders (ProRes 422/4444, DNxHR, MPEG-4 B-frames,
VP9 alpha, FFV1 RGB) and checks every frame's identity after random seeks.

## Audio (engine/src/audio, E2)

`AudioSystem` is the engine's sound: decode, effects, mix, playback, export,
waveform peaks, and the MASTER CLOCK. ffmpeg (same vcpkg `engine` feature as
E1, libav* only in `audio_decode_ffi.cpp`) + miniaudio 0.11.25 (header-only,
`engine` feature, only in `device_ffi.cpp`). `engine_audio_core` is free of
both and is what the sanitizer presets test.

- **Sources are conformed** (AE's model): decoded once, in order, down-mixed
  as `decodeAudioData` + the Web Audio destination do (mono stays mono; quad /
  5.1 by the spec's speaker rules; others: first two channels), resampled to
  the mix format (float32, 48 kHz, stereo — `MixFormat`) by one continuous
  swresample pass, into a lock-free chunk table (`SourceData`) the audio
  thread reads without locks. Frame n is the same sample however the playhead
  got there, so every read is sample-exact. A multi-resolution peak pyramid
  (min/max/Σx² per 256 frames, ×4 per level, per channel + the mono mix) is
  built in the same pass. `decode_range` also seeks sample-accurately (pre-roll
  + timestamp placement; WAV/FLAC/AAC-in-MP4 checked identical to a linear
  decode) for later streaming of very long files.
- **The mix is the TS one** (`src/core/audio`): the voice list of
  `audioScene.ts` (`Voice` = `AudioLayerState`), `audibleWindow` timing,
  varispeed by linear interpolation (pitch follows — the TS has no
  pitch-preserving stretch), reverse / Backwards as a mirrored read, effects
  BEFORE level, then the optional equal-power panner, summed. Effect chains
  are `connectAudioEffects` node for node on Web Audio node DSP ported from
  Chromium (biquad incl. the spec's dB-Q lowpass/highpass, DelayNode — whose
  feedback cycle is delayTime + 128 frames, as Chromium's pull model makes it,
  PeriodicWave oscillators, the DynamicsCompressor kernel, WaveShaper with its
  half-band 2×/4× samplers, a partitioned convolver). All 13 built-in effects
  + plugin declared chains (`PluginChain`). `voice_build.cpp` ports the pure
  halves of `buildAudioRetimeSegments` and `placeNestedVoices` (+ solo).
- **Automation** (`automation.hpp`): every keyframed parameter is sampled on a
  control grid at ABSOLUTE comp-frame multiples (`Program::controlPeriod`,
  default 128 = one quantum; the TS ramps at 50 Hz = 960 frames) and ramped
  linearly per sample. Anchoring to the comp clock (the TS anchors at the voice
  start) makes the curve independent of where playback began.
- **Determinism**: a `RenderPlan` renders whole render quanta at absolute
  frame multiples of 128, never allocating, locking or reading a clock; its
  output is a pure function of (program, the aligned start frame).
  `render_offline` (export) is bit-identical run to run AND to the realtime
  path, whatever the device's callback size (`test_audio.cpp [determinism]`).
  Stateful effects (reverb tails, compressor envelopes) start where the render
  starts — the same in preview and export.
- **Clock** (`clock.hpp`, `realtime.hpp`): the device callback reports frames
  written and frames PLAYED (WASAPI: written − GetCurrentPadding; elsewhere
  written − the reported depth); a delay-locked loop locks to the played
  frames, and every transport event (play, seek, loop wrap, pause) records a
  segment device-frame → comp-frame. `playhead(now)` = the comp time of the
  sample at the speaker (+ the master limiter's look-ahead). Transport
  discontinuities cross-fade a 5 ms tail of the old stream (no clicks); a
  scrub while stopped plays a 60 ms grain.
- **Integration seam for the Session (D1b)**: `transport_clock.hpp` —
  `TransportClock::media_elapsed(now)` replaces the wall clock in
  `Session::tick` (`k = floor(elapsed · compFps)`), nullopt → wall clock.
- **Waveform query** (`peaks.hpp`): `query_peaks(source, from, dur, buckets,
  monoMix)` answers 80_queries.eapi `WaveformPeaks` (interleaved min/max per
  bucket per channel + RMS) exactly — bucket edges where `computePeaks` puts
  them; `ts_envelope` gives the TS consumer's `peaks` (max |x| of the mono
  mix, clamped to 1), identical to `computePeaks` (test: 4 ranges).

**Parity gate** (`test_audio_parity.cpp`): `node
native/engine/tests/gen_audio_parity.mjs` runs the REAL `audioMixdown.ts`
`mixdownBuffer` in Electron's Chromium (OfflineAudioContext) over 36 scenes and
writes `tests/data/audio_parity.bin`; the C++ rebuilds the sources bit for bit
and compares. Gain, pan, keyframed level/pan, trims, varispeed, reverse, export
offset, backwards, stereo mixer, white-noise tone, compressor (incl. output
limit, de-esser, mono→stereo chain): bit-identical or ≤ 4e-7; biquads/delay/
reverb ≤ 4e-6 (> 110 dB SNR); oscillators 97–130 dB; flanger 45 dB (Chromium
reads LFO tables with Lagrange interpolation); 4× distortion 52–84 dB.

**Found by porting (TS side, not copied or not fixed here):** `readAudioEffects`
drops `flags` and `curve` and rejects `wave: 'white-noise'` and every plugin
effect type, so those settings never reach the graph from a saved project
(the C++ honours them); `connectAudioEffects`' `bind` for a plugin effect calls
`AUDIO_EFFECT_DEFS[type].params` on an undefined entry; `mixdownBuffer`
reverses a Backwards / reversed clip over the window CLIPPED to the export
range (preview plays the bar's window; the C++ follows preview); reverse
`buildAudioRetimeSegments` merges keep the first sub-segment's `inSec` (the
upper end) — ported as is, fix both sides together; the effect tail rings on
past a clip's end in export but not in preview (the C++ cuts at the bar end,
as AE and the preview do); nested voices ignore the precomp layer's own level.

`premation-audio bench|smoke|render` (header of `tools/premation_audio.cpp`).

## Text and vector rasters (engine/src/raster, E3)

The TS text / shape / mask rasters are nothing but Canvas2D calls, and
Chromium's Canvas2D is Skia. So E3 is a **Canvas2D-semantics layer on Skia's
CPU raster backend** (`canvas.hpp`, Skia only in `canvas_ffi.cpp`) plus call-for-call
ports of the TS painters on top of it:

| file | TS it ports |
|---|---|
| `vector_paint.cpp` | `drawPath` / `vectorDraw`: fills (nonzero / evenodd), strokes, joins, caps, dashes, taper + wave, trim, gradients, rounded corners, repeaters, ordered paint stack |
| `mask_paint.cpp` | `paintMaskMatte` (+ expansion, feather as device-space blur) |
| `text_layout.cpp` | `textLayout` / `textExtras` / `verticalLayout`: wrapping, bidi lines, vertical columns, tate-chu-yoko, kinsoku, vertical forms |
| `text_paint.cpp` | `paintTextInBox`: fast + glyph paths, animators, text on path, gradients, stroke order, optical kerning wiring |
| `optical_kerning.cpp` / `optical_math.cpp` | `opticalKerning.ts` (raster ink profiles; outline profiles via `FontSet::glyph_outline`; vertical upright CJK pairs) |
| `paint_raster.cpp` | `paintRaster.ts` + `paintDabs.ts`: paint / eraser / clone strokes, dabs, Paint On Transparent |
| `line_break.cpp` / `word_break_ffi.cpp` | `lineBreak.ts`: kinsoku, break opportunities, greedy wrap; `Intl.Segmenter` word joins through the OS's ICU |
| `fonts_ffi.cpp` / `system_fonts_ffi.cpp` | font loading (woff2, TTC, system families via DirectWrite / fontconfig), CSS face matching + unicode-range fallback, HarfBuzz shaping with Blink's font funcs |
| `bidi_ffi.cpp` / `text_unicode.cpp` | SheenBidi (UAX #9 + L1 by hand), graphemes, case mapping |
| `raster_source.cpp` | `Canvas2DVectorRasterizer`: one raster from its source spec |

`engine_raster_core` (no Skia) holds the Canvas2D interface and everything that
only talks to it or to plain data: JSON / CSS, graphemes, line breaking + word
joins, fontconfig lookups, the optical-kerning math, `paint_common` and the
paint-stroke painter; `engine_raster` adds Skia, HarfBuzz, SheenBidi and the
text / vector painters. The canvas-drawn effects (`src/effects/canvas_effects.cpp`,
`engine_canvas_effects`) run on the same interface.

Dependencies (vcpkg `engine` feature): `skia` (overlay port in `vcpkg-overlays/`
building Skia with clang-cl: MSVC builds fall back to the scalar raster
pipeline), `harfbuzz`, `freetype[brotli]`, `woff2`, `sheenbidi`, `fontconfig`
(Linux). ICU is not linked: `word_break_ffi.cpp` loads the OS's ICU at run time
(Windows `icu.dll`, macOS `libicucore`, Linux `libicuuc.so.NN`) and binds its
stable C API; with none, word joins are off, exactly the TS's no-`Intl.Segmenter`
branch. The OS's ICU may be older or newer than Chromium's: raw word segments can
differ (ICU 74 vs 78 disagree on `x:y`), the break opportunities built from them
did not on the fixture.

**Cross-engine fixtures (Skia-free).** Four TS tests write fixtures that the
native tests replay, each `GEN_NATIVE_*=1 npx jest <name>` to regenerate:
`lineBreakCrossEngine` → `line_break_parity.json`; `opticalKerningCrossEngine`
→ `optical_kerning_parity.json` (synthetic exact-coverage glyph rasters);
`paintRasterCrossEngine` and `canvasEffectsCrossEngine` → the Canvas2D PROGRAM
the TS painter issues on a recording canvas
(`src/core/rendering/raster/__testHelpers__/recordingCanvas.ts`), which the C++
must issue op for op on `tests/recording_canvas.hpp` — calls, arguments to the
bit, gradient stops, canvas ids. Pixels are then the Canvas2D's job, which the
harness below gates.

**Glyph profiles.** `FontOptions::chromium_windows()` (DirectWrite, slight
hinting, subpixel positioning, LCD edging on an RGB-geometry surface, so
grayscale masks come from ClearType masks) is what Chromium's canvas does on
Windows, found by measurement; `FontOptions{}` (FreeType, unhinted, grayscale) is
the portable, deterministic profile.

**Parity harness.** The render-tests harness records every raster's source
spec and Canvas2D call log into the exported FrameScene (`RenderFrameFile.rasters`,
`packages/render-tests/harness/rasterRecorder.ts`). `premation-raster`:

```
premation-raster --batch <scenes> --fonts packages/render-tests/harness/fonts/fonts.json
                 --mode native|replay --profile chromium|portable [--report r.json] [--emit dir]
premation-raster --bench <scenes> --fonts … [--iterations N] [--threads N]
```

`replay` runs the recorded call log (rasterisation parity only); `native` runs
the ported painters from the spec (layout + rasterisation). `--emit` rewrites the
frame files with C++ texels so `premation-render` draws whole frames from them;
`npm run render-tests` with `HARNESS_NATIVE_RASTER=1` (or backend `native-raster`)
gates those frames against webgpu (`packages/render-tests/native-raster-baseline.json`).
`node packages/render-tests/scripts/bench-raster.mjs` is the TS-vs-C++ bench.

**Threads.** Skia takes a process-wide strike-cache lock on every
`getWidths` / `getBounds` / `getMetrics`; `fonts_ffi.cpp` keeps per-thread
caches of those values (bit-identical), without which 16 raster workers ran 4×
slower than one.

Not ported yet (each reported by name, never silently drawn wrong): CPU-baked
effect chains (E4), variable mask feather, `capitalize`, anisotropic blur,
WOFF1, system fonts on macOS, variation axes and the 'vert' face through alias
faces (`CanvasOptions::aliasFaces` covers OpenType features). Clone strokes that
name another layer or time draw as the TS raster does without a host clone
source (nothing / this layer's pixels).

## CPU effect kernels (engine/src/effects, E4)

The TS bake chain (`applyCanvas2dEffect` in `src/core/effects/canvas2dEffects.ts`)
runs each CPU effect as a pure kernel over the layer's straight RGBA8
`getImageData` buffer. `engine_effects` ports those kernels one for one, with
no Skia and no GPU:

| file | TS it ports |
|---|---|
| `blur_kernels.cpp` | `blurs.ts` (box / Gaussian, radial, channel, unsharp), `sharpenData` |
| `noise_kernels.cpp` | `noiseEffects.ts` (turbulent noise, add grain, median), `addNoiseData` |
| `morph_kernels.cpp` | `minimaxData`, `simpleChokerData` (van Herk / Gil-Werman min / max) |
| `stylize_kernels.cpp` | `stylize.ts` (mosaic, find edges, emboss), `vibranceData` |
| `advanced_blur_kernels.cpp` | `aeBlurAdvanced.ts` (bilateral, smart, camera lens + the ≤ 512 px budget proxy) |
| `color_kernels.cpp` | `aeColor.ts`, `toneEffects.ts`, `coloramaData` |
| `keying_kernels.cpp` | `keylight.ts`, `keyingEffects.ts`, `aeKeyingAdvanced.ts` |
| `distort_kernels.cpp` | `distort.ts` (`remap` + bulge … liquify) |
| `auto_color_kernels.cpp` | `aeColorAdvanced.ts` (histogram autos, HSL selectors, toner) |
| `transition_kernels.cpp` | `transitions.ts`, `aeChannel.ts` |
| `ae_*_kernels.cpp`, `round_*_kernels.cpp`, `warp_kernels.cpp` | the AE rounds: `aeStylizeAdvanced`, `aeTransitionsAdvanced`, `aeDistortAdvanced`, `aeRoundSix`, `aeRoundSeven*`, `ae*RoundFive`, `warp.ts` + `stylize.ts` noise bites |
| `paint_kernels.cpp` | `strokePaint.ts` (dab, Float32 paint buffer, Paint Style, polyline walk), `pathStroke.ts`, `scribble.ts`, `writeOnBrush.ts` |
| `generate_round_five_kernels.cpp` | `generateRoundFive.ts` (Star Burst, Snowfall, Rainfall, classic Write-on, Light Burst) |
| `round_seven_distort_kernels.cpp`, `simulation_kernels.cpp` | `aeRoundSevenDistort.ts`, `aeRoundSevenSimulation.ts` |
| `pattern_warp_lut_kernels.cpp` | `bezierWarp.ts`, `generatePatterns.ts` (Cell Pattern), `cubeLut.ts` |
| `glow_beam_kernels.cpp` | `deepGlow.ts` (with the renderer's `deepGlowKernel.ts`), `beamPath.ts` |
| `kernel_dispatch.cpp`, `kernel_dispatch_generate.cpp` | effect type + the TS kernel's argument names → kernel (139 effects) |

Arguments are numbers by name (`KernelArgs`) plus numeric arrays by name
(`KernelLists`): the resolved lists `buildSnapshot` hands the TS kernels —
packed mask paths (`maskPathsMeta` / `maskPathsXY`), Write-on brush trails,
`pathPoints` spines, `.cube` tables.

**Byte-exact.** Every kernel keeps the TS's operation order and its JavaScript
store semantics (`pixel_ops.hpp`): `Uint8ClampedArray` rounds half to even,
`Uint8Array` / `Uint16Array` truncate, `Float32Array` rounds to float; `Math.*`
is V8's (`motion::jsmath`); `-ffp-contract=off`. Where the TS sums integers the
C++ may slide a window (the sum is exact either way); where it sums floats
(Float32 box blurs, the vertical box pass past r ≈ 128) the C++ keeps the TS's
tap order. Min / max and rank filters use O(1)-per-pixel algorithms that give
the same order statistic.

**Threads.** `ThreadPool` (`std::jthread` workers) splits OUTPUT rows (or
column strips for vertical passes), so no output depends on the thread count;
the parity test runs every row on 1 and on 4 threads. Kernels that stamp in
sequence (brush dabs, particles, discs, streaks; a later stamp composites over
an earlier one) build the stamp list first and have every row chunk replay all
of it in order, clipped to its rows, so each pixel sees the TS's sequence. CC
Scatterize's forward scatter computes destinations in parallel and writes them
serially in scan order (the last writer wins, as in the TS). No intrinsics: the loops
are plain C++ (branch-free JS stores, no libm in the inner loops, since baseline
x86-64 has no `roundsd`), one path for every target.

**Parity.** `npx jest nativeKernelCrossEngine` (with `GEN_NATIVE_EFFECT_KERNELS=1`
to regenerate) runs the TS kernels on three synthetic inputs (odd sizes, a
transparent band with junk colour, a soft alpha ramp, one > 512 px wide for the
budget proxy) and writes `tests/data/effect_kernel_parity.json` (input bytes +
per-case FNV-1a 64); `engine_effects_tests` must match every hash.
`EFFECT_KERNEL_DUMP=<dir>` on either side dumps outputs as raw RGBA.

**Bench.** Same cases, same 1920×1080 input (`tests/data/effect_kernel_bench.json`):

```
premation-effects --bench native/engine/tests/data/effect_kernel_bench.json [--threads N] [--only <effect>]
node native/engine/tests/bench_effects_ts.mjs [--only <effect>]
```

Not wired yet: the bake CHAIN (compositing the kernels between Canvas2D-drawn
effects, masks, fill opacity, the effect-param → kernel-argument mapping of the
`apply*` wrappers) and the 27 canvas-drawn effects, which need the E3
`raster::Canvas` in the chain; see the E4 table in `docs/NATIVE_CORE_PLAN.md`.

## Adding a library (N2+)

`libs/<name>/CMakeLists.txt` with a `STATIC` target linking `motion::options`
and the libraries below it in the §3 order; its C ABI in
`include/motion/<name>.h`; Catch2 tests in `tests/`; bench in `bench/`. FFI to
ffmpeg/Skia/OS lives only in `*_ffi.cpp`. Add the vcpkg ports to `vcpkg.json`
and bump `MOTION_ABI_VERSION_MINOR` (or MAJOR for a breaking struct/enum change)
in `include/motion/motion_abi.h`.
