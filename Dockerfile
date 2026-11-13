# The app (Rust, Corten): every screen, JSON route, job and migration. Built from its sources
# only, into a target cache of its own (so other apps' builds on the host never hold its lock),
# one build at a time, with every source touched first, since cargo goes by file times.
FROM rust:1-bookworm AS web-build
WORKDIR /src
COPY Cargo.toml Cargo.lock /src/
COPY tokens /src/tokens
COPY src /src/src
COPY static /src/static
COPY locales /src/locales
COPY types /src/types
COPY build.rs /src/build.rs
COPY db/migrations /src/db/migrations
# zstd (corten's `compress`) links this image's libzstd instead of compiling it from its C sources,
# the slowest crate in a clean build; the `web` image below has libzstd.so.1. An image without it
# (distroless, scratch) must drop this line.
ENV ZSTD_SYS_USE_PKG_CONFIG=1
# Corten comes from GitHub, or from the git repository in the `corten-source` build context when
# it holds one (CORTEN_SOURCE in docker-compose.prod.yml): a copy holding the commit Cargo.lock
# pins, for a release while GitHub cannot serve it. Cargo.lock still names GitHub either way.
# Downloaded crates and git checkouts live in a cargo home every build on the host shares, so its
# lock is cargo's own and two builds fetching at once do not collide; it holds no tokens.
RUN --mount=type=cache,target=/var/cache/cargo \
    --mount=type=cache,id=tcgplayer-automation-target,target=/src/target,sharing=locked \
    --mount=type=bind,from=corten-source,target=/corten-source \
    if [ -f /corten-source/HEAD ]; then \
        git config --global url."file:///corten-source".insteadOf https://github.com/corten-run/corten \
        && git config --global --add safe.directory '*' \
        && export CARGO_NET_GIT_FETCH_WITH_CLI=true; \
    fi \
    && find . -name target -prune -o -type f -exec touch {} + \
    && CARGO_HOME=/var/cache/cargo cargo build --release --locked \
    && cp target/release/tcgplayer-automation /server

FROM debian:bookworm-slim AS web
# jemalloc gives back the memory a burst of connections took; glibc's allocator keeps it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget libjemalloc2 \
    && rm -rf /var/lib/apt/lists/*
ENV LD_PRELOAD=libjemalloc.so.2
WORKDIR /app
COPY --from=web-build /server /app/server
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["/app/server"]
