---
id: mem_rL4zz2Xt
title: >-
  Monorepo layout and hosting split: CLI in apps/cli, web on Vercel, api+worker
  on Render, Supabase for data
date: '2026-10-07'
author: kishore.knaresh07@gmail.com (via agent)
tags:
  - architecture
  - setup
  - deployment
refs:
  - apps/cli/graph-app/next.config.mjs
  - apps/cli/scripts/prebuild.mjs
  - render.yaml
  - apps/worker/Dockerfile
  - .github/workflows/ci.yml
  - .mcp.json
  - apps/web/package.json
supersedes: null
status: active
commit: bbc89b05859344871f5d3b878c1e4ae5b3a5270d
fingerprint:
  apps/cli/graph-app/next.config.mjs:
    hash: 23e6f454f810be86
    kind: file
  apps/cli/scripts/prebuild.mjs:
    hash: 3373084315b5e87c
    kind: file
  render.yaml:
    hash: 0653c121562fe3c9
    kind: file
  apps/worker/Dockerfile:
    hash: 5f8601e2ae5af301
    kind: file
  .github/workflows/ci.yml:
    hash: 0f036db2fcd09d23
    kind: file
  .mcp.json:
    hash: 9b3696221351882f
    kind: file
  apps/web/package.json:
    hash: c158696f4872f1a7
    kind: file
last_checked: null
---
Sprint 0 converted the repo to npm workspaces (packages/* then apps/*). The published package is still `whyanchor`, now living in apps/cli; `npm pack -w whyanchor` yields the same 198-file tarball as 0.3.0, and publishing becomes `npm publish -w whyanchor --ignore-scripts` from the root. Hosting split (user's explicit choices): web app on Vercel (Root Directory apps/web), backend on Render as two services (apps/api web service for GitHub webhooks and later hosted MCP; apps/worker Docker background worker, Docker only because the staleness engine shells out to real git), Supabase Postgres for data. No custom domain yet: use *.vercel.app and *.onrender.com, both stable per name. Non-obvious things learned during the move: (1) graph-app's `next` is hoisted to the repo root, and Turbopack refuses to resolve above its root, so next.config.mjs points turbopack.root and outputFileTracingRoot at the workspace root only when it detects the monorepo; the installed-from-npm layout keeps the old behavior. (2) `npm publish` only packs README/LICENSE found inside the package dir, so prebuild copies them from the root (gitignored copies). (3) .mcp.json had been overwritten with a machine-specific absolute path in commit 658865e; it must stay the portable `npx tsx apps/cli/src/cli.ts mcp`. (4) Moving files makes every memory ref `missing`; re-anchor by rewriting paths while KEEPING the recorded hashes, so drift that predates the move stays visible, and re-baseline only files edited and verified on purpose. (5) Render builds with NODE_ENV=production, so builds use `npm ci --include=dev -w <workspace>`, otherwise tsc is not installed. (6) Found, not caused by the move: published whyanchor@0.3.0 `viewgraph` crashes on fresh installs because `next: ^16.3.6` resolves to 16.4.0 while the shipped .next was built with 16.3.6 (missing .next/server/preview-props.json); apps/web pins next to exactly 16.3.6 to avoid the same skew.
