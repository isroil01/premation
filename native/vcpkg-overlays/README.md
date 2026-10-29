# vcpkg overlay ports

Ports here replace the builtin port of the same name at the pinned baseline
(`native/vcpkg-configuration.json` → `overlay-ports`). Each is the baseline port
verbatim plus the smallest change we need; the change is marked `Premation
overlay` in its portfile. Re-copy from the baseline when the baseline moves.

| Port | Change | Why |
|---|---|---|
| `onnxruntime` (1.23.2#1) | declares the `directml` and `coreml` features the builtin portfile already maps (`onnxruntime_USE_DML` / `_USE_COREML`) but does not list; pins the Microsoft.AI.DirectML 1.15.4 NuGet (SHA-512) and feeds it to ORT's "custom DirectML" inputs, installs `DirectML.dll` in `bin/`; drops the delay-load link flags a static build cannot carry and the flatc-23.5.26 version guard of the DML provider's pre-generated headers; pins psimd / FP16 / coremltools 7.1 (ORT's deps.txt SHA-1s) for Core ML in place of FetchContent | GPU inference for the ML jobs (AE parity 3.1). vcpkg builds disconnected, so ORT cannot fetch DirectML or coremltools itself. The Core ML half has not been built on a Mac yet. |
| `skia` (148) | on Windows, `clang_win` points at the LLVM install when `clang-cl` is found | Skia compiled by MSVC falls back to its scalar raster pipeline (no lowp stages): measurably slower, and it rounds differently from Chromium's Canvas2D, which is built with clang and is the reference the E3 text/vector rasters are compared against. |
| `pdfium` (chromium/8100) | a new port, not an overlay of a builtin: the prebuilt shared library from bblanchon/pdfium-binaries (win-x64, mac-arm64, mac-x64), each archive pinned by SHA-512; installs `include/pdfium`, the DLL / dylib and an imported target `pdfium::pdfium` | PDF / Illustrator footage (scene/pdf_render_ffi.cpp). vcpkg has no PDFium port, and a source build needs PDFium's Chromium build tree (gclient). Bump `PDFIUM_RELEASE` and all three hashes together. The macOS half has not been built on a Mac yet. |
