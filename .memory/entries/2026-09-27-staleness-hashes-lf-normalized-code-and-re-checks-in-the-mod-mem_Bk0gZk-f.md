---
id: mem_Bk0gZk-f
title: >-
  Staleness hashes LF-normalized code and re-checks in the mode it was captured
  in
date: '2026-09-27'
author: kishore.knaresh07@gmail.com
tags:
  - architecture
  - staleness
refs:
  - apps/cli/src/core/staleness.ts#checkRef
  - apps/cli/src/core/fingerprint.ts#fingerprintContent
  - apps/cli/src/core/legacyFingerprint.ts#legacySymbolHashes
supersedes: mem_0_1s55r4
status: active
commit: 1f8760cfc0d4426917f6448c04284c6b0cd837d9
fingerprint:
  apps/cli/src/core/staleness.ts#checkRef:
    hash: 33b937d098959537
    kind: symbol
  apps/cli/src/core/fingerprint.ts#fingerprintContent:
    hash: 11bbdd0d47fef977
    kind: symbol
  apps/cli/src/core/legacyFingerprint.ts#legacySymbolHashes:
    hash: c2da89a1f5df5da2
    kind: symbol
last_checked: null
---
Still hashes plus git history, no LLM. Code is normalized (CRLF/CR to LF, BOM stripped) before hashing: raw-byte hashes flagged every note [STALE] on a fresh Windows clone with core.autocrlf, since the same commit checks out with different bytes per platform. The raw-bytes hash is still accepted (legacyHash) so notes recorded before this change stay fresh on the checkout they came from. check recomputes exactly what was recorded: kind file means whole file (capture falls back to it when a symbol can't be found), kind symbol means a vanished symbol is missing, kind missing means no baseline. A capture commit gone from history (rebase, squash, shallow clone) is reported as unknown (commitsSince null), never as 0 commits; counting uses git rev-list --count. The extractor from whyanchor 0.2.0 and earlier is kept verbatim in legacyFingerprint.ts only to recognize its partial baselines (often just a signature), which check reports as low with a re-anchor hint instead of a false content-changed flag.
