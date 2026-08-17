# syntax=docker/dockerfile:1
#
# The web image (Go-Live gate 2).
#
# ⚠️ Built and reviewed, **never executed in this environment** — this machine
# has no Docker daemon. The first real build is a step on the deployment
# checklist (docs/22 §4), not something already proven here.
#
# Four stages, and the split is not decoration: `deps` installs from the
# lockfile alone so that a source change does not re-resolve the dependency
# tree, and `runner` starts from a clean base so that nothing from the build —
# no dev dependency, no source file, and above all no build-stage environment
# variable — can survive into the image that faces the internet.

FROM node:22-bookworm-slim AS base

# OpenSSL is not optional: Prisma's query engine links against it, and the
# failure without it appears as a runtime connection error rather than as a
# build failure — which is to say, in production.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH"
# Pinned to the version in `packageManager`. A different pnpm resolves the
# lockfile differently, which is the whole point of having one.
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app


# ── Dependencies ──────────────────────────────────────────────────────────
# Only the manifests, so this layer is reused across every commit that does
# not change a dependency.
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
COPY packages/shared/package.json packages/shared/package.json
COPY tools/eslint-plugin-zfaf/package.json tools/eslint-plugin-zfaf/package.json

# `--frozen-lockfile` fails rather than silently updating the lockfile. A
# deploy that quietly resolves a different version of a transitive dependency
# is a deploy nobody reviewed. `.npmrc` still governs which packages may run a
# lifecycle script (docs/12 §7).
RUN pnpm install --frozen-lockfile


# ── Build ─────────────────────────────────────────────────────────────────
FROM deps AS build

COPY . .

# The Prisma client is generated, not vendored, and `next build` imports it.
RUN pnpm --filter @zfaf/db exec prisma generate

# Build-stage environment only. Never copied into the runtime image.
#
# `next build` prerenders the marketing pages, and prerendering runs
# application code — which means a module that reaches for `getEnv()` would
# fail the build on an empty environment. None of the prerendered pages embeds
# a configured value today (nothing baked here reaches a user), and these exist
# so that a future page which does read configuration fails loudly at build
# time rather than being served with a placeholder.
#
# They are deliberately valid-but-inert: they satisfy the production rules in
# `parseEnv` (no `replace-me`, https, no `minio`, no `noop` mail) while pointing
# at `.invalid`, a reserved TLD that resolves nowhere. If one of them ever leaks
# into a running container the failure is immediate and obvious rather than
# subtle.
ENV NODE_ENV=production \
    PUBLIC_BASE_URL=https://build.invalid \
    DATABASE_URL=postgresql://build:build@build.invalid:5432/build \
    REDIS_URL=redis://build.invalid:6379 \
    SESSION_SECRET=build-stage-placeholder-not-a-secret-000000 \
    TOTP_ENCRYPTION_KEY=build-stage-placeholder-not-a-secret-111111 \
    STORAGE_DRIVER=r2 \
    STORAGE_ENDPOINT=https://build.invalid \
    STORAGE_REGION=auto \
    STORAGE_BUCKET_MEDIA=build \
    STORAGE_ACCESS_KEY_ID=build \
    STORAGE_SECRET_ACCESS_KEY=build \
    STORAGE_PUBLIC_BASE_URL=https://build.invalid \
    MAIL_DRIVER=resend \
    MAIL_RESEND_API_KEY=build \
    MAIL_FROM_ADDRESS=build@build.invalid \
    MAIL_FROM_NAME=Zfaf \
    DEFAULT_MARKET=SA \
    NEXT_TELEMETRY_DISABLED=1

# `build` also compiles the public page's single script with esbuild before
# Next runs — see apps/web/scripts/build-public-script.mjs (ADR-0020).
RUN pnpm --filter @zfaf/web build


# ── Runtime ───────────────────────────────────────────────────────────────
# A fresh base: no pnpm store, no dev dependencies, no source tree, and none of
# the build-stage variables above.
FROM base AS runner

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

# The standalone tree is rooted at the repository root (`outputFileTracingRoot`
# in next.config.ts), so it unpacks as `apps/web/server.js` plus a pruned
# `node_modules`. Next does not copy static assets or `public/` into it — the
# two lines after do what apps/web/scripts/start-standalone.mjs does locally.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public

# The image ships with an unprivileged `node` user; nothing here needs root.
USER node

# `HOSTNAME=0.0.0.0`, and it is the one line most likely to matter.
#
# The local end-to-end harness runs the same standalone server with
# `HOSTNAME=localhost` on purpose (D9.1): Next compares a middleware rewrite's
# origin against a base built from its configured hostname, and when the two
# disagree it treats an internal locale rewrite as an outbound request.
#
# A container cannot do that — a platform load balancer reaches it over the
# container network, so it must bind every interface. Which means the conditions
# that produced D9.1 are *different here, not absent*: the bound host is
# `0.0.0.0` while the forwarded `Host` is the public domain.
#
# Nothing local can prove which way that falls. docs/22 §6 is the first thing to
# run against the first deploy, before any DNS points at it.
ENV HOSTNAME=0.0.0.0 \
    PORT=10000
EXPOSE 10000

CMD ["node", "apps/web/server.js"]
