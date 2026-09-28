import { fingerprintContent, parseRef, readRefFile } from "./fingerprint.js";
import { countCommitsSince } from "./git.js";
import { legacySymbolHashes } from "./legacyFingerprint.js";
import type { FingerprintEntry, MemoryEntry } from "./schema.js";

export type StalenessLevel = "fresh" | "low" | "high" | "missing";

export interface RefStaleness {
  ref: string;
  level: StalenessLevel;
  /** Commits that touched the file since capture; null when the capture commit is not in history. */
  commitsSince: number | null;
  reason: string;
}

export interface EntryStaleness {
  entry: MemoryEntry;
  refs: RefStaleness[];
  level: StalenessLevel;
}

export type CommitCounter = (repoRoot: string, sinceCommit: string | null, filePath: string) => Promise<number | null>;

const LEVEL_RANK: Record<StalenessLevel, number> = { fresh: 0, low: 1, missing: 2, high: 3 };

// Each ref costs a file read and a couple of git processes; unbounded Promise.all over a large
// store can exhaust process/file-handle limits, and git() turns those failures into silent zeros.
const CHECK_CONCURRENCY = 8;

function worse(a: StalenessLevel, b: StalenessLevel): StalenessLevel {
  return LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export async function checkRef(
  repoRoot: string,
  ref: string,
  capturedCommit: string | null,
  captured: FingerprintEntry,
  countCommits: CommitCounter = countCommitsSince
): Promise<RefStaleness> {
  const { file, symbol } = parseRef(ref);
  const content = await readRefFile(repoRoot, file);

  if (captured.kind === "missing") {
    return {
      ref,
      level: "missing",
      commitsSince: 0,
      reason:
        content === null
          ? "referenced file not found (it did not resolve when the note was captured either)"
          : "no baseline: the ref did not resolve when the note was captured — supersede the note to re-anchor it",
    };
  }
  if (content === null) {
    return { ref, level: "missing", commitsSince: 0, reason: `${file} no longer exists` };
  }

  // Recompute exactly what was recorded: a note that fell back to the whole file at capture time
  // keeps being compared as a whole file; a symbol that has since vanished is reported missing.
  const mode = captured.kind === "file" ? "file" : "symbol";
  const current = fingerprintContent(content, symbol, mode);
  if (current.kind === "missing") {
    return { ref, level: "missing", commitsSince: 0, reason: `symbol "${symbol}" no longer found in ${file}` };
  }

  const commitsSince = await countCommits(repoRoot, capturedCommit, file);
  const touched =
    commitsSince === null
      ? "the capture commit is not in this clone's history, so commits since capture can't be counted"
      : `${plural(commitsSince, "commit")} touched the file`;
  const scope = symbol && mode === "file" ? " (whole file — the symbol was not found when the note was captured)" : "";

  // legacyHash: fingerprints recorded before line endings were normalized hashed the raw bytes.
  const matches = current.hash === captured.hash || current.legacyHash === captured.hash;
  // A baseline from the earlier extractor often covered only part of the symbol (e.g. just its
  // signature). If that part still hashes the same, the note can't be called changed — but nor
  // can the rest of the symbol be vouched for, so say exactly that instead of crying wolf.
  if (!matches && mode === "symbol" && symbol && legacySymbolHashes(content, symbol).includes(captured.hash)) {
    return {
      ref,
      level: "low",
      commitsSince,
      reason:
        `the part of "${symbol}" an older whyanchor fingerprinted (often just its signature) is unchanged, but the ` +
        "rest can't be verified against that baseline — supersede the note to re-anchor it",
    };
  }
  if (!matches) {
    return { ref, level: "high", commitsSince, reason: `content changed since capture${scope} (${touched})` };
  }
  if (commitsSince !== null && commitsSince > 0) {
    return {
      ref,
      level: "low",
      commitsSince,
      reason: `${touched} since capture, but the referenced content is unchanged${scope}`,
    };
  }
  return {
    ref,
    level: "fresh",
    commitsSince,
    reason: commitsSince === null ? "unchanged (capture commit not in this clone's history)" : "unchanged",
  };
}

export async function checkEntry(
  repoRoot: string,
  entry: MemoryEntry,
  countCommits: CommitCounter = countCommitsSince
): Promise<EntryStaleness> {
  const refs: RefStaleness[] = [];
  for (const ref of entry.frontmatter.refs) {
    const captured = entry.frontmatter.fingerprint[ref];
    if (!captured) {
      refs.push({ ref, level: "missing", commitsSince: 0, reason: "no fingerprint recorded at capture time" });
      continue;
    }
    refs.push(await checkRef(repoRoot, ref, entry.frontmatter.commit, captured, countCommits));
  }

  let level: StalenessLevel = "fresh";
  for (const r of refs) level = worse(level, r.level);

  return { entry, refs, level };
}

/** Shares git lookups across a whole check run — many entries anchor to the same files and commits. */
function memoizedCounter(): CommitCounter {
  const cache = new Map<string, Promise<number | null>>();
  return (repoRoot, sinceCommit, filePath) => {
    const key = `${sinceCommit ?? ""}\u0000${filePath}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = countCommitsSince(repoRoot, sinceCommit, filePath);
      cache.set(key, hit);
    }
    return hit;
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function checkEntries(repoRoot: string, entries: MemoryEntry[]): Promise<EntryStaleness[]> {
  const countCommits = memoizedCounter();
  return mapLimit(entries, CHECK_CONCURRENCY, (e) => checkEntry(repoRoot, e, countCommits));
}
