// F2 — the `.motion` project forms on disk, written and read by the engine
// (docs/NATIVE_CORE_PLAN.md §5 Phase F2, inventory row "ProjectManager +
// projectDocumentIO + bundleProjectIO / localProjectIO").
//
// Until F2 the page wrote these: the TypeScript engine's file port routed a
// `.motion` path to `BundleProjectStorage` (bundleCodec.ts chunks through
// `BundleRepository`, footage collected by bundleAssetCollect.ts) and Save
// Portable Copy packed a zip (portableMotion.ts). With the engine owning the
// document the page holds only its mirror, so the engine writes the same
// bytes itself. The format is the TypeScript one, unchanged — a bundle written
// here opens through the page's `BundleRepository`, and one written there
// opens here (bundleRoundTripCrossEngine.test.ts):
//
//   <root>.motion/
//     scene.json animation.json [timeline.json] [meta.json] [project.json]
//     manifest.json            {bundleFormat, documentVersion, chunks: {name: fnv64}}
//     assets/registry.json     {version, assets: AssetRecord[]}
//     blobs/<hh>/<sha256>      footage bytes, content-addressed
//
// Every file is written temp + rename, only chunks whose hash changed are
// rewritten, chunks that went away are removed, and the manifest is written
// LAST (BundleRepository.ts: the index never names a chunk that is not fully
// on disk). Files the codec does not know (versions/, ai/, a newer build's
// chunks) are left alone.
//
// Footage: a document references bundle footage as `motion-blob:<hash>`. The
// engine can reach bytes on disk, not the page's session object URLs
// (`blob:`), so collection copies every referenced blob the target lacks from
// the bundle the document came from (with its registry rows); `blob:` srcs are
// left as they are — with the engine as owner no import produces them (the C++
// engine has no media import port until E1).
//
// No OS or library FFI: std::filesystem and hand-written STORE zip framing.
#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <string>
#include <string_view>

#include "json.hpp"

namespace premation::doc {

/// hash.ts `hashString`: 64-bit FNV-1a over the UTF-16 code units of the text
/// (low byte, then high byte), 16 lowercase hex digits. `utf8` is decoded
/// first, so the hash equals the TypeScript one for the same string.
[[nodiscard]] std::string bundle_hash(std::string_view utf8);

/// zip.ts `crc32` (IEEE).
[[nodiscard]] std::uint32_t zip_crc32(std::string_view bytes);

/// A directory holding `manifest.json`.
[[nodiscard]] bool is_bundle_dir(const std::filesystem::path& dir);

/// bundleCodec.ts `decodeBundle` over the directory. `motion-blob:` refs are
/// kept (they name the bundle's own footage). Throws EngineFail(io) when there
/// is no manifest.
[[nodiscard]] js::Json read_bundle(const std::filesystem::path& dir);

/// BundleRepository.save + collectAssetsIntoBundle: write `doc` into the bundle
/// directory `dir` (created when absent). `source` is the bundle the
/// document's `motion-blob:` footage lives in (empty = none, or `dir` itself).
/// Returns the bytes written. Throws EngineFail(io); on a failure the previous
/// manifest (and so the previous project) is still the one on disk.
std::uint64_t write_bundle(const std::filesystem::path& dir, const js::Json& doc, const std::filesystem::path& source);

/// portableMotion.ts `packPortableMotion` with the footage the engine can reach
/// embedded: one STORE zip at `file` (temp + rename). Every component `src`
/// that is `motion-blob:<hash>` with the blob present in `source` becomes
/// `assets/<nodeId>.<ext>` (one file per hash). Returns the archive's size.
std::uint64_t write_portable(const std::filesystem::path& file, const js::Json& doc, const std::filesystem::path& source);

/// `bytes` to `target` through a sibling temp file and a rename (parents created).
/// Throws EngineFail(io).
void write_file_atomic(const std::filesystem::path& target, std::string_view bytes);

/// contentHash.ts `sha256Hex`: 64 lowercase hex digits (the blob store's content address).
[[nodiscard]] std::string sha256_hex(std::string_view bytes);

/// A regular file that starts with the zip magic (`PK`) — a portable `.motion`.
[[nodiscard]] bool is_portable_file(const std::filesystem::path& file);

/// What opening a portable `.motion` gives the session.
struct PortableOpen {
  js::Json doc;
  /// The staging bundle its footage was unpacked into (blobs/ + assets/registry.json).
  std::filesystem::path footageRoot;
  /// Footage files embedded and referenced.
  std::size_t embedded = 0;
};

/// portableMotion.ts `unpackPortableMotion` in the engine (F2: "Open portable
/// copy" with the engine as owner): the zip's chunks decoded as a bundle (a
/// wrapping `<name>.motion/` folder unwrapped), every embedded `assets/<file>`
/// written content-addressed into `staging` (`blobs/<hh>/<sha256>` plus a
/// registry row, id = the layer's `assetId` or `asset_<hash12>`) and each
/// component `src` naming it rewritten to `motion-blob:<sha256>` — so the
/// staging directory is the document's footage bundle and a later bundle save
/// collects from it like any other. STORE entries only (what Premation writes);
/// a compressed entry, a bad CRC or a zip that is not a project is
/// EngineFail(io). The page instead minted session object URLs, which the
/// engine cannot read.
[[nodiscard]] PortableOpen read_portable(const std::filesystem::path& file, const std::filesystem::path& staging);

/// A Premation motion-graphics template package (`.mogrt` / `.mogrt.zip`, exportMogrt.ts).
[[nodiscard]] bool is_mogrt_path(std::string_view path);
/// exportMogrt.ts `exportMogrtZip` read back: the zip's `package.json`
/// (`format: "premation-mogrt-v1"`) and the editor document it carries — what
/// importProject brings in as a folder, like a `.motion`. EngineFail(io) for
/// an unreadable file, a zip without the package, or another format.
[[nodiscard]] js::Json read_mogrt(const std::filesystem::path& file);

}  // namespace premation::doc
