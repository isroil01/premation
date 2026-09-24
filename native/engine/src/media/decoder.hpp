// One video stream's demuxer + decoder (ffmpeg behind the interface; the only
// code that includes libav* is decoder_ffi.cpp). Single-threaded: a decoder
// belongs to one worker thread (MediaSystem gives every source its own), while
// libavcodec runs its own slice/frame threads underneath.
#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "decoded_frame.hpp"
#include "frame_cache.hpp"
#include "frame_index.hpp"
#include "media_types.hpp"

namespace premation::media {

/// A hardware decode device shared by every decoder on one GPU (Windows: a
/// D3D11 video device on the adapter Dawn renders with, so decoded surfaces
/// can be imported with no copy through the CPU).
class HwContext;

struct HwContextOptions {
  /// The adapter to decode on (DXGI LUID; 0 = the system default). The engine
  /// passes Dawn's adapter so frames never cross GPUs.
  std::uint64_t adapterLuid = 0;
  /// Windows: d3d11va (default, zero-copy capable), d3d12va, dxva2 or nvdec;
  /// ignored elsewhere (videotoolbox / vaapi picked per platform).
  DecodePath preferred = DecodePath::d3d11va;
};

// shared_ptr: one device serves every decoder and the GPU import side, and a
// decoded surface may outlive any single decoder (it sits in the frame cache).
[[nodiscard]] std::shared_ptr<HwContext> create_hw_context(const HwContextOptions& options, std::string& error);
[[nodiscard]] DecodePath hw_path(const HwContext& hw) noexcept;
[[nodiscard]] std::string hw_adapter(const HwContext& hw);

struct DecoderOptions {
  HwPolicy hw = HwPolicy::automatic;
  std::shared_ptr<HwContext> hwContext;  // required for hardware decode
  /// Keep hardware frames on the GPU (zero-copy route). False → download to
  /// NV12/P010 system memory (the portable route; one upload later).
  bool keepOnGpu = true;
  /// Keep 10/16-bit (P010/P016) hardware frames on the GPU too. Off unless the
  /// consumer can import them (FrameConverter::zero_copy_p010 — Dawn's
  /// MultiPlanarFormatP010, not offered on D3D12 by the pinned Dawn): such
  /// frames are downloaded to system memory instead (one upload later).
  bool keepHighBitOnGpu = false;
  /// libavcodec threads (0 = one per core, capped at 16).
  int threads = 0;
  /// Fault injection for tests: the hardware decoder "fails" once it has
  /// delivered this many frames (-1 = never), exercising the per-clip software fallback.
  int failHwAtFrame = -1;
  /// Build the exact presentation index with a demux-only scan when the
  /// container's own index can't give presentation times (long-GOP with
  /// B-frames). False = constant-frame-rate index.
  bool scanIndex = true;
};

enum class DecodeStatus : std::uint8_t { frame, eof, cancelled, error };

class VideoDecoder {
 public:
  static std::unique_ptr<VideoDecoder> open(const std::string& path, const DecoderOptions& options, std::string& error);
  /// Probe only (no decoder): container, streams, colour — and the frame index
  /// when the container's own index gives it (MOV/MP4 intra or no-reorder
  /// streams), else a constant-rate index. Cheap: no packet is read.
  static bool probe(const std::string& path, MediaInfo& out, FrameIndex& index, std::string& error);

  VideoDecoder() = default;
  virtual ~VideoDecoder() = default;
  VideoDecoder(const VideoDecoder&) = delete;
  VideoDecoder& operator=(const VideoDecoder&) = delete;
  VideoDecoder(VideoDecoder&&) = delete;
  VideoDecoder& operator=(VideoDecoder&&) = delete;

  [[nodiscard]] virtual const MediaInfo& info() const noexcept = 0;
  [[nodiscard]] virtual const FrameIndex& index() const noexcept = 0;
  [[nodiscard]] virtual DecodePath path() const noexcept = 0;

  /// Position so the next frames come from the GOP that contains presentation
  /// frame `frame` (seek to its keyframe + flush). Frames before the GOP are
  /// skipped by next().
  virtual bool seek(std::int64_t frame, std::string& error) = 0;
  /// The next frame in presentation order (its index set from its pts).
  /// `cancel`: checked between packets; when it differs from `generation` the
  /// call returns `cancelled`. Nothing is lost: calling next() again resumes.
  virtual DecodeStatus next(FramePtr& out, std::string& error, const std::atomic<std::uint64_t>* cancel = nullptr,
                            std::uint64_t generation = 0) = 0;
  /// The index of the frame next() would return, if known (-1 after a seek until the first frame).
  [[nodiscard]] virtual std::int64_t position() const noexcept = 0;
  /// The keyframe the decoder last seeked to (presentation index; -1 = none).
  [[nodiscard]] virtual std::int64_t seeked_gop() const noexcept = 0;
  /// Why this clip left the hardware decoder for software ("" = it did not):
  /// "<path>: refused …" at the first frame, or the mid-stream error.
  [[nodiscard]] virtual const std::string& hw_fallback() const noexcept = 0;
  /// Replace the presentation index (a background scan finished); used from the next seek on.
  virtual void set_index(FrameIndex index) = 0;
};

/// A demux-only pass over the whole stream → exact presentation index (the
/// long-GOP case). Runs on any thread; its own file handle.
[[nodiscard]] bool scan_index(const std::string& path, int streamIndex, FrameIndex& out, std::string& error,
                              const std::atomic<bool>* stop = nullptr);

}  // namespace premation::media
