FROM node:20-alpine AS base
WORKDIR /app
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

FROM base AS development-dependencies-env
COPY package.json package-lock.json /app/
RUN npm ci
COPY . /app

FROM base AS production-dependencies-env
COPY package.json package-lock.json /app/
RUN npm ci --omit=dev

FROM base AS build-env
COPY --from=development-dependencies-env /app/node_modules /app/node_modules
COPY . /app/
RUN npm run build

# The Corten app (Rust): the screens already ported, in front of the Node app, which serves the
# rest through its relay. Built from its sources only, with the build cache shared one build at a
# time and every source touched first, since cargo goes by file times.
FROM rust:1-bookworm AS web-build
WORKDIR /src
COPY Cargo.toml Cargo.lock tokens.json /src/
COPY src /src/src
COPY static /src/static
COPY locales /src/locales
COPY types /src/types
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target,sharing=locked \
    find . -name target -prune -o -type f -exec touch {} + \
    && cargo build --release --locked \
    && cp target/release/tcgplayer-automation /server

FROM debian:bookworm-slim AS web
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=web-build /server /app/server
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["/app/server"]

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=production-dependencies-env /app/node_modules /app/node_modules
COPY --from=build-env /app/build /app/build
COPY package.json package-lock.json /app/
COPY db /app/db
COPY scripts /app/scripts
CMD ["node", "scripts/docker-start.mjs"]
