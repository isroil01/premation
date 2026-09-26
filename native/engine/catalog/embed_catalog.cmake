# Embed the property/effect catalog into the engine (Phase 1 of
# docs/TS_ENGINE_REMOVAL.md: the C++ build reads no TypeScript).
#
#   native/engine/catalog/<part>.json         C++-owned catalog data, one file per
#                                             top-level part (effects, staticMeta,
#                                             layerStyles, ...) — edit these
#   native/protocol/generated/commands.json   the schema's command classes, written
#                                             by `npm run engine-api:gen`
#
# premation_embed_catalog(<out_dir>) writes <out_dir>/catalog_data.inc at
# configure time: the parts composed into ONE JSON object
# `{"<part>": <file>, ...}`, as raw-string chunks that
# core/catalog_data.cpp concatenates and parses (kCatalogJsonChunks). The same
# files feed packages/engine-api/src/generated/catalog.ts for the UI.
#
# Every input is a configure dependency; the output is rewritten only when its
# bytes change.

set(_PREMATION_CATALOG_DIR "${CMAKE_CURRENT_LIST_DIR}")

# The top-level parts, in the order the catalog has always listed them.
set(_PREMATION_CATALOG_PARTS
  effects staticMeta layerStyles pathOps pathOpParams polystar animators paint
  strokeTracks latent fields maskKeys textPathParams labels commands blendModes
  presets factory)

# Raw-string chunks of about this many bytes: well under every compiler's
# string-literal limit (MSVC's is the tightest).
set(_PREMATION_CATALOG_CHUNK 12000)

function(premation_embed_catalog out_dir)
  set(commands "${_PREMATION_CATALOG_DIR}/../../protocol/generated/commands.json")
  cmake_path(NORMAL_PATH commands)
  set(inputs "${_PREMATION_CATALOG_DIR}/embed_catalog.cmake")

  set(json "{")
  set(first TRUE)
  foreach(part IN LISTS _PREMATION_CATALOG_PARTS)
    if(part STREQUAL "commands")
      set(src "${commands}")
    else()
      set(src "${_PREMATION_CATALOG_DIR}/${part}.json")
    endif()
    if(NOT EXISTS "${src}")
      message(FATAL_ERROR "embed_catalog: ${src} does not exist")
    endif()
    list(APPEND inputs "${src}")
    file(READ "${src}" text)
    string(STRIP "${text}" text)
    # Fail at configure time, not at engine start-up, on a malformed part.
    string(JSON type ERROR_VARIABLE bad TYPE "${text}")
    if(bad)
      message(FATAL_ERROR "embed_catalog: ${src} is not valid JSON: ${bad}")
    endif()
    if(NOT first)
      string(APPEND json ",")
    endif()
    set(first FALSE)
    string(APPEND json "\"${part}\":${text}")
  endforeach()
  string(APPEND json "}")

  # A part file nobody lists would silently not be embedded.
  file(GLOB on_disk RELATIVE "${_PREMATION_CATALOG_DIR}" "${_PREMATION_CATALOG_DIR}/*.json")
  foreach(f IN LISTS on_disk)
    string(REGEX REPLACE "\\.json$" "" stem "${f}")
    if(stem STREQUAL "commands" OR NOT "${stem}" IN_LIST _PREMATION_CATALOG_PARTS)
      message(FATAL_ERROR "embed_catalog: catalog/${f} is not a catalog part (see _PREMATION_CATALOG_PARTS)")
    endif()
  endforeach()

  string(FIND "${json}" ")PMCAT\"" clash)
  if(NOT clash EQUAL -1)
    message(FATAL_ERROR "embed_catalog: the catalog contains the raw-string delimiter )PMCAT\"")
  endif()

  # Cut on character boundaries only: a chunk never ends inside a UTF-8 sequence.
  string(LENGTH "${json}" total)
  set(body "")
  set(count 0)
  set(pos 0)
  while(pos LESS total)
    math(EXPR cut "${pos} + ${_PREMATION_CATALOG_CHUNK}")
    if(cut GREATER_EQUAL total)
      set(cut ${total})
    else()
      while(cut LESS total)
        string(SUBSTRING "${json}" ${cut} 1 next)
        string(HEX "${next}" next_hex)
        if(NOT next_hex MATCHES "^[89ab]")
          break()
        endif()
        math(EXPR cut "${cut} + 1")
      endwhile()
    endif()
    math(EXPR len "${cut} - ${pos}")
    string(SUBSTRING "${json}" ${pos} ${len} chunk)
    if(count GREATER 0)
      string(APPEND body ",\n")
    endif()
    string(APPEND body "R\"PMCAT(${chunk})PMCAT\"")
    math(EXPR count "${count} + 1")
    set(pos ${cut})
  endwhile()

  set(out "// GENERATED from native/engine/catalog/*.json and native/protocol/generated/commands.json\n")
  string(APPEND out "// by native/engine/catalog/embed_catalog.cmake at configure time. Do not edit.\n")
  string(APPEND out "// ${total} bytes of JSON in ${count} chunks.\n")
  string(APPEND out "static const char* const kCatalogJsonChunks[] = {\n${body}\n};\n")

  if(NOT CMAKE_SCRIPT_MODE_FILE)
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${inputs})
  endif()
  file(MAKE_DIRECTORY "${out_dir}")
  set(path "${out_dir}/catalog_data.inc")
  if(EXISTS "${path}")
    file(READ "${path}" old)
    if(old STREQUAL out)
      return()
    endif()
  endif()
  file(WRITE "${path}" "${out}")
endfunction()

# `cmake -DOUT=<dir> -P embed_catalog.cmake` runs the generator on its own.
if(CMAKE_SCRIPT_MODE_FILE STREQUAL CMAKE_CURRENT_LIST_FILE)
  if(NOT DEFINED OUT)
    message(FATAL_ERROR "usage: cmake -DOUT=<dir> -P embed_catalog.cmake")
  endif()
  premation_embed_catalog("${OUT}")
endif()
