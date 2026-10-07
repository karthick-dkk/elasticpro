# ElasticPro — hosted core. Two stages: build the Rust bridge, then ship only the
# binary and the static UI on a minimal image.
#
# Alpine/musl rather than Debian, for one reason: vulnerability count. The Debian
# runtime this replaced scanned at 1 CRITICAL and 61 HIGH even after `apt-get upgrade`,
# none of them with a fix available — they are advisories against base packages that
# Debian has not patched, and no amount of care in this file removes them. alpine:3.22
# scans clean, and a musl build needs nothing from the runtime but certificates, so the
# finished image carries almost no OS surface at all. The crypto is `ring` throughout
# (rustls and russh both select it here), so there is no OpenSSL to link against and the
# musl build is a straight recompile rather than a port.
FROM rust:1-alpine AS build
# ring compiles C and assembly; musl-dev gives the linker its libc. Nothing else is
# needed — no OpenSSL, no pkg-config, no cmake.
RUN apk add --no-cache build-base musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
# The Tauri shell is a workspace member, so cargo has to be able to load its manifest
# even though only elasticpro-core is built here. Its manifest declares a [lib], which means
# src/lib.rs must exist — a stub main.rs is not enough. The directory is under 1 MB, so
# copying it whole is simpler than a stub and cannot drift from the real manifest.
COPY src-tauri ./src-tauri
# Capped by default, because the machine most likely to build this is a small server that
# is already running something. rustc peaks over a gigabyte per crate on this dependency
# set, and one unbounded build has enough parallelism to push a 4 GB host into the OOM
# killer — which takes out whatever else that host was doing, not the build.
# Raise it on a build machine: --build-arg CARGO_BUILD_JOBS=8.
ARG CARGO_BUILD_JOBS=2
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS}
RUN cargo build --release --locked -p elasticpro-core --features bridge --bin elasticpro-bridge

FROM alpine:3.22
# ca-certificates only: rustls-native-certs reads the system trust store, and nothing
# else in the image needs a package. Deliberately no curl — it would pull libcurl and
# OpenSSL back in, which is most of the CVE surface this base exists to avoid. The
# healthcheck below uses busybox wget, which speaks enough HTTP to POST the same probe.
# `upgrade` first, for the same reason the Debian base needed it: the base tag is only
# rebuilt periodically, so between rebuilds it carries packages Alpine has already fixed.
# Without this line the image ships zlib 1.3.2-r0 and CVE-2026-85091 with it.
# uid pinned to 999, which is what every release up to this one ran as. Not cosmetic:
# /app/data is a volume that survives the upgrade, its files are 0600 owned by 999, and
# `adduser -S` without -u picks the first free system id — 100 on this base. An image
# running as 100 cannot read a volume written by 999, so the core finds no accounts, no
# notification store and no cache, and seeds a fresh admin as though this were a new
# install. That is silent data loss on upgrade.
#
# The uid alone is pinned, not a matching gid: 0600 grants nothing to the group, so only
# the owner id decides whether the old files can be read, and gid 999 is already `ping`
# on Alpine. The user lands in `nogroup`, which is what it had before this was pinned.
RUN apk --no-cache upgrade \
  && apk add --no-cache ca-certificates \
  && adduser -u 999 -S -H -h /app -s /sbin/nologin elasticpro
WORKDIR /app
COPY --from=build /src/target/release/elasticpro-bridge /usr/local/bin/elasticpro-bridge
COPY ui ./ui
RUN mkdir -p /app/data && chown -R elasticpro /app
USER elasticpro
# Hosted mode: bind the compose network, not loopback. nginx is the only way in.
ENV ELASTICPRO_BIND=0.0.0.0 ELASTICPRO_DATA_DIR=/app/data RUST_LOG=info
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O /dev/null -T 4 \
  --header='content-type: application/json' --header='x-auth-user: healthcheck' \
  --post-data='{"type":"PING"}' http://127.0.0.1:8765/bridge || exit 1
ENTRYPOINT ["elasticpro-bridge", "/app/ui", "8765"]
