// The crash journal's file mapping (journal.hpp) — OS FFI.
#include "journal.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <bit>
#include <cstring>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/file.h>
#include <sys/mman.h>
#include <unistd.h>
#endif

namespace premation::plugins {
namespace {

constexpr std::uint32_t kMagic = 0x4A474C50;  // 'PLGJ'
constexpr std::uint32_t kVersion = 1;

struct Header {
  std::uint32_t magic;
  std::uint32_t version;
  std::uint32_t slots;
  std::uint32_t quarantine;
};
struct Slot {
  std::uint32_t active;
  std::int32_t cmd;
  std::array<char, CrashJournal::kIdBytes> plugin;
};
struct QEntry {
  std::uint32_t used;
  std::uint32_t pad;
  std::array<char, CrashJournal::kIdBytes> plugin;
  std::array<char, CrashJournal::kReasonBytes> reason;
};
struct Layout {
  Header header;
  std::array<Slot, CrashJournal::kSlots> slots;
  std::array<QEntry, CrashJournal::kQuarantine> quarantine;
};
constexpr std::size_t kFileBytes = (sizeof(Layout) + 4095) / 4096 * 4096;

template <std::size_t N>
void put(std::array<char, N>& dst, std::string_view s) noexcept {
  const std::size_t n = std::min(s.size(), N - 1);
  std::memcpy(dst.data(), s.data(), n);
  dst[n] = '\0';
}

template <std::size_t N>
std::string get(const std::array<char, N>& src) {
  const auto end = std::find(src.begin(), src.end(), '\0');
  return {src.begin(), end};
}

}  // namespace

struct CrashJournal::Mapping {
#if defined(_WIN32)
  HANDLE file = INVALID_HANDLE_VALUE;
  HANDLE mapping = nullptr;
#else
  int fd = -1;
#endif
  void* view = nullptr;
  [[nodiscard]] Layout& layout() const { return *static_cast<Layout*>(view); }

