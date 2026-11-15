# Included by whisper.cpp's CMake build (through CMAKE_PROJECT_INCLUDE) before its ggml subproject is configured.
#
# ggml picks its SIMD kernels with a compile test that fails under MSVC, so it quietly builds scalar code: on a normal
# laptop that is roughly twenty times slower, which turns a two-second voice command into a minute of waiting. Every
# x64 CPU that runs Windows 11 has AVX2, and ggml still checks CPUID at startup, so asking for these is safe.
if (MSVC AND CMAKE_SIZEOF_VOID_P EQUAL 8)
  set(GGML_AVX ON CACHE BOOL "" FORCE)
  set(GGML_AVX2 ON CACHE BOOL "" FORCE)
  set(GGML_FMA ON CACHE BOOL "" FORCE)
  set(GGML_F16C ON CACHE BOOL "" FORCE)
  set(GGML_SSE42 ON CACHE BOOL "" FORCE)
  add_compile_options(/arch:AVX2)
endif()
