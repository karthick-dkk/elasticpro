#!/usr/bin/env bash
#
# ElasticPro installer.
#
#   curl -fsSL https://raw.githubusercontent.com/karthick-dkk/elasticpro/main/tools/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/karthick-dkk/elasticpro/main/tools/install.sh | bash -s -- --portable
#   curl -fsSL https://raw.githubusercontent.com/karthick-dkk/elasticpro/main/tools/install.sh | bash -s -- --hosted
#
# Note the `-s --` before the flags. `curl … | bash --portable` would pass the flag to
# bash, not to this script, and bash would reject it.
#
# What this will not do is install something that cannot run. The desktop app is built for
# x86_64 Linux and x64 Windows only, and it is a windowed application — so on an arm64
# server, or a machine with no display, this stops and tells you what to do instead rather
# than leaving a package installed that will never open. --hosted is that alternative: the
# same product served over HTTPS, built from source, on whatever architecture you have.
set -euo pipefail

REPO="karthick-dkk/elasticpro"
API="https://api.github.com/repos/${REPO}"

# Where a Linux install goes, one directory per version — /opt/elasticpro_0.1.0.
# Versioned rather than a single /opt/elasticpro so two can sit side by side and a
# rollback is a path change rather than a reinstall. --dir overrides it.
LINUX_BASE=/opt
linux_dir() { printf '%s/elasticpro_%s' "$LINUX_BASE" "$1"; }

MODE=install          # install | portable | hosted
CACHE=0               # --cache: run Redis too (hosted)
LISTEN_PORT=""        # --listen: the host port nginx takes (hosted; default 443)
VERSION=""            # empty = the latest release
DEST=""
DRY=0
ASSUME_YES=0

# Everything goes to stderr. All of it is progress reporting rather than output anyone
# would pipe onward, and mixing the two streams inside `curl … | bash` reorders them —
# a warning surfacing three lines above its own explanation reads as a different bug.
say()  { printf '%s\n' "$*" >&2; }
info() { printf '  %s\n' "$*" >&2; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\033[36m→\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*" >&2; }

usage() {
  cat <<'EOF'
ElasticPro installer

  --portable        A self-contained copy in the current directory. Nothing is installed,
                    nothing is written outside it, and deleting the folder removes it.
                    Windows: the portable zip. Linux: the AppImage.
  --hosted          The Docker stack instead of the desktop app: nginx + the core, served
                    over HTTPS. Works on any architecture because it builds from source,
                    and needs no display — this is the option for a server.
  --listen PORT     Hosted: the port on this host (default 443). Use it when something
                    already has 443 — otherwise nginx cannot start and says the address
                    is already in use.
  --cache           Hosted: run Redis as well. The core keeps its fleet cache in memory
                    and on disk without it; Redis is worth adding from a few dozen
                    clusters, and is what a second core would share.
  --version vX.Y.Z  A specific release (default: the latest release; `main` for the branch).
  --dir PATH        Where a portable copy or a hosted checkout goes.
  --dry-run         Say what would happen; change nothing.
  -y, --yes         Do not ask before using sudo.
  -h, --help        This.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --portable) MODE=portable ;;
    --hosted)   MODE=hosted ;;
    --version)  VERSION="${2:-}"; shift ;;
    --version=*) VERSION="${1#*=}" ;;
    --dir)      DEST="${2:-}"; shift ;;
    --dir=*)    DEST="${1#*=}" ;;
    --cache)    CACHE=1 ;;
    --listen)   LISTEN_PORT="${2:-}"; shift ;;
    --listen=*) LISTEN_PORT="${1#*=}" ;;
    --dry-run)  DRY=1 ;;
    -y|--yes)   ASSUME_YES=1 ;;
    -h|--help)  usage; exit 0 ;;
    *) die "unknown option: $1  (try --help)" ;;
  esac
  shift
done

# Checked here rather than where it is used: a dry run never reaches the hosted section,
# and a typo should stop before anything is fetched.
if [ -n "$LISTEN_PORT" ]; then
  case "$LISTEN_PORT" in
    ''|*[!0-9]*) die "--listen wants a port number, not \"$LISTEN_PORT\"" ;;
  esac
  [ "$LISTEN_PORT" -ge 1 ] && [ "$LISTEN_PORT" -le 65535 ] || die "--listen $LISTEN_PORT is not a port"
  [ "$MODE" = hosted ] || die "--listen is for --hosted"