  ~Mapping() {
#if defined(_WIN32)
    if (view != nullptr) {
      FlushViewOfFile(view, 0);
      UnmapViewOfFile(view);
    }
    if (mapping != nullptr) CloseHandle(mapping);
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
#else
    if (view != nullptr) munmap(view, kFileBytes);
    if (fd >= 0) close(fd);
#endif
  }
  Mapping() = default;
  Mapping(const Mapping&) = delete;
  Mapping& operator=(const Mapping&) = delete;
  Mapping(Mapping&&) = delete;
  Mapping& operator=(Mapping&&) = delete;
};

std::unique_ptr<CrashJournal> CrashJournal::open(const std::filesystem::path& file, std::string& error) {
  std::error_code ec;
  if (file.has_parent_path()) std::filesystem::create_directories(file.parent_path(), ec);
  auto m = std::make_unique<Mapping>();
#if defined(_WIN32)
  // Exclusive: one engine process per journal (a second one runs unjournaled).
  m->file = CreateFileW(file.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (m->file == INVALID_HANDLE_VALUE) {
    error = "cannot open the plugin journal (" + std::to_string(GetLastError()) + ")";
    return nullptr;
  }
  LARGE_INTEGER size{};
  GetFileSizeEx(m->file, &size);
  if (static_cast<std::size_t>(size.QuadPart) < kFileBytes) {
    LARGE_INTEGER want{};
    want.QuadPart = static_cast<LONGLONG>(kFileBytes);
    SetFilePointerEx(m->file, want, nullptr, FILE_BEGIN);
    SetEndOfFile(m->file);
  }
  m->mapping = CreateFileMappingW(m->file, nullptr, PAGE_READWRITE, 0, static_cast<DWORD>(kFileBytes), nullptr);
  if (m->mapping == nullptr) {
    error = "cannot map the plugin journal (" + std::to_string(GetLastError()) + ")";
    return nullptr;
  }
  m->view = MapViewOfFile(m->mapping, FILE_MAP_ALL_ACCESS, 0, 0, kFileBytes);
#else
  m->fd = ::open(file.c_str(), O_RDWR | O_CREAT, 0644);
  if (m->fd < 0 || flock(m->fd, LOCK_EX | LOCK_NB) != 0) {
    error = "cannot open the plugin journal";
    return nullptr;
  }
  if (ftruncate(m->fd, static_cast<off_t>(kFileBytes)) != 0) {
    error = "cannot size the plugin journal";
    return nullptr;
  }
  void* v = mmap(nullptr, kFileBytes, PROT_READ | PROT_WRITE, MAP_SHARED, m->fd, 0);
  m->view = v == MAP_FAILED ? nullptr : v;  // NOLINT(cppcoreguidelines-pro-type-cstyle-cast, performance-no-int-to-ptr): MAP_FAILED
#endif
  if (m->view == nullptr) {
    error = "cannot map the plugin journal view";
    return nullptr;
  }
  Layout& l = m->layout();
  if (l.header.magic != kMagic || l.header.version != kVersion) {
    std::memset(&l, 0, sizeof(Layout));
    l.header = {kMagic, kVersion, static_cast<std::uint32_t>(kSlots), static_cast<std::uint32_t>(kQuarantine)};
  }
  std::unique_ptr<CrashJournal> j(new CrashJournal());  // NOLINT(cppcoreguidelines-owning-memory): private ctor
  j->map_ = std::move(m);
  // What the previous process was doing when it died.
  for (Slot& s : l.slots) {
    if (s.active != 0) {
      const std::string id = get(s.plugin);
      if (!id.empty()) {
        j->quarantine(id, "the engine stopped inside " + std::string(command_name(s.cmd)) +
                              " (a crash, abort or hang the in-process guard could not contain)");
      }
    }
    s.active = 0;
    s.plugin.fill('\0');
  }
  return j;
}

CrashJournal::~CrashJournal() = default;

int CrashJournal::enter(std::string_view pluginId, std::int32_t cmd) noexcept {
  std::uint64_t cur = busy_.load(std::memory_order_relaxed);
  for (;;) {
    const std::uint64_t free = ~cur;
    if (free == 0) return -1;
    const int slot = std::countr_zero(free);
    if (busy_.compare_exchange_weak(cur, cur | (std::uint64_t{1} << static_cast<unsigned>(slot)), std::memory_order_acquire)) {
      Slot& s = map_->layout().slots.at(static_cast<std::size_t>(slot));
      put(s.plugin, pluginId);
      s.cmd = cmd;
      std::atomic_ref<std::uint32_t>(s.active).store(1, std::memory_order_release);
      return slot;
    }
  }
}

void CrashJournal::leave(int slot) noexcept {
  if (slot < 0) return;
  Slot& s = map_->layout().slots.at(static_cast<std::size_t>(slot));
  std::atomic_ref<std::uint32_t>(s.active).store(0, std::memory_order_release);
  busy_.fetch_and(~(std::uint64_t{1} << static_cast<unsigned>(slot)), std::memory_order_release);
}

std::vector<QuarantineEntry> CrashJournal::quarantined() const {
  std::vector<QuarantineEntry> out;
  for (const QEntry& q : map_->layout().quarantine) {
    if (q.used != 0) out.push_back({get(q.plugin), get(q.reason)});
  }
  return out;
}

bool CrashJournal::is_quarantined(std::string_view pluginId) const {
  return std::ranges::any_of(map_->layout().quarantine, [&](const QEntry& q) { return q.used != 0 && get(q.plugin) == pluginId; });
}

void CrashJournal::quarantine(std::string_view pluginId, std::string_view reason) noexcept {
  Layout& l = map_->layout();
  QEntry* slot = nullptr;
  for (QEntry& q : l.quarantine) {
    if (q.used != 0 && get(q.plugin) == pluginId) slot = &q;
  }
  for (QEntry& q : l.quarantine) {
    if (slot == nullptr && q.used == 0) slot = &q;
  }
  if (slot == nullptr) slot = l.quarantine.data();  // full: overwrite the oldest entry
  put(slot->plugin, pluginId);
  put(slot->reason, reason);
  std::atomic_ref<std::uint32_t>(slot->used).store(1, std::memory_order_release);
}

void CrashJournal::release(std::string_view pluginId) noexcept {
  for (QEntry& q : map_->layout().quarantine) {
    if (q.used != 0 && get(q.plugin) == pluginId) {
      std::atomic_ref<std::uint32_t>(q.used).store(0, std::memory_order_release);
      q.plugin.fill('\0');
      q.reason.fill('\0');
    }
  }
}

std::string_view command_name(std::int32_t cmd) noexcept {
  static constexpr std::array<std::string_view, 18> kNames = {
      "ABOUT",           "GLOBAL_SETUP",       "GLOBAL_SETDOWN",   "PARAMS_SETUP",      "SEQUENCE_SETUP",
      "SEQUENCE_RESETUP", "SEQUENCE_FLATTEN",  "SEQUENCE_SETDOWN", "FRAME_SETUP",       "FRAME_SETDOWN",
      "RENDER",          "SMART_PRE_RENDER",   "SMART_RENDER",     "USER_CHANGED_PARAM", "UPDATE_PARAMS_UI",
      "GPU_DEVICE_SETUP", "GPU_DEVICE_SETDOWN", "SMART_RENDER_GPU"};
  return cmd >= 0 && static_cast<std::size_t>(cmd) < kNames.size() ? kNames.at(static_cast<std::size_t>(cmd)) : "a selector";
}

}  // namespace premation::plugins
