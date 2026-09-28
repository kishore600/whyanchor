---
id: mem_8KWp_g7G
title: Marker blocks are replaced only when exactly one well-ordered pair exists
date: '2026-09-27'
author: kishore.knaresh07@gmail.com
tags:
  - architecture
  - generation
refs:
  - src/generators/agentsFile.ts#upsertMarkedSection
  - src/generators/agentsFile.ts#renderMemorySection
supersedes: mem_Q3SM2Ht6
status: active
commit: 1f8760cfc0d4426917f6448c04284c6b0cd837d9
fingerprint:
  src/generators/agentsFile.ts#upsertMarkedSection:
    hash: a43b3e6c7798f9d0
    kind: symbol
  src/generators/agentsFile.ts#renderMemorySection:
    hash: ab9ace35a053e12e
    kind: symbol
last_checked: null
---
upsertMarkedSection still matches markers as whole lines (never substrings) and is shared by the memory block and the connect usage block. It now refuses, changing nothing, unless there is exactly one start and one end marker in order: the old first-start-to-last-end rule turned an accidentally deleted end marker into data loss, because the next run appended a new block and the run after that deleted everything between the orphaned start and the new end, hand-written notes included. It also splices in LF and writes back in the file's dominant line ending (CRLF files used to end up mixed), and reports unchanged instead of rewriting identical content. renderMemorySection lists each note once under its first tag (the user's explicit choice, so a note with three tags isn't injected into agent context three times) and backticks a body line that is exactly a marker so it can't be mistaken for the real one.
