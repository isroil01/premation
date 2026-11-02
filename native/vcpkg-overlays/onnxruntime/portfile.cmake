# https://github.com/microsoft/onnxruntime/blob/v1.22.1/tools/python/util/vcpkg_helpers.py
message(WARNING "The port requires 'onnx' port build with CMake option ONNX_DISABLE_STATIC_REGISTRATION=ON")
if(VCPKG_TARGET_IS_OSX OR VCPKG_TARGET_IS_IOS)
    if("framework" IN_LIST FEATURES)
        # The Objective-C API requires onnxruntime_BUILD_SHARED_LIB
        vcpkg_check_linkage(ONLY_DYNAMIC_LIBRARY)
    endif()
endif()

vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO microsoft/onnxruntime
    REF "v${VERSION}"
    SHA512 373c51575ada457b8aead5d195a5f3eba62fb747b6370a2a9889fff875c40ea30af8fd49104d58cc86f79247410e829086b0979f37ca8635c6dd34960e9cc424
    PATCHES
        fix-cmake.patch # .framework install, external library workarounds(abseil-cpp, eigen3)
        fix-cmake-cuda.patch
        fix-missing-cstdint.patch
        fix-cmake-mlas.patch
)

find_program(PROTOC NAMES protoc PATHS "${CURRENT_HOST_INSTALLED_DIR}/tools/protobuf" REQUIRED NO_DEFAULT_PATH NO_CMAKE_PATH)
message(STATUS "Using protoc: ${PROTOC}")

find_program(FLATC NAMES flatc PATHS "${CURRENT_HOST_INSTALLED_DIR}/tools/flatbuffers" REQUIRED NO_DEFAULT_PATH NO_CMAKE_PATH)
message(STATUS "Using flatc: ${FLATC}")

vcpkg_find_acquire_program(PYTHON3)
get_filename_component(PYTHON_PATH "${PYTHON3}" PATH)
message(STATUS "Using python3: ${PYTHON3}")

vcpkg_execute_required_process(
    COMMAND "${PYTHON3}" onnxruntime/core/flatbuffers/schema/compile_schema.py --flatc "${FLATC}"
    LOGNAME compile_schema_core
    WORKING_DIRECTORY "${SOURCE_PATH}"
)
vcpkg_execute_required_process(
    COMMAND "${PYTHON3}" onnxruntime/lora/adapter_format/compile_schema.py --flatc "${FLATC}"
    LOGNAME compile_schema_lora
    WORKING_DIRECTORY "${SOURCE_PATH}"
)

vcpkg_check_features(OUT_FEATURE_OPTIONS FEATURE_OPTIONS
    FEATURES
        python    onnxruntime_ENABLE_PYTHON
        training  onnxruntime_ENABLE_TRAINING
        training  onnxruntime_ENABLE_TRAINING_APIS
        cuda      onnxruntime_USE_CUDA
        cuda      onnxruntime_USE_CUDA_NHWC_OPS
        openvino  onnxruntime_USE_OPENVINO
        tensorrt  onnxruntime_USE_TENSORRT
        tensorrt  onnxruntime_USE_TENSORRT_BUILTIN_PARSER
        directml  onnxruntime_USE_DML
        directml  onnxruntime_USE_CUSTOM_DIRECTML
        winml     onnxruntime_USE_WINML
        coreml    onnxruntime_USE_COREML
        mimalloc  onnxruntime_USE_MIMALLOC
        valgrind  onnxruntime_USE_VALGRIND
        xnnpack   onnxruntime_USE_XNNPACK
        kleidiai  onnxruntime_USE_KLEIDIAI
        nnapi     onnxruntime_USE_NNAPI_BUILTIN
        azure     onnxruntime_USE_AZURE
        test      onnxruntime_BUILD_UNIT_TESTS
        test      onnxruntime_BUILD_BENCHMARKS
        test      onnxruntime_RUN_ONNX_TESTS
        framework onnxruntime_BUILD_APPLE_FRAMEWORK
        framework onnxruntime_BUILD_OBJC
        nccl      onnxruntime_USE_NCCL
    INVERTED_FEATURES
        cuda      onnxruntime_USE_MEMORY_EFFICIENT_ATTENTION
)

