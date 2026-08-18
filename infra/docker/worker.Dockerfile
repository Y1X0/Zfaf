#
# The background worker image (Go-Live gate 2).
#
# Built and run in this environment, with the caveats in docs/22 §11. The image
# starts, `prisma migrate deploy` runs from it exactly as Render's
# `preDeployCommand` will, and SIGTERM reaches the process so an in-flight
# encode finishes. Getting there took fixing three faults that no test had ever
# reached, because nothing had ever started this process for real.
#
# ## Why this image keeps its source and its dev dependencies
#
# Every workspace package publishes TypeScript directly — `@zfaf/core` exports
# `./src/index.ts`, and so do the others. The web app can afford that because
# `next build` transpiles them into its standalone bundle; the worker has no
# bundler, so `apps/worker/dist/index.js` compiled by `tsc` would start and
# then fail on its first `import '@zfaf/core'`, at runtime, in production.
#
# So the worker runs its TypeScript through `tsx`, which is already its dev
# dependency, and this image therefore carries the source tree and the full
# install. That is an honest trade rather than an oversight: the alternative is
# a bundling step whose failure mode is a silently missing runtime file, and
# this service is not the one where image size decides anything. Bundling it
# properly is noted as follow-up work in docs/22 §11.

FROM node:22-bookworm-slim AS base

# OpenSSL for Prisma's query engine. `sharp` needs no system libvips — it ships
# a prebuilt binary for linux-x64/glibc, and bookworm's glibc is new enough.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH"
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app


# ── Dependencies ──────────────────────────────────────────────────────────
FROM base AS deps

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/infra/package.json packages/infra/package.json
COPY packages/invitation-renderer/package.json packages/invitation-renderer/package.json
COPY packages/media-client/package.json packages/media-client/package.json
COPY packages/media-processing/package.json packages/media-processing/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY tools/eslint-plugin-zfaf/package.json tools/eslint-plugin-zfaf/package.json

RUN pnpm install --frozen-lockfile


# ── Runtime ───────────────────────────────────────────────────────────────
FROM deps AS runner

COPY --chown=node:node . .

# Generated, not vendored. Also what `prisma migrate deploy` runs from when
# this image is used as the migration step (docs/22 §5) — the schema and the
# whole `migrations/` directory travel with it.
RUN pnpm --filter @zfaf/db exec prisma generate \
  && chown -R node:node /app/packages/db

ENV NODE_ENV=production
USER node
WORKDIR /app/apps/worker

# `node --import tsx`, not the `tsx` CLI, and the difference is operational:
# the CLI wraps the program in a supervising process, and this worker's
# graceful shutdown depends on receiving SIGTERM itself so an in-flight image
# encode finishes instead of leaving an asset stuck in `processing`. Running
# the loader inside the same process removes the hop the signal would have to
# survive.
CMD ["node", "--import", "tsx", "src/index.ts"]
