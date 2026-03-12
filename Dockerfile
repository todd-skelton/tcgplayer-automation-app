FROM node:20-alpine AS base
WORKDIR /app

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

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=production-dependencies-env /app/node_modules /app/node_modules
COPY --from=build-env /app/build /app/build
COPY package.json package-lock.json /app/
COPY db /app/db
COPY scripts /app/scripts
CMD ["node", "scripts/docker-start.mjs"]
