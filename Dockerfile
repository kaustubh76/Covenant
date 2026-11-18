# Covenant's backend (backend/): Node and Anvil, plus the seeded state every Playground chain starts from.
# Built from the repository root, so it can read backend/ and deployments/; .dockerignore keeps everything else out.

FROM node:22-bookworm-slim AS build
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY backend/tsconfig.json backend/build.mjs ./
COPY backend/src ./src
RUN npm run build

# Anvil from Foundry's release, the same version that dumped the seed (v1.1.0).
FROM debian:bookworm-slim AS anvil
ARG FOUNDRY_VERSION=v1.1.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL "https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_linux_amd64.tar.gz" \
    | tar -xz -C /usr/local/bin anvil \
 && /usr/local/bin/anvil --version

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=anvil /usr/local/bin/anvil /usr/local/bin/anvil
COPY --from=build /app/backend/dist ./backend/dist
COPY backend/state ./backend/state
COPY deployments/playground.json deployments/playground.runtime.json ./deployments/
ENV NODE_ENV=production
USER node
EXPOSE 10000
CMD ["node", "backend/dist/server.js"]
