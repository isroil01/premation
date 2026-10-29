# Premation overlay: PDFium as bblanchon/pdfium-binaries' prebuilt shared
# library (the builds most applications ship), pinned to one Chromium release
# and verified by SHA-512. A source build needs PDFium's Chromium build tree
# (gclient); this keeps the engine's dependency reproducible without it.
# Raise PDFIUM_RELEASE and the hashes together (download each asset, sha512sum).
set(PDFIUM_RELEASE "8100")

if(VCPKG_TARGET_IS_WINDOWS AND VCPKG_TARGET_ARCHITECTURE STREQUAL "x64")
  set(asset "pdfium-win-x64.tgz")
  set(sha512 "a32ae792ab648a5536fd9af15aaba1a8357e0c38554270777ca92d760b108b420895ee70aed6e83fdfe5051e53792d79c7fd9e0b565589c659aff623b1ae2d36")
elseif(VCPKG_TARGET_IS_OSX AND VCPKG_TARGET_ARCHITECTURE STREQUAL "arm64")
  set(asset "pdfium-mac-arm64.tgz")
  set(sha512 "5089067a662bd620380db2e489563ebf3d07c5a8f1ffadee06c5efeecbf6f2af30b1e716bf12e694c9e518f33dd5ac3a310ca2b4983ca0ea3cb1a8f24110c63f")
elseif(VCPKG_TARGET_IS_OSX AND VCPKG_TARGET_ARCHITECTURE STREQUAL "x64")
  set(asset "pdfium-mac-x64.tgz")
  set(sha512 "8ad1d3e0d3813882ccdb21616a69327e0627e077391b18fc6e6bf476b3a93d4b9d4b4de4075552529a7a3f7f814ca0d6d92db1e2818275b433433e48fc9ec16f")
else()
  message(FATAL_ERROR "pdfium: no prebuilt library for ${TARGET_TRIPLET}")
endif()

vcpkg_download_distfile(ARCHIVE
  URLS "https://github.com/bblanchon/pdfium-binaries/releases/download/chromium%2F${PDFIUM_RELEASE}/${asset}"
  FILENAME "pdfium-${PDFIUM_RELEASE}-${asset}"
  SHA512 "${sha512}"
)
vcpkg_extract_source_archive(SOURCE_PATH ARCHIVE "${ARCHIVE}" NO_REMOVE_ONE_LEVEL)

set(VCPKG_POLICY_DLLS_IN_STATIC_LIBRARY enabled)  # a shared library in every linkage
set(VCPKG_POLICY_SKIP_ARCHITECTURE_CHECK enabled)
set(VCPKG_POLICY_MISMATCHED_NUMBER_OF_BINARIES enabled)

file(INSTALL "${SOURCE_PATH}/include/" DESTINATION "${CURRENT_PACKAGES_DIR}/include/pdfium" PATTERN "*.orig" EXCLUDE)
if(VCPKG_TARGET_IS_WINDOWS)
  foreach(dir "" "debug/")
    file(INSTALL "${SOURCE_PATH}/bin/pdfium.dll" DESTINATION "${CURRENT_PACKAGES_DIR}/${dir}bin")
    file(INSTALL "${SOURCE_PATH}/lib/pdfium.dll.lib" DESTINATION "${CURRENT_PACKAGES_DIR}/${dir}lib")
  endforeach()
  set(PDFIUM_LOCATION "bin/pdfium.dll")
  set(PDFIUM_IMPLIB "lib/pdfium.dll.lib")
else()
  foreach(dir "" "debug/")
    file(INSTALL "${SOURCE_PATH}/lib/libpdfium.dylib" DESTINATION "${CURRENT_PACKAGES_DIR}/${dir}lib")
  endforeach()
  set(PDFIUM_LOCATION "lib/libpdfium.dylib")
  set(PDFIUM_IMPLIB "")
endif()

configure_file("${CMAKE_CURRENT_LIST_DIR}/pdfium-config.cmake.in" "${CURRENT_PACKAGES_DIR}/share/pdfium/pdfium-config.cmake" @ONLY)
file(COPY "${SOURCE_PATH}/licenses" DESTINATION "${CURRENT_PACKAGES_DIR}/share/pdfium")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
