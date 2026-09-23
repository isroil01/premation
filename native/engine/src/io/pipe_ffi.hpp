// The engine's four pipes. Every OS call for them lives in pipe_ffi.cpp.
//
//   stdin   fd 0  command pipe, host → engine   (framed EngineMessages)
//   stdout  fd 1  command pipe, engine → host   (framed EngineMessages)
//   stderr  fd 2  structured log (JSON lines)
//   fd 3          frame channel, engine → host  (Slots, FrameReady, Pong)
//   fd 4          frame channel, host → engine  (Release, Ping)
//
// Why stdio and not a named pipe: the child's stdio pipes need no name, no
// security descriptor, no rendezvous and no cleanup; they close by themselves
// when either process dies (stdin EOF is how the engine learns the host is
// gone), and they are identical on Windows, macOS and Linux. The one risk —
// a library (Dawn, DXC, a driver) printing to stdout and corrupting the
// framing — is removed by `claim_stdio`: the protocol keeps a private
// duplicate of stdout and fd 1 is pointed at stderr, so a stray printf lands
// in the log.
//
// Why the frame channel is two one-way pipes (fd 3 out, fd 4 in) rather than
// one duplex pipe: on Windows the child end of a Node/libuv pipe is a
// SYNCHRONOUS handle, and synchronous I/O on one handle is serialised — a
// WriteFile (a FrameReady) would wait behind the reader thread's blocking
// ReadFile until the host happened to send something. One direction per
// handle, one thread per handle, no serialisation.
#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <string>

namespace premation::io {

/// An OS pipe handle (HANDLE on Windows, fd elsewhere); -1 = none.
struct Handle {
  std::intptr_t value = -1;
  [[nodiscard]] bool valid() const noexcept { return value != -1; }
};

struct Pipes {
  Handle commandIn;
  Handle commandOut;
  Handle framesOut;  // fd 3
  Handle framesIn;   // fd 4
};

/// Take stdin/stdout for the protocol (binary, private stdout duplicate, fd 1
/// redirected to stderr) and look for fds 3/4. False only when stdin/stdout
/// are unusable.
bool claim_stdio(Pipes& pipes, std::string& error);

/// Blocking read of up to buf.size() bytes. >0 bytes read, 0 end of stream, <0 error.
std::ptrdiff_t read_some(Handle h, std::span<std::uint8_t> buf) noexcept;

/// Blocking write of the whole buffer. False when the reader is gone.
bool write_all(Handle h, std::span<const std::uint8_t> data) noexcept;

}  // namespace premation::io
