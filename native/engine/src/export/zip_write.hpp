// F1: the archive an image sequence is delivered in — src/core/export/zip.ts
// `zipBytes` written to disk as it goes: STORE entries, no timestamps, local
// headers then the central directory, so identical entries give identical
// bytes. zip.ts is classic 32-bit ZIP (the browser build refuses past 3.5 GB);
// here an archive that outgrows it gains ZIP64 records, and one that does not
// is byte-identical to zipBytes.
#pragma once

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace premation::exporter {

class ZipWriter {
 public:
  bool open(const std::filesystem::path& path);
  /// One STORE entry. False when the entry is 4 GB or more, or the write failed.
  bool add(std::string_view name, std::span<const std::uint8_t> data);
  /// The central directory; the archive is complete once this returns true.
  bool finish();

 private:
  struct Record {
    std::string name;
    std::uint32_t crc = 0;
    std::uint32_t size = 0;
    std::uint64_t offset = 0;
  };
  void write(const std::vector<std::uint8_t>& bytes);
  std::ofstream out_;
  std::uint64_t offset_ = 0;
  std::vector<Record> records_;
};

}  // namespace premation::exporter
