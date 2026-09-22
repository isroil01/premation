// OS services the engine needs outside Dawn. Every OS call lives in
// os_ffi.cpp (CLAUDE.md: FFI only in *_ffi.cpp).
#pragma once

#include <cstddef>
#include <cstdint>

namespace premation::os {

// stdout/stdin carry binary frames and must not translate \n.
void set_binary_stdio();

// Per-monitor-v2 DPI awareness, so a child window's coordinates are the same
// physical pixels Electron (also PMv2) reports.
void set_dpi_aware();

// User + kernel CPU time of this process, milliseconds.
double process_cpu_ms();

// Wall clock in microseconds since the Unix epoch. MEASUREMENT ONLY — the
// latency stamps in frame headers. Nothing that decides pixels reads it
// (rendering is a pure function of the frame counter).
double epoch_us();

// Blocking write of the whole buffer to stdout. False when the reader is gone.
bool write_stdout(const void* data, std::size_t bytes);

}  // namespace premation::os
