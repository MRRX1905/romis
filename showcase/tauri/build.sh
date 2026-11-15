#!/bin/bash
# Syncs the shared web files into dist/, then bundles with the Tauri CLI.
# ./build.sh        release bundle (Roamies.app on macOS, the installer on Windows, .AppImage/.deb/.rpm on Linux)
# ./build.sh dev    debug binary only, faster
set -euo pipefail
cd "$(dirname "$0")"
# The speech model's engine (whisper.cpp) is built from source: CMake configures it and bindgen reads its headers. Both
# ship with the C++ build tools but not on PATH, so point the build at them when they aren't already.
for d in "/c/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin" \
         "/c/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/Common7/IDE/CommonExtensions/Microsoft/CMake/Ninja" \
         "/c/Program Files/LLVM/bin" "/usr/lib/llvm/bin"; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH
[ -d "/c/Program Files/LLVM/bin" ] && [ -z "${LIBCLANG_PATH:-}" ] && export LIBCLANG_PATH="C:\\Program Files\\LLVM\\bin"
# whisper.cpp's CMake scratch paths get long enough to beat Windows' 260-character limit, so its build runs in a short
# directory of its own.
HELPERS_TARGET="${CARGO_TARGET_DIR:-${TEMP:-/tmp}/roamies-helpers}"
# ggml (inside whisper.cpp) leaves its SIMD kernels off under MSVC unless told: see the file for why that matters.
[ -z "${CMAKE_PROJECT_INCLUDE:-}" ] && export CMAKE_PROJECT_INCLUDE="$PWD/voice-win/cmake/fast-simd.cmake"
rm -rf dist && mkdir -p dist
cp ../desktop.html dist/
cp -R ../roamies ../onboarding ../panel dist/
../tauri/sidecar/bundle.sh
# Ship a Node.js runtime with the app, for the target being built (--target <triple>, else this machine).
TARGET=""; prev=""; for a in "$@"; do [ "$prev" = "--target" ] && TARGET="$a"; prev="$a"; done
../tauri/sidecar/fetch-node.sh ${TARGET:+"$TARGET"}
# Windows helpers: voice (Whisper speech on the PC) and hands (windows, capture, UI Automation, OCR); macOS
# builds its Swift twins in build.rs. Linux has the voice helper only (the same Rust one as Windows).
# Always optimised: a debug voice build is far too slow at reading speech.
TRIPLE="${TARGET:-$(rustc -vV | sed -n 's/^host: //p')}"
case "$TRIPLE" in
  *-windows-*)
    mkdir -p src-tauri/binaries
    for h in voice hands; do
      CARGO_TARGET_DIR="$HELPERS_TARGET" cargo build --release --locked --manifest-path "src-tauri/$h-win/Cargo.toml" --target "$TRIPLE"
      cp "$HELPERS_TARGET/$TRIPLE/release/roamies-$h.exe" "src-tauri/binaries/roamies-$h-$TRIPLE.exe"
    done ;;
  *-linux-*)
    mkdir -p src-tauri/binaries
    CARGO_TARGET_DIR="$HELPERS_TARGET" cargo build --release --locked --manifest-path src-tauri/voice-win/Cargo.toml --target "$TRIPLE"
    cp "$HELPERS_TARGET/$TRIPLE/release/roamies-voice" "src-tauri/binaries/roamies-voice-$TRIPLE" ;;
esac
cd src-tauri
# macOS signing: APPLE_SIGNING_IDENTITY if set, else the first Developer ID Application certificate in
# the keychain, else ad-hoc. A stable identity keeps macOS permissions across rebuilds.
if [ "$(uname)" = "Darwin" ] && [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  APPLE_SIGNING_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)"
  export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:--}"
fi
# ./build.sh release --target <triple> builds for one target (used by the release workflow).
MODE="${1:-}"; [ $# -gt 0 ] && shift
if [ "$MODE" = "dev" ]; then
  cargo build
  # Cargo copies the bundled resources (the sidecar among them) once, when the build script runs. Copy the fresh sidecar
  # next to the binary now, or a dev build keeps serving the JS from the last time that script happened to run.
  OUT="target/debug"
  if [ -n "${CARGO_TARGET_DIR:-}" ]; then OUT="$CARGO_TARGET_DIR/debug"; fi
  if [ -d "$OUT/sidecar" ]; then rm -rf "$OUT/sidecar"; fi
  cp -R ../sidecar/dist "$OUT/sidecar"
  echo "sidecar synced to $OUT/sidecar"
else cargo tauri build ${TAURI_BUNDLES:+--bundles $TAURI_BUNDLES} "$@"; fi