# Premation overlay (native/vcpkg-overlays/README.md): the builtin port maps the
# directml / coreml features to their CMake options but does not declare them,
# and ORT fetches their SDKs itself (nuget.exe / FetchContent), which a vcpkg
# build cannot do. Both are pinned here and handed to ORT's "custom" inputs.
set(PREMATION_EP_OPTIONS_RELEASE "")
set(PREMATION_EP_OPTIONS_DEBUG "")
if("directml" IN_LIST FEATURES)
    # Microsoft.AI.DirectML 1.15.4 = the version ORT 1.23 pins (cmake/external/dml.cmake).
    vcpkg_download_distfile(DML_NUPKG
        URLS "https://api.nuget.org/v3-flatcontainer/microsoft.ai.directml/1.15.4/microsoft.ai.directml.1.15.4.nupkg"
        FILENAME "microsoft.ai.directml.1.15.4.zip"
        SHA512 fde767f56904abc90fd53f65d8729c918ab7f6e3c5e1ecdd479908fc02b4535cf2b0860f7ab2acb9b731d6cb809b72c3d5d4d02853fb8f5ea022a47bc44ef285
    )
    vcpkg_extract_source_archive(DML_PATH ARCHIVE "${DML_NUPKG}" NO_REMOVE_ONE_LEVEL)
    if(VCPKG_TARGET_ARCHITECTURE STREQUAL "arm64")
        set(dml_arch "arm64-win")
    else()
        set(dml_arch "x64-win")
    endif()
    file(INSTALL "${DML_PATH}/include/DirectML.h" "${DML_PATH}/include/DirectMLConfig.h"
        DESTINATION "${CURRENT_PACKAGES_DIR}/include/onnxruntime")
    # The import library goes where ORT's exported static targets will look for it
    # (DirectML.dll is installed at the end, after the static build's bin/ cleanup).
    file(INSTALL "${DML_PATH}/bin/${dml_arch}/DirectML.lib" DESTINATION "${CURRENT_PACKAGES_DIR}/lib")
    file(INSTALL "${DML_PATH}/bin/${dml_arch}/DirectML.lib" DESTINATION "${CURRENT_PACKAGES_DIR}/debug/lib")
    file(INSTALL "${DML_PATH}/LICENSE.txt" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}" RENAME "DirectML-LICENSE.txt")
    file(INSTALL "${DML_PATH}/ThirdPartyNotices.txt" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}" RENAME "DirectML-ThirdPartyNotices.txt")
    if(VCPKG_LIBRARY_LINKAGE STREQUAL "static")
        set(VCPKG_POLICY_DLLS_IN_STATIC_LIBRARY enabled)
    endif()
    # The DML provider ships headers pre-generated by flatc 23.5.26 (no .fbs to
    # regenerate) with a static_assert on that exact version; the vcpkg
    # flatbuffers is newer and reads that generated code unchanged, so the
    # guard goes (the core schemas are regenerated with this flatc above).
    foreach(gen DmlGraphDesc_generated.h OperatorFieldTypes_generated.h)
        set(gen_path "${SOURCE_PATH}/onnxruntime/core/providers/dml/DmlExecutionProvider/src/External/DirectMLHelpers/${gen}")
        file(READ "${gen_path}" gen_text)
        string(REGEX REPLACE "static_assert\\(FLATBUFFERS_VERSION_MAJOR == 23 &&[^;]*;" "" gen_text "${gen_text}")
        file(WRITE "${gen_path}" "${gen_text}")
    endforeach()
    # Delay-load flags are link options on the onnxruntime target, which a static
    # build makes an INTERFACE library (CMake refuses PRIVATE options there); the
    # consumer delay-loads DirectML.dll itself.
    set(PREMATION_EP_OPTIONS_RELEASE "-Ddml_INCLUDE_DIR=${DML_PATH}/include" "-Ddml_LIB_DIR=${CURRENT_PACKAGES_DIR}/lib")
    set(PREMATION_EP_OPTIONS_DEBUG "-Ddml_INCLUDE_DIR=${DML_PATH}/include" "-Ddml_LIB_DIR=${CURRENT_PACKAGES_DIR}/debug/lib")
    if(VCPKG_LIBRARY_LINKAGE STREQUAL "static")
        list(APPEND PREMATION_EP_OPTIONS_RELEASE "-Donnxruntime_ENABLE_DELAY_LOADING_WIN_DLLS=OFF")
        list(APPEND PREMATION_EP_OPTIONS_DEBUG "-Donnxruntime_ENABLE_DELAY_LOADING_WIN_DLLS=OFF")
    endif()
endif()

