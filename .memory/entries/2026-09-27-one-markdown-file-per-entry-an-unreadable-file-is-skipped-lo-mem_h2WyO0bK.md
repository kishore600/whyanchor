---
id: mem_h2WyO0bK
title: 'One markdown file per entry; an unreadable file is skipped loudly, never fatal'
date: '2026-09-27'
author: kishore.knaresh07@gmail.com
tags:
  - architecture
  - storage
refs:
  - src/core/store.ts#loadEntries
  - src/core/schema.ts#MemoryFrontmatterSchema
supersedes: mem_6x2g7wNE
status: active
commit: 1f8760cfc0d4426917f6448c04284c6b0cd837d9
fingerprint:
  src/core/store.ts#loadEntries:
    hash: 6d5f83609fe7ac50
    kind: symbol
  src/core/schema.ts#MemoryFrontmatterSchema:
    hash: f13d52b0baf45f53
    kind: symbol
last_checked: null
---
Entries stay one markdown file each with YAML frontmatter, so git merges, diffs and blames them and they read fine without the tool. What changed is failure handling: one file with a merge conflict in its frontmatter (easy to get, since check --write rewrites last_checked in every entry) used to crash list, check, generate, every MCP tool and the graph API. loadEntries now isolates it: every command warns with the file name and error, check --fail-on-stale fails because that note can't be vouched for, and MCP logs it to stderr. That keeps the earlier rule that a bad hand-edit fails loudly, without taking the whole store down. The schema also accepts YAML's typed scalars (an unquoted date parses as a Date, an all-digit commit as a number), because the README's own format example uses an unquoted date.
