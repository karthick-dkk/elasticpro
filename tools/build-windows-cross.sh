#!/usr/bin/env bash
# Cross-compile the Windows portable build without any Microsoft toolchain:
# target x86_64-pc-windows-gnu, linker mingw-w64, std built from source (-Zbuild-std)
# so no rust-std download is needed and a plain distro/brew rustc is enough.
#
# Works on Linux (apt) and macOS (brew). Idempotent: every step checks first.
#
#   tools/build-windows-cross.sh              # -> dist/ElasticPro-<ver>-portable-win64.zip
#   tools/build-windows-cross.sh --install    # …and drop the exe at the repo root as well
#
# The exe carries its version in the name (elasticpro-<ver>.exe), so which build a
# machine is running is answerable by looking at it. --install is a local convenience only:
# the root exe, its DLL and SHA256SUMS.txt are gitignored and are never committed. The
# packages people install come from the GitHub release the tag build publishes.
#
# Result: dist/ElasticPro-portable-win64/ (exe + WebView2Loader.dll + example YAML + README)
set -euo pipefail
cd "$(dirname "$0")/.."

INSTALL=0
[ "${1:-}" = "--install" ] && INSTALL=1

have() { command -v "$1" >/dev/null 2>&1; }
have cargo || { echo "install rust first (rustup, or 'brew install rust')"; exit 1; }

# ---------------------------------------------------------------- 1. mingw-w64
# Debian ships -posix suffixed drivers (the plain ones use the win32 threading
# model, which std needs to not be); brew ships only the unsuffixed ones.
pick() { for c in "$@"; do have "$c" && { echo "$c"; return; }; done; return 1; }

if ! CC_WIN=$(pick x86_64-w64-mingw32-gcc-posix x86_64-w64-mingw32-gcc); then
  case "$(uname -s)" in
    Linux)  sudo apt-get install -y gcc-mingw-w64-x86-64-posix g++-mingw-w64-x86-64-posix binutils-mingw-w64-x86-64 ;;
    Darwin) have brew || { echo "install Homebrew, then: brew install mingw-w64"; exit 1; }
            brew install mingw-w64 ;;
    *)      echo "install a mingw-w64 cross toolchain providing x86_64-w64-mingw32-gcc"; exit 1 ;;
  esac
  CC_WIN=$(pick x86_64-w64-mingw32-gcc-posix x86_64-w64-mingw32-gcc)
fi
CXX_WIN=$(pick x86_64-w64-mingw32-g++-posix x86_64-w64-mingw32-g++)
AR_WIN=$(pick x86_64-w64-mingw32-ar llvm-ar ar)
echo "mingw: $CC_WIN"

# ------------------------------------------- 2. std source at this rustc commit
COMMIT=$(rustc -vV | awk '/commit-hash/ {print $2}')
LIB="$(rustc --print sysroot)/lib/rustlib/src/rust/library"
if [ ! -f "$LIB/Cargo.lock" ]; then
  echo "fetching library/ at rustc commit $COMMIT"
  TMP=$(mktemp -d)
  git init -q "$TMP/rust-src" && (
    cd "$TMP/rust-src"
    git remote add origin https://github.com/rust-lang/rust.git
    git sparse-checkout init --cone && git sparse-checkout set library
    git fetch --depth 1 origin "$COMMIT" && git checkout -q FETCH_HEAD
    BT=$(git ls-tree FETCH_HEAD library/backtrace | awk '{print $3}')
    git init -q "$TMP/bt" && cd "$TMP/bt"
    git remote add origin https://github.com/rust-lang/backtrace-rs.git
    git fetch --depth 1 origin "$BT" && git checkout -q FETCH_HEAD && rm -rf .git
  )
  mkdir -p "$(dirname "$LIB")"
  rm -rf "$LIB" && cp -r "$TMP/rust-src/library" "$LIB"
  rm -rf "$LIB/backtrace" && cp -r "$TMP/bt" "$LIB/backtrace"
  rm -rf "$TMP"
fi

# ---------------------------------------------------------------------- 3. build
export CC_x86_64_pc_windows_gnu="$CC_WIN"
export CXX_x86_64_pc_windows_gnu="$CXX_WIN"
export AR_x86_64_pc_windows_gnu="$AR_WIN"
export RUSTC_BOOTSTRAP=1                       # -Zbuild-std on a stable rustc
cargo build --release -Zbuild-std=std,panic_abort,panic_unwind \
  --target x86_64-pc-windows-gnu -p elasticpro

# -------------------------------------------------------------------- 4. package
OUT=target/x86_64-pc-windows-gnu/release
LOADER=$(find "${CARGO_HOME:-$HOME/.cargo}/registry/src" -path '*webview2-com-sys-*/x64/WebView2Loader.dll' 2>/dev/null | head -1)
[ -n "$LOADER" ] || { echo "WebView2Loader.dll not found in the cargo registry"; exit 1; }
VER=$(grep -m1 '^version' Cargo.toml | sed 's/.*"\(.*\)".*/\1/')
EXE="elasticpro-${VER}.exe"
D=dist/ElasticPro-portable-win64
rm -rf "$D" && mkdir -p "$D/data" "$D/WebView2Runtime"
cp "$OUT/elasticpro.exe" "$D/$EXE"
cp "$LOADER" ui/clusters.example.yaml "$D/"
sed -e "s/elasticpro-<ver>\.exe/$EXE/g" -e "s/elasticpro\.exe/$EXE/g" \
    -e "s/^ElasticPro [0-9][0-9.]* -/ElasticPro $VER -/" \
    tools/PORTABLE-README.txt > "$D/README.txt"
: > "$D/portable"                              # marker: keep all data in .\data\
printf 'Unpack Microsoft WebView2 Fixed Version Runtime (x64) here - see ..\\README.txt. Not needed on Windows 10/11 or Server 2019+.\r\n' > "$D/WebView2Runtime/PUT-RUNTIME-HERE.txt"
printf 'created on first run\r\n' > "$D/data/README.txt"

sums() { if have sha256sum; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
( cd "$D" && sums "$EXE" WebView2Loader.dll > SHA256SUMS.txt )
( cd dist && rm -f "ElasticPro-${VER}-portable-win64.zip" \
  && zip -qr "ElasticPro-${VER}-portable-win64.zip" ElasticPro-portable-win64 )
echo "built dist/ElasticPro-${VER}-portable-win64.zip  ($EXE)"

# ------------------------------------- 5. drop a local copy at the repo root
# These three are gitignored. Earlier versions of this script archived the outgoing build
# into previous-releases/ because the root exe was committed; it is not any more, so an
# older build is fetched from its GitHub release instead of being kept in the tree.
if [ "$INSTALL" = "1" ]; then
  rm -f elasticpro-*.exe
  cp "$D/$EXE" "$D/WebView2Loader.dll" .
  sums "$EXE" WebView2Loader.dll > SHA256SUMS.txt
  echo "wrote $EXE + WebView2Loader.dll at the repo root (untracked):"
  cat SHA256SUMS.txt
fi