if("coreml" IN_LIST FEATURES)
    # The SHA-1s ORT 1.23.2 pins in cmake/deps.txt, fetched here instead of by FetchContent.
    vcpkg_download_distfile(PSIMD_ZIP
        URLS "https://github.com/Maratyszcza/psimd/archive/072586a71b55b7f8c584153d223e95687148a900.zip"
        FILENAME "psimd-072586a71b55b7f8c584153d223e95687148a900.zip"
        SHA512 98c9e13f1e79db84289f48f1e1699852a54d3a7f1b07144008c67cf73c8b4487e9647755f6fe2a2d519419d669248b37a85d8aa3f6ad2f8fdf8e97d2de7ed7c4
    )
    vcpkg_download_distfile(FP16_ZIP
        URLS "https://github.com/Maratyszcza/FP16/archive/0a92994d729ff76a58f692d3028ca1b64b145d91.zip"
        FILENAME "fp16-0a92994d729ff76a58f692d3028ca1b64b145d91.zip"
        SHA512 f7f61c40e13128068f1ee10e6273ed2ebe626a89b3eebbe8d479ae7ab346119404ea0c2a7caa80ea441d80b8ca9c5bd8acffb79fb3499c38f50bb52ebe441efe
    )
    vcpkg_download_distfile(COREMLTOOLS_ZIP
        URLS "https://github.com/apple/coremltools/archive/refs/tags/7.1.zip"
        FILENAME "coremltools-7.1.zip"
        SHA512 c6645d0b48953fe4a7f3ffa34df35c40ddc764e76b9aa8ec1af282842f8346129df650514cb5bc6dde52ecb75750aac4ad159e5cfa6384146cfa72c75af77399
    )
    vcpkg_extract_source_archive(PSIMD_PATH ARCHIVE "${PSIMD_ZIP}")
    vcpkg_extract_source_archive(FP16_PATH ARCHIVE "${FP16_ZIP}")
    vcpkg_extract_source_archive(COREMLTOOLS_PATH ARCHIVE "${COREMLTOOLS_ZIP}"
        PATCHES "${SOURCE_PATH}/cmake/patches/coremltools/crossplatformbuild.patch")
    list(APPEND PREMATION_EP_OPTIONS_RELEASE
        "-DFETCHCONTENT_SOURCE_DIR_PSIMD=${PSIMD_PATH}"
        "-DFETCHCONTENT_SOURCE_DIR_FP16=${FP16_PATH}"
        "-DFETCHCONTENT_SOURCE_DIR_COREMLTOOLS=${COREMLTOOLS_PATH}")
    list(APPEND PREMATION_EP_OPTIONS_DEBUG
        "-DFETCHCONTENT_SOURCE_DIR_PSIMD=${PSIMD_PATH}"
        "-DFETCHCONTENT_SOURCE_DIR_FP16=${FP16_PATH}"
        "-DFETCHCONTENT_SOURCE_DIR_COREMLTOOLS=${COREMLTOOLS_PATH}")
    # A static build exports onnxruntime and onnxruntime_providers_coreml, which link
    # coreml_proto; upstream installs coreml_proto in a static build but outside the
    # export set, so CMake refuses to generate ("requires target coreml_proto that is
    # not in any export set"). Put that install into the same export set.
    set(coreml_cmake "${SOURCE_PATH}/cmake/onnxruntime_providers_coreml.cmake")
    file(READ "${coreml_cmake}" coreml_text)
    string(REGEX REPLACE "install\\(TARGETS coreml_proto[ \t\r\n]" "install(TARGETS coreml_proto EXPORT \${PROJECT_NAME}Targets\n" coreml_patched "${coreml_text}")
    if(coreml_patched STREQUAL coreml_text AND NOT coreml_text MATCHES "coreml_proto EXPORT")
        message(FATAL_ERROR "onnxruntime_providers_coreml.cmake changed: coreml_proto's install was not found")
    endif()
    file(WRITE "${coreml_cmake}" "${coreml_patched}")
endif()

if("cuda" IN_LIST FEATURES)
    vcpkg_find_cuda(OUT_CUDA_TOOLKIT_ROOT cuda_toolkit_root)
    list(APPEND FEATURE_OPTIONS
        "-DCMAKE_CUDA_COMPILER=${NVCC}"
        "-DCUDAToolkit_ROOT=${cuda_toolkit_root}"
        # "-DCMAKE_CUDA_ARCHITECTURES=native"
        # too much warnings about attribute
        "-DCMAKE_CUDA_FLAGS=-Xcudafe --diag_suppress=2803 -Wno-deprecated-gpu-targets"
    )
endif()

if("tensorrt" IN_LIST FEATURES)
    if(DEFINED ENV{TENSORRT_HOME})
        set(TENSORRT_HOME "$ENV{TENSORRT_HOME}")
    endif()
    if(DEFINED TENSORRT_HOME)
        message(STATUS "Using TensorRT: ${TENSORRT_HOME}")
        list(APPEND FEATURE_OPTIONS "-Donnxruntime_TENSORRT_HOME:PATH=${TENSORRT_HOME}")
    else()
        message(WARNING "Define TENSORRT_HOME for onnxruntime_TENSORRT_HOME")
    endif()
endif()

string(COMPARE EQUAL "${VCPKG_LIBRARY_LINKAGE}" "dynamic" BUILD_SHARED)