fi

need() { command -v "$1" >/dev/null 2>&1 || die "this needs $1, which is not installed"; }
need curl

# sudo, but only when it is actually needed, and never silently.
as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; return; fi
  command -v sudo >/dev/null 2>&1 || die "this needs root and sudo is not installed"

  # `curl … | bash` can leave sudo with no terminal to prompt on, and it then fails with
  # "a terminal is required" — true, and useless.
  #
  # Whether it can prompt is asked, not predicted: `sudo -v` prompts if it has anywhere
  # to prompt and fails if it does not. The first version of this inspected /dev/tty
  # instead, decided a non-interactive ssh session could prompt, skipped the guard, and
  # let the raw sudo error through — which is the whole thing it exists to prevent.
  if ! sudo -n true 2>/dev/null && ! sudo -v 2>/dev/null; then
    say ""
    warn "sudo needs a password and there is no terminal to ask on."
    info "That is what piping a script into bash costs. Any one of these works:"
    info "  • create the directory first, owned by you, and run this again:"
    info "      sudo mkdir -p ${DEST:-/opt/elasticpro_<version>} && sudo chown \$USER: \$_"
    info "  • put it somewhere you can already write:  --dir ~/elasticpro"
    info "  • download and run it in two steps, so sudo has a terminal:"
    info "      curl -fsSL <url> -o install.sh && bash install.sh --hosted"
    say ""
    die "nothing installed"
  fi

  if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
    printf '  About to run: sudo %s\n  Continue? [Y/n] ' "$*"
    read -r reply </dev/tty || reply=y
    case "$reply" in n|N|no) die "stopped at your request" ;; esac
  fi
  sudo "$@"
}

# Root if it is available without a fuss, false if not. For steps that improve the
# result but must not decide whether the install happens.
try_root() {
  if [ "$(id -u)" = 0 ]; then "$@" 2>/dev/null; return; fi
  command -v sudo >/dev/null 2>&1 || return 1
  sudo -n "$@" 2>/dev/null
}

# ------------------------------------------------------------------ what am I on

case "$(uname -s)" in
  Linux)                     OS=linux ;;
  Darwin)                    OS=macos ;;
  MINGW*|MSYS*|CYGWIN*)      OS=windows ;;
  *) die "unsupported operating system: $(uname -s)" ;;
esac

case "$(uname -m)" in
  x86_64|amd64)              ARCH=x64 ;;
  aarch64|arm64)             ARCH=arm64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

step "Detected ${OS}/${ARCH}"

# The one place that knows which combinations were actually built. Everything else asks
# here, so a new target is added once rather than in three branches.
supported() {
  case "$1/$2" in
    linux/x64|windows/x64|macos/x64|macos/arm64) return 0 ;;
    *) return 1 ;;
  esac
}

if [ "$MODE" != hosted ] && ! supported "$OS" "$ARCH"; then
  say ""
  warn "There is no ${OS}/${ARCH} build of the ElasticPro desktop app."
  say ""
  info "The release carries Linux x86_64 (.deb/.rpm/.AppImage), Windows x64 (.msi/.exe/zip)"
  info "and macOS on both architectures. ${OS}/${ARCH} is not among them."
  say ""
  info "Two ways forward:"
  info "  • --hosted   the same product over HTTPS, built from source on this machine."
  info "               Needs Docker. Works on any architecture, and needs no display."
  info "  • build it   git clone https://github.com/${REPO} && cargo tauri build"
  say ""
  die "nothing installed"
fi

# A windowed application on a machine with nowhere to draw is a package that will never
# open. Worth stopping for, because the symptom otherwise appears much later.
if [ "$OS" = linux ] && [ "$MODE" != hosted ]; then
  if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    say ""
    warn "No DISPLAY and no WAYLAND_DISPLAY — this machine has no graphical session."
    info "ElasticPro is a windowed application; installed here it would have nowhere"
    info "to open. If this is a server, --hosted serves the same product over HTTPS."
    say ""
    if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
      printf '  Install anyway? [y/N] '
      read -r reply </dev/tty || reply=n
      case "$reply" in y|Y|yes) ;; *) die "nothing installed" ;; esac
    else
      die "nothing installed (pass --yes to override, or use --hosted)"
    fi
  fi
