# vcpkg overlay ports

Ports here replace the builtin port of the same name at the pinned baseline
(`native/vcpkg-configuration.json` → `overlay-ports`). Each is the baseline port
verbatim plus the smallest change we need; the change is marked `Premation
overlay` in its portfile. Re-copy from the baseline when the baseline moves.

| Port | Change | Why |
|---|---|---|
| `skia` (148) | on Windows, `clang_win` points at the LLVM install when `clang-cl` is found | Skia compiled by MSVC falls back to its scalar raster pipeline (no lowp stages): measurably slower, and it rounds differently from Chromium's Canvas2D, which is built with clang and is the reference the E3 text/vector rasters are compared against. |