# see tools/ci_build/build.py
vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}/cmake"
    OPTIONS
        ${FEATURE_OPTIONS}
        "-DPython_EXECUTABLE:FILEPATH=${PYTHON3}"
        "-DProtobuf_PROTOC_EXECUTABLE:FILEPATH=${PROTOC}"
        "-DONNX_CUSTOM_PROTOC_EXECUTABLE:FILEPATH=${PROTOC}"
        -DBUILD_PKGCONFIG_FILES=ON
        -Donnxruntime_BUILD_SHARED_LIB=${BUILD_SHARED}
        -Donnxruntime_CROSS_COMPILING=${VCPKG_CROSSCOMPILING}
        -Donnxruntime_USE_EXTENSIONS=OFF
        -Donnxruntime_USE_NNAPI_BUILTIN=${VCPKG_TARGET_IS_ANDROID}
        -Donnxruntime_USE_VCPKG=ON
        -Donnxruntime_ENABLE_CPUINFO=ON
        -Donnxruntime_ENABLE_MICROSOFT_INTERNAL=OFF
        -Donnxruntime_ENABLE_BITCODE=OFF
        -Donnxruntime_ENABLE_PYTHON=OFF
        -Donnxruntime_ENABLE_EXTERNAL_CUSTOM_OP_SCHEMAS=OFF
        -Donnxruntime_ENABLE_MEMORY_PROFILE=OFF
        -Donnxruntime_ENABLE_LAZY_TENSOR=OFF
        -Donnxruntime_DISABLE_RTTI=OFF
        -Donnxruntime_DISABLE_ABSEIL=OFF
        # some other customizations ...
        --compile-no-warning-as-error
    OPTIONS_RELEASE
        ${PREMATION_EP_OPTIONS_RELEASE}
    OPTIONS_DEBUG
        ${PREMATION_EP_OPTIONS_DEBUG}
        -Donnxruntime_ENABLE_MEMLEAK_CHECKER=OFF
        -Donnxruntime_DEBUG_NODE_INPUTS_OUTPUTS=1
    MAYBE_UNUSED_VARIABLES
        Python_EXECUTABLE
        onnxruntime_TENSORRT_PLACEHOLDER_BUILDER
        onnxruntime_NVCC_THREADS
        CMAKE_CUDA_FLAGS
        onnxruntime_USE_CUSTOM_DIRECTML
        dml_INCLUDE_DIR
        dml_LIB_DIR
        FETCHCONTENT_SOURCE_DIR_PSIMD
        FETCHCONTENT_SOURCE_DIR_FP16
        FETCHCONTENT_SOURCE_DIR_COREMLTOOLS
)
if("cuda" IN_LIST FEATURES)
    vcpkg_cmake_build(TARGET onnxruntime_providers_cuda LOGFILE_BASE build-cuda)
endif()
if("tensorrt" IN_LIST FEATURES)
    vcpkg_cmake_build(TARGET onnxruntime_providers_tensorrt LOGFILE_BASE build-tensorrt)
endif()
vcpkg_cmake_install()
vcpkg_cmake_config_fixup(CONFIG_PATH lib/cmake/onnxruntime)
vcpkg_fixup_pkgconfig() # pkg_check_modules(libonnxruntime)

# relocates the onnxruntime_providers_* binaries before vcpkg_copy_pdbs()
function(reolocate_ort_providers)
    if(VCPKG_TARGET_IS_WINDOWS AND (VCPKG_LIBRARY_LINKAGE STREQUAL "dynamic"))
        # the target is expected to be used without the .lib files
        file(GLOB PROVIDE_BINS_DBG  "${CURRENT_PACKAGES_DIR}/debug/lib/onnxruntime_providers_*.dll")
        file(COPY ${PROVIDE_BINS_DBG} DESTINATION "${CURRENT_PACKAGES_DIR}/debug/bin")
        file(GLOB PROVIDE_BINS_REL "${CURRENT_PACKAGES_DIR}/lib/onnxruntime_providers_*.dll")
        file(COPY ${PROVIDE_BINS_REL} DESTINATION "${CURRENT_PACKAGES_DIR}/bin")
        file(REMOVE ${PROVIDE_BINS_DBG} ${PROVIDE_BINS_REL})
    endif()
endfunction()

reolocate_ort_providers()
vcpkg_copy_pdbs()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
if(VCPKG_LIBRARY_LINKAGE STREQUAL "static")
    file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/bin" "${CURRENT_PACKAGES_DIR}/bin")
endif()
if("directml" IN_LIST FEATURES)
    # Premation overlay: DirectML.dll in bin/: a static ORT links DirectML.lib,
    # so the DLL is the one runtime file the consumer stages beside its executable.
    file(INSTALL "${DML_PATH}/bin/${dml_arch}/DirectML.dll" DESTINATION "${CURRENT_PACKAGES_DIR}/bin")
    file(INSTALL "${DML_PATH}/bin/${dml_arch}/DirectML.dll" DESTINATION "${CURRENT_PACKAGES_DIR}/debug/bin")
endif()

vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
