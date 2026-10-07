---
id: mem_VPjhxNUi
title: 'connect registers npx, not the cache path, when it runs from an npx/dlx cache'
date: '2026-09-27'
author: kishore.knaresh07@gmail.com
tags:
  - setup
  - mcp
refs:
  - apps/cli/src/generators/agentConfig.ts#isEphemeralInstall
  - apps/cli/src/generators/agentConfig.ts#npxServerCommand
  - apps/cli/src/commands/connect.ts#runConnect
supersedes: null
status: active
commit: 1f8760cfc0d4426917f6448c04284c6b0cd837d9
fingerprint:
  apps/cli/src/generators/agentConfig.ts#isEphemeralInstall:
    hash: a22fe7e817764cdc
    kind: symbol
  apps/cli/src/generators/agentConfig.ts#npxServerCommand:
    hash: c846a5b03cf7a864
    kind: symbol
  apps/cli/src/commands/connect.ts#runConnect:
    hash: 941cdd4ee1383c49
    kind: symbol
last_checked: null
---
The README's quick start is npx whyanchor, and connect registered the path of the CLI it was running from, which under npx is a cache folder that gets pruned, so the MCP server would silently disappear later. When the path contains an _npx, dlx or bunx- segment, connect now registers npx -y whyanchor mcp instead (the user's explicit choice over a warning-only fix). On Windows that is wrapped in cmd /c because MCP clients spawn without a shell and can't launch npx's .cmd shim. Global installs and source checkouts still get node <absolute cli.js> mcp, which is stable on that machine but not across a team, so the README says to pass a portable --command when committing these configs.