fi

# ------------------------------------------------------------------ which release

resolve_release() {
  if [ -n "$VERSION" ]; then
    echo "${API}/releases/tags/${VERSION}"
  else
    echo "${API}/releases/latest"
  fi
}

# The hosted stack takes the latest release, like everything else here. It used to follow
# the default branch, from a time when deploy/ postdated the last tag and "latest release"
# fetched a tree with no deploy/ in it; every release has carried deploy/ for a long time,
# and "whatever was pushed an hour ago" is the wrong default for something people run in
# production. `--version main` still asks for the branch.
if [ "$MODE" = hosted ] && [ -z "$VERSION" ]; then
  REF=$(curl -fsSL "${API}/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)
  if [ -n "$REF" ]; then
    info "latest release: ${REF}"
  else
    REF=$(curl -fsSL "$API" | sed -n 's/.*"default_branch": *"\([^"]*\)".*/\1/p' | head -1)
    REF=${REF:-main}
    warn "no release found — tracking the ${REF} branch instead"
  fi
else
  step "Asking GitHub for the release"
  REL_JSON=$(curl -fsSL "$(resolve_release)") \
    || die "could not read the release list. Is ${VERSION:-the latest release} published?"
  TAG=$(printf '%s' "$REL_JSON" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$TAG" ] || die "the release has no tag — the API response was not what was expected"
  info "release ${TAG}"
  REF="$TAG"
fi

# The asset whose name matches a pattern, as a download URL.
asset_url() {
  printf '%s' "$REL_JSON" \
    | tr ',' '\n' \
    | grep '"browser_download_url"' \
    | sed -n 's/.*"browser_download_url": *"\([^"]*\)".*/\1/p' \
    | grep -E "$1" \
    | head -1
}

# ------------------------------------------------------------------ hosted

if [ "$MODE" = hosted ]; then
  need docker
  docker compose version >/dev/null 2>&1 || die "this needs the docker compose plugin"
  if [ -z "$DEST" ]; then
    if [ "$OS" = linux ]; then DEST=$(linux_dir "${REF#v}"); else DEST=./elasticpro; fi
  fi
  step "Hosted stack into ${DEST}"
  # Created as root because /opt is, then handed to the invoking user: trial-setup.sh
  # writes credentials into it and docker compose reads them, and neither should need
  # sudo once the directory exists.
  if [ ! -d "$DEST" ]; then
    parent=$(dirname "$DEST")
    if [ ! -w "$parent" ]; then
      as_root mkdir -p "$DEST"
      as_root chown "$(id -u):$(id -g)" "$DEST"
    else
      mkdir -p "$DEST"
    fi
  fi
  if [ "$DRY" -eq 1 ]; then ok "dry run — would fetch ${REF} and run docker compose up"; exit 0; fi

  if [ -f "$DEST/deploy/docker-compose.yml" ]; then
    info "using the checkout already at ${DEST}"
  else
    mkdir -p "$DEST"
    step "Downloading ${REF}"
    # A tag and a branch live at different paths, and only one of them exists.
    for kind in tags heads; do
      if curl -fsSL "https://github.com/${REPO}/archive/refs/${kind}/${REF}.tar.gz" \
           | tar -xz -C "$DEST" --strip-components=1 2>/dev/null; then
        GOT=1; break
      fi
    done
    [ "${GOT:-0}" = 1 ] || die "could not download ${REF} as either a tag or a branch"
  fi

  # Checked rather than assumed: deploy/ was added after the last stable tag, so an older
  # ref unpacks perfectly and simply has no stack in it. Without this the failure is a
  # bare "cd: no such file or directory" forty lines further down.
  [ -f "$DEST/deploy/docker-compose.yml" ] || die \
    "${REF} has no deploy/ directory — the hosted stack is newer than that ref. Try --version main."

  cd "$DEST/deploy"
  step "Generating a self-signed certificate and a starter config"
  ./trial-setup.sh

  # Anything compose needs on a later `docker compose up` has to be in .env, not just
  # exported here — the installer's environment dies with the installer.
  env_set() {
    if grep -q "^$1=" .env 2>/dev/null; then
      sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak
    else
      printf '%s=%s\n' "$1" "$2" >> .env
    fi
  }

  step "Letting the core write its own config"
  # The core runs as uid 999 and this directory belongs to whoever ran the installer, so
  # the first version of this chowned the directory to 999 — which needs root, and root
  # is what a piped install cannot ask for. On a host where sudo wants a password the
  # chown was skipped and "Add cluster" failed with a permission error on a deployment
  # that otherwise looked perfectly healthy.
  #
  # So nothing is chowned. The container is handed this user's group instead (group_add
  # in the compose file), and the directory is made setgid so that a file the core
  # replaces keeps that group rather than taking the writer's — which is what leaves it
  # readable and editable by a human after the app has saved over it. Both are things
  # the directory's own owner can do unaided.
  env_set ELASTICPRO_GID "$(id -g)"
  if chmod g+rwxs config 2>/dev/null; then
    chmod g+rw config/* 2>/dev/null || true
    ok "config/ is writable by the app and by you"
  else
    warn "could not make config/ group-writable."
    info "The stack will run, but \"Add cluster\" in the UI will fail on a permission"
    info "error until you run:"
    info "  chmod g+rwxs $DEST/deploy/config && chmod g+rw \$_/*"
  fi

  # Pull if there is something to pull. Compiling the core takes about twenty minutes on
  # a small arm64 server, and the published image is the same build — so the only reason
  # to compile is that no image exists for this architecture, which is worth saying out
  # loud rather than silently spending the twenty minutes.
  PUBLISHED=${ELASTICPRO_IMAGE:-}
  if [ -z "$PUBLISHED" ]; then
    candidate="karthickdk02/elasticpro-core:${REF#v}"
    step "Looking for a published image (${candidate})"
    if docker manifest inspect "$candidate" >/dev/null 2>&1; then
      PUBLISHED="$candidate"
      ok "Found it — pulling instead of compiling"
    else
      info "none published for ${REF#v} — building from source instead"
    fi
  fi

  if [ -n "$LISTEN_PORT" ]; then
    # In .env, where compose reads it: passing LISTEN= on one command works once, and the
    # next plain `docker compose up -d` goes back to 443 and fails to bind all over again.
    env_set LISTEN "$LISTEN_PORT"
    ok "nginx will take port $LISTEN_PORT on this host"
  fi

  if [ "$CACHE" = 1 ]; then
    # Redis refuses to start without this file, and compose would otherwise create
    # ./secrets/redis as root the moment it mounts it — leaving a directory this install
    # cannot write to and a Redis in a restart loop.
    mkdir -p secrets/redis
    if [ ! -s secrets/redis/redis_password ]; then
      # Hex, not base64: this goes into a redis:// URL and "/" would end the authority.
      (umask 027; openssl rand -hex 32 > secrets/redis/redis_password) \
        || die "could not write secrets/redis/redis_password"
      ok "Made secrets/redis/redis_password"
    else
      info "secrets/redis/redis_password is already there — keeping it"
    fi
    chmod 0640 secrets/redis/redis_password 2>/dev/null || true
    # In .env, not just on this command: a later `docker compose up -d` in this directory
    # would otherwise leave Redis behind and the core would fall back to memory and disk.
    env_set COMPOSE_PROFILES cache
    export COMPOSE_PROFILES=cache
    ok "Redis will run with the stack"
  fi

  if [ -n "$PUBLISHED" ]; then
    # .env as well as the environment: without this a later `docker compose up -d` on
    # this directory resolves the image to the default and spends twenty minutes
    # compiling a core that is already installed.
    export ELASTICPRO_IMAGE="$PUBLISHED"
    env_set ELASTICPRO_IMAGE "$PUBLISHED"
    step "Starting from ${PUBLISHED}"
    docker compose up -d --pull always
  else
    step "Building and starting — compiling the Rust core takes a while"
    docker compose up -d --build
  fi
  say ""
  ok "Hosted stack is up."
  # `hostname -I` lists every address the host has — on a machine running containers that
  # is a dozen docker bridges and link-local addresses, and the first one is as likely to
  # be 172.17.0.1 as the one anybody can reach. Show the routable ones and let the
  # operator pick, rather than confidently printing a URL that does not work.
  ADDRS=$(hostname -I 2>/dev/null | tr ' ' '\n' \
    | grep -E '^[0-9]+\.' \
    | grep -vE '^(127\.|169\.254\.|172\.1[6-9]\.|172\.2[0-9]\.|172\.3[01]\.)' \
    | tr '\n' ' ')
  if [ -n "${ADDRS// /}" ]; then
    # The port belongs in the URL whenever it is not 443: an install on 8443 that prints
    # a bare https:// URL sends the operator to whatever else answers on 443.
    PORT=$(grep -E '^LISTEN=' .env 2>/dev/null | tail -1 | cut -d= -f2)
    PORT=${LISTEN:-${PORT:-443}}
    SUFFIX=""; [ "$PORT" = 443 ] || SUFFIX=":$PORT"
    for a in $ADDRS; do info "Open  https://${a}${SUFFIX}/"; done
  else
    info "Open  https://<this host>/"
  fi
  info "The certificate is self-signed and lasts 30 days, so your browser will warn once"
  info "and it will expire — replace deploy/tls/ before anyone relies on this."
  # The first account is made here with a password of its own, rather than left for the
  # first visitor to name — whoever reached the page first would otherwise have become
  # the administrator.
  info "Sign in as  elasticpro  with the password from:"
  info "  docker compose exec core cat /app/data/initial-admin-password"
  info "It is in the log above too, and you are asked to change it at that first sign-in."
  say ""
  info "For production, see deploy/PRODUCTION.md. In short:"
  info "  • a real certificate in deploy/tls/ (this one lasts 30 days)"
  if [ "$CACHE" = 1 ]; then
    info "  • Redis is running (COMPOSE_PROFILES=cache is in .env, so it stays)"
  else
    info "  • Redis, worth it from a few dozen clusters:  --cache, or"
    info "    docker compose --profile cache up -d  in the directory above"
  fi
  info "  • a second stack on this host needs its own COMPOSE_PROJECT_NAME, or compose"
  info "    adopts this one's containers"
  exit 0
fi

# ------------------------------------------------------------------ pick the asset

case "$OS/$MODE" in
  linux/portable)   PATTERN='amd64\.AppImage$';       KIND=appimage ;;
  windows/portable) PATTERN='portable-win64\.zip$';   KIND=zip ;;
  macos/portable)   die "there is no portable macOS build — the .dmg is the only macOS asset" ;;
  linux/install)
    if   command -v dpkg >/dev/null 2>&1; then PATTERN='amd64\.deb$';    KIND=deb
    elif command -v rpm  >/dev/null 2>&1; then PATTERN='x86_64\.rpm$';   KIND=rpm
    else                                       PATTERN='amd64\.AppImage$'; KIND=appimage
      warn "neither dpkg nor rpm found — falling back to the AppImage"
    fi ;;
  windows/install)  PATTERN='x64_en-US\.msi$';        KIND=msi ;;
  macos/install)
    if [ "$ARCH" = arm64 ]; then PATTERN='aarch64\.dmg$'; else PATTERN='x64\.dmg$'; fi
    KIND=dmg ;;
  *) die "no asset for ${OS}/${MODE}" ;;
esac

URL=$(asset_url "$PATTERN") || true
[ -n "${URL:-}" ] || die "release ${TAG} has no asset matching ${PATTERN}"
FILE=$(basename "$URL")
info "asset ${FILE}"

if [ "$DRY" -eq 1 ]; then ok "dry run — would download ${URL}"; exit 0; fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

step "Downloading"
curl -fSL --progress-bar -o "$TMP/$FILE" "$URL" || die "download failed"

# Every release carries SHA256SUMS.txt, written by the release-checksums job over the
# finished asset list. Verify against it rather than printing a hash nobody compares: a
# truncated download and a tampered one look identical otherwise. A release that somehow
# has no checksum file still installs, but says so — refusing would strand anyone on an
# older tag that predates the file.
if command -v sha256sum >/dev/null 2>&1; then SUM=$(sha256sum "$TMP/$FILE" | cut -d' ' -f1)
elif command -v shasum  >/dev/null 2>&1; then SUM=$(shasum -a 256 "$TMP/$FILE" | cut -d' ' -f1)
else SUM=""; fi
SUMS_URL=$(asset_url 'SHA256SUMS\.txt$') || true
if [ -z "$SUM" ]; then
  warn "no sha256 tool on this machine — the download cannot be verified"
elif [ -z "$SUMS_URL" ]; then
  warn "this release publishes no SHA256SUMS.txt — the download cannot be verified"
  info "sha256 ${SUM}"
elif ! curl -fsSL -o "$TMP/SHA256SUMS.txt" "$SUMS_URL"; then
  warn "could not fetch SHA256SUMS.txt — the download cannot be verified"
  info "sha256 ${SUM}"
else
  WANT=$(awk -v f="$FILE" '$2 == f || $2 == "*" f { print $1 }' "$TMP/SHA256SUMS.txt" | head -1)
  [ -n "$WANT" ] || die "SHA256SUMS.txt does not list ${FILE} — refusing to install an asset the release does not vouch for"
  [ "$WANT" = "$SUM" ] || die "checksum mismatch for ${FILE}: expected ${WANT}, got ${SUM} — do not use this download"
  ok "sha256 verified against the release's SHA256SUMS.txt"
fi

# ------------------------------------------------------------------ install it

case "$KIND" in
  deb)
    step "Installing the package"
    # apt resolves the webkit dependencies; dpkg alone would leave them unmet.
    if command -v apt-get >/dev/null 2>&1; then as_root apt-get install -y "$TMP/$FILE"
    else as_root dpkg -i "$TMP/$FILE"; fi
    ok "Installed. Launch it from your applications menu, or run: elasticpro" ;;
  rpm)
    step "Installing the package"
    if command -v dnf >/dev/null 2>&1; then as_root dnf install -y "$TMP/$FILE"
    else as_root rpm -i "$TMP/$FILE"; fi
    ok "Installed. Launch it from your applications menu, or run: elasticpro" ;;
  appimage)
    # Portable stays where the operator is standing — that is what portable means. An
    # install goes to the versioned directory under /opt.
    VER=${TAG#v}
    DEST=${DEST:-$( [ "$MODE" = portable ] && echo "$PWD" || linux_dir "$VER" )}
    if [ "$MODE" = portable ]; then
      mkdir -p "$DEST"
      install -m 0755 "$TMP/$FILE" "$DEST/$FILE"
      ok "Placed ${DEST}/${FILE}"
      info "Self-contained: run it directly, delete it to remove it."
    else
      as_root mkdir -p "$DEST"
      as_root install -m 0755 "$TMP/$FILE" "$DEST/elasticpro"
      ok "Installed ${DEST}/elasticpro"
      # One stable name pointing at the version in use, so a rollback is a symlink
      # change and nobody's script has to know the version number.
      if as_root ln -sfn "$DEST/elasticpro" /usr/local/bin/elasticpro 2>/dev/null; then
        info "Linked /usr/local/bin/elasticpro → ${DEST}/elasticpro"
        info "Run it by name: elasticpro"
      else
        info "Run it with: ${DEST}/elasticpro"
      fi
    fi ;;
  zip)
    need unzip
    DEST=${DEST:-$PWD}
    step "Unpacking into ${DEST}"
    unzip -q -o "$TMP/$FILE" -d "$DEST"
    ok "Unpacked ${DEST}/ElasticPro-portable-win64"
    info "Self-contained: it keeps everything in its own data\\ folder and installs nothing."
    info "Delete the folder to remove it." ;;
  msi)
    step "Handing the installer to Windows"
    # A GUI installer, started from a shell that is about to exit: /passive keeps a
    # progress window so it is obvious something is happening.
    MSI_WIN=$(cygpath -w "$TMP/$FILE" 2>/dev/null || printf '%s' "$TMP/$FILE")
    msiexec.exe /i "$MSI_WIN" /passive || die "the installer reported a failure"
    ok "Installed. Look for ElasticPro in the Start menu." ;;
  dmg)
    step "Mounting the disk image"
    MP=$(hdiutil attach -nobrowse -readonly "$TMP/$FILE" | awk '/\/Volumes\//{print substr($0, index($0,"/Volumes/"))}' | head -1)
    [ -n "$MP" ] || die "could not mount the disk image"
    cp -R "$MP"/*.app /Applications/ && ok "Copied to /Applications" || warn "could not copy into /Applications"
    hdiutil detach "$MP" >/dev/null || true ;;
esac

say ""
info "Source and support: https://github.com/${REPO}"
