// premation-export-sink — a stand-in for ffmpeg in export tests and parity runs:
// every byte on stdin goes to the file named by the LAST argument (ffmpeg's
// output position), whatever the other arguments say. With it, both export
// paths (the Chromium raw pipe and the engine) deliver the exact raw RGBA
// stream they would have encoded, so the two can be compared byte for byte.
//
//   FFMPEG_PATH=premation-export-sink   (the Chromium path, electron/main.ts)
//   {"encode":{"bin":"premation-export-sink","args":[…, OUT]}}   (the engine)
#include <cstdio>
#include <span>
#include <vector>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#endif

int main(int argc, char** argv) {
  const std::span<char*> args(argv, static_cast<std::size_t>(argc));
  if (args.size() < 2) {
    std::fprintf(stderr, "usage: premation-export-sink [ignored…] OUT\n");  // NOLINT(cppcoreguidelines-pro-type-vararg)
    return 64;
  }
#if defined(_WIN32)
  (void)_setmode(_fileno(stdin), _O_BINARY);
#endif
  std::FILE* out = std::fopen(args.back(), "wb");  // NOLINT(cppcoreguidelines-owning-memory)
  if (out == nullptr) {
    std::fprintf(stderr, "premation-export-sink: cannot write %s\n", args.back());  // NOLINT(cppcoreguidelines-pro-type-vararg)
    return 1;
  }
  std::vector<char> buf(std::size_t{1} << 22U);
  for (;;) {
    const std::size_t n = std::fread(buf.data(), 1, buf.size(), stdin);
    if (n == 0) break;
    if (std::fwrite(buf.data(), 1, n, out) != n) {
      (void)std::fclose(out);  // NOLINT(cppcoreguidelines-owning-memory)
      return 1;
    }
  }
  return std::fclose(out) == 0 ? 0 : 1;  // NOLINT(cppcoreguidelines-owning-memory)
}
