# The Docker worker image, rakazo/worker: what the E2B template (template/template.ts) installs, for
# the pi-native harness. Build context is the repository root:
#   docker build -f apps/agent-run-worker/Dockerfile -t rakazo/worker:local .
FROM node:24-bookworm AS bundle
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    pnpm install --frozen-lockfile --store-dir=/pnpm-store \
      --filter "@tangow/agent-run-worker..." --filter rakazo
# The bundle script loads the adapters, which import the Prisma client; the bundle itself excludes it.
RUN pnpm --filter @tangow/db generate && pnpm --filter @tangow/agent-run-worker bundle

FROM node:24-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git procps ripgrep fd-find \
  && rm -rf /var/lib/apt/lists/*

# The guest runs as uid 1000 with the E2B sandbox user's name and home. A Docker source install
# runs it as the host user instead, as its computer: the home and workspace accept any user.
RUN usermod -l user -d /home/user -m node && groupmod -n user node \
  && mkdir /workspace && chown user:user /workspace && chmod 1777 /home/user /workspace

ARG GIT_SHA
LABEL org.opencontainers.image.revision=$GIT_SHA

ENV RAKAZO_WORKER_HOME=/home/user RAKAZO_WORKER_HARNESS=pi-native

COPY --from=bundle /app/apps/agent-run-worker/dist/managed-skills /managed-skills
RUN chown -R root:root /managed-skills && chmod -R a+rX,a-w /managed-skills
COPY --from=bundle /app/apps/agent-run-worker/dist/agent-run-worker.mjs /opt/rakazo/agent-run-worker.mjs

USER 1000:1000
WORKDIR /workspace
