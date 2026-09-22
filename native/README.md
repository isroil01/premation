# Premation native core (`native/`)

C++20 libraries under the existing editor, per `docs/NATIVE_CORE_PLAN.md`
(§2 ground rules, §3 layout). This directory currently holds the N0 toolchain
skeleton and the first library, **`motion_eval`** — keyframe sampling ported
from `packages/animation/src/interpolate.ts` and gated against it by a golden
table the TypeScript generates.

```text
native/
  CMakeLists.txt, CMakePresets.json, vcpkg.json     workspace + presets
  cmake/warnings.cmake, cmake/sanitizers.cmake       motion::options
  include/motion/motion_abi.h, motion_eval.h         the ONE public C ABI
  libs/motion_eval/                                  eval.hpp/.cpp (internal), motion_eval.cpp (C wrappers)
  tests/                                             Catch2; gen_golden.ts → golden_bezier.inc
  bench/                                             Google Benchmark
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

## Adding a library (N2+)

`libs/<name>/CMakeLists.txt` with a `STATIC` target linking `motion::options`
and the libraries below it in the §3 order; its C ABI in
`include/motion/<name>.h`; Catch2 tests in `tests/`; bench in `bench/`. FFI to
ffmpeg/Skia/OS lives only in `*_ffi.cpp`. Add the vcpkg ports to `vcpkg.json`
and bump `MOTION_ABI_VERSION_MINOR` (or MAJOR for a breaking struct/enum change)
in `include/motion/motion_abi.h`.
