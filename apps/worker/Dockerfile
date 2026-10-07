# Render background-worker image. The build context is the repo root (see render.yaml).
FROM node:22-slim

# The staleness engine shells out to real `git` (rev-list, cat-file) and the sync job runs
# `git clone --filter=blob:none`, so git must be on PATH. ca-certificates is for HTTPS clones.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# Manifests first, so the dependency layer is cached until a package.json or the lockfile changes.
# `npm ci` checks the lockfile against EVERY workspace, so every workspace manifest has to be here.
# Add a line when you add a workspace.
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/cli/package.json apps/cli/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
# --include=dev: tsc is a devDependency, and Render builds with NODE_ENV=production.
RUN npm ci --include=dev -w @whyanchor/worker

COPY apps/worker apps/worker
COPY packages packages
RUN npm run build -w @whyanchor/worker

ENV NODE_ENV=production
# Jobs clone into per-job temp directories under here and delete them afterwards; nothing persists.
ENV WORK_DIR=/tmp/whyanchor

USER node
CMD ["node", "apps/worker/dist/index.js"]
