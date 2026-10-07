# ElasticPro — hosted core. Two stages: build the Rust bridge, then ship only the
# binary and the static UI on a minimal image.
FROM rust:1-bookworm AS build
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

FROM debian:bookworm-slim
# `upgrade` before `install`, not just `install`: the base tag floats, but it is only
# rebuilt periodically, so between rebuilds it carries packages with published fixes
# already in the Debian archive. A scan of the bare base found four CRITICAL and three
# HIGH advisories against perl-base alone, every one of them fixed by an upgrade that
# costs nothing here. Without this line those ship in the image.
RUN apt-get update && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --home /app --shell /usr/sbin/nologin elasticpro
WORKDIR /app
COPY --from=build /src/target/release/elasticpro-bridge /usr/local/bin/elasticpro-bridge
COPY ui ./ui
RUN mkdir -p /app/data && chown -R elasticpro:elasticpro /app
USER elasticpro
# Hosted mode: bind the compose network, not loopback. nginx is the only way in.
ENV ELASTICPRO_BIND=0.0.0.0 ELASTICPRO_DATA_DIR=/app/data RUST_LOG=info
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s CMD curl -sf -X POST http://127.0.0.1:8765/bridge \
  -H 'content-type: application/json' -H 'x-auth-user: healthcheck' -d '{"type":"PING"}' >/dev/null || exit 1
ENTRYPOINT ["elasticpro-bridge", "/app/ui", "8765"]
