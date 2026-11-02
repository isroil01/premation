#include "sam_embed_cache.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <system_error>

namespace premation::jobs::sam {

namespace fs = std::filesystem;

namespace {

constexpr std::array<char, 8> kMagic{'P', 'S', 'A', 'M', 'E', 'M', 'B', '1'};
constexpr std::size_t kMaxRank = 8;
constexpr std::uint64_t kMaxElements = std::uint64_t{64} * 1024 * 1024;  // a corrupt header never allocates more

fs::path u8path(const std::string& s) { return fs::path(std::u8string(s.begin(), s.end())); }

std::uint64_t fnv1a(const std::string& s) {
  std::uint64_t h = 14695981039346656037ULL;
  for (const char c : s) {
    h ^= static_cast<unsigned char>(c);
    h *= 1099511628211ULL;
  }
  return h;
}

fs::path entry_path(const std::string& dir, const std::string& key) {
  static constexpr std::array<char, 16> hex{'0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'};
  std::uint64_t h = fnv1a(key);
  std::string name(16, '0');
  for (std::size_t i = 0; i < 16; ++i) {
    name[15 - i] = hex[h & 0xF];
    h >>= 4;
  }
  return u8path(dir) / ("sam_" + name + ".emb");
}

template <typename T>
void put(std::ofstream& f, const T& v) {
  f.write(reinterpret_cast<const char*>(&v), sizeof(T));
}
template <typename T>
bool get(std::ifstream& f, T& v) {
  return static_cast<bool>(f.read(reinterpret_cast<char*>(&v), sizeof(T)));
}

void put_tensor(std::ofstream& f, const CachedTensor& t) {
  put(f, static_cast<std::uint32_t>(t.shape.size()));
  for (const std::int64_t d : t.shape) put(f, d);
  put(f, static_cast<std::uint64_t>(t.data.size()));
  f.write(reinterpret_cast<const char*>(t.data.data()), static_cast<std::streamsize>(t.data.size() * sizeof(float)));
}

bool get_tensor(std::ifstream& f, CachedTensor& t) {
  std::uint32_t rank = 0;
  if (!get(f, rank) || rank > kMaxRank) return false;
  t.shape.resize(rank);
  std::uint64_t want = 1;
  for (std::int64_t& d : t.shape) {
    if (!get(f, d) || d <= 0) return false;
    want *= static_cast<std::uint64_t>(d);
  }
  std::uint64_t n = 0;
  if (!get(f, n) || n != want || n > kMaxElements) return false;
  t.data.resize(static_cast<std::size_t>(n));
  return static_cast<bool>(f.read(reinterpret_cast<char*>(t.data.data()), static_cast<std::streamsize>(n * sizeof(float))));
}

std::string stamp(const std::string& file) {
  std::error_code ec;
  const fs::path p = u8path(file);
  const auto t = fs::last_write_time(p, ec);
  if (ec) return {};
  const std::uintmax_t size = fs::file_size(p, ec);
  if (ec) return {};
  // In nanoseconds: libc++'s file_clock counts in a 128-bit integer, which has no to_string.
  const auto ns = std::chrono::duration_cast<std::chrono::nanoseconds>(t.time_since_epoch()).count();
  return std::to_string(static_cast<long long>(ns)) + ":" + std::to_string(size);
}

}  // namespace

std::string embedding_key(const std::string& footage, std::int64_t frame, const std::string& encoderModel) {
  const std::string a = stamp(footage);
  const std::string b = stamp(encoderModel);
  if (a.empty() || b.empty()) return {};
  return footage + "|" + a + "|" + std::to_string(frame) + "|" + encoderModel + "|" + b;
}

std::optional<CachedEmbedding> read_embedding(const std::string& dir, const std::string& key) {
  if (dir.empty() || key.empty()) return std::nullopt;
  const fs::path p = entry_path(dir, key);
  std::ifstream f(p, std::ios::binary);
  if (!f) return std::nullopt;
  std::array<char, 8> magic{};
  if (!f.read(magic.data(), magic.size()) || magic != kMagic) return std::nullopt;
  std::uint32_t keyLen = 0;
  if (!get(f, keyLen) || keyLen > 64 * 1024) return std::nullopt;
  std::string stored(keyLen, '\0');
  if (!f.read(stored.data(), keyLen) || stored != key) return std::nullopt;  // a hash collision is a miss
  CachedEmbedding e;
  if (!get(f, e.width) || !get(f, e.height) || !get_tensor(f, e.image) || !get_tensor(f, e.positional)) return std::nullopt;
  f.close();
  std::error_code ec;
  fs::last_write_time(p, fs::file_time_type::clock::now(), ec);  // recent again (the pruning order)
  return e;
}

bool write_embedding(const std::string& dir, const std::string& key, const CachedEmbedding& e, std::size_t keep) {
  if (dir.empty() || key.empty()) return false;
  std::error_code ec;
  fs::create_directories(u8path(dir), ec);
  if (ec) return false;
  const fs::path p = entry_path(dir, key);
  fs::path tmp = p;
  tmp += ".tmp";
  {
    std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
    if (!f) return false;
    f.write(kMagic.data(), kMagic.size());
    put(f, static_cast<std::uint32_t>(key.size()));
    f.write(key.data(), static_cast<std::streamsize>(key.size()));
    put(f, e.width);
    put(f, e.height);
    put_tensor(f, e.image);
    put_tensor(f, e.positional);
    if (!f) {
      f.close();
      fs::remove(tmp, ec);
      return false;
    }
  }
  fs::rename(tmp, p, ec);
  if (ec) {
    fs::remove(tmp, ec);
    return false;
  }
  // Keep the `keep` most recent entries.
  std::vector<std::pair<fs::file_time_type, fs::path>> entries;
  for (const fs::directory_entry& d : fs::directory_iterator(u8path(dir), ec)) {
    if (d.path().extension() != ".emb") continue;
    std::error_code e2;
    entries.emplace_back(d.last_write_time(e2), d.path());
  }
  if (entries.size() > keep) {
    std::sort(entries.begin(), entries.end(), [](const auto& a, const auto& b) { return a.first > b.first; });
    for (std::size_t i = keep; i < entries.size(); ++i) fs::remove(entries[i].second, ec);
  }
  return true;
}

}  // namespace premation::jobs::sam
