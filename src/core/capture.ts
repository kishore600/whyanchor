import path from "node:path";
import { computeFingerprints, normalizeRef, parseRef, toStoredFingerprints } from "./fingerprint.js";
import { getCurrentCommit, getGitAuthor } from "./git.js";
import type { MemoryEntry } from "./schema.js";
import { listEntries, updateEntryFrontmatter, writeEntry } from "./store.js";

/** A capture that was refused before anything was written (bad input, unknown supersedes id). */
export class CaptureError extends Error {}

export interface CaptureInput {
  title: string;
  body: string;
  refs?: string[];
  tags?: string[];
  /** Id of an earlier entry this one replaces; it is marked superseded. */
  supersedes?: string | null;
  /** Written by an agent over MCP rather than typed by the developer. */
  viaAgent?: boolean;
}

export interface CaptureResult {
  entry: MemoryEntry;
  /** The entry that was replaced, when `supersedes` was given. */
  superseded: MemoryEntry | null;
  /** Ids of entries that had already superseded the replaced one — the chain now forks. */
  alreadySupersededBy: string[];
  /** Refs whose file does not exist; recorded, but reported missing by every check. */
  unresolvedRefs: string[];
  /** Symbol refs whose symbol could not be located, so the whole file is watched instead. */
  wholeFileRefs: string[];
  /** Refs that point outside the repository. */
  outsideRepoRefs: string[];
}

const unique = (values: string[]): string[] => [...new Set(values)];

export interface SupersedeTarget {
  prior: MemoryEntry;
  alreadySupersededBy: string[];
}

/** Looks up the entry a new capture would supersede, or throws CaptureError if there is none. */
export async function findSupersedeTarget(repoRoot: string, id: string, entries?: MemoryEntry[]): Promise<SupersedeTarget> {
  const all = entries ?? (await listEntries(repoRoot));
  const prior = all.find((e) => e.frontmatter.id === id);
  if (!prior) throw new CaptureError(`No memory entry found with id "${id}".`);
  const alreadySupersededBy = all.filter((e) => e.frontmatter.supersedes === id).map((e) => e.frontmatter.id);
  return { prior, alreadySupersededBy };
}

/**
 * The one capture path shared by `whyanchor capture` and the MCP `capture_memory` tool:
 * normalizes refs, fingerprints them, writes the entry and marks a superseded entry — so the CLI
 * and agents get the same validation and the same warnings.
 */
export async function captureEntry(repoRoot: string, input: CaptureInput): Promise<CaptureResult> {
  // A title is one line: shown in lists, reports and the generated files' bullet points.
  const title = input.title.replace(/\s+/g, " ").trim();
  const body = input.body.trim();
  if (!title) throw new CaptureError("A title is required.");
  if (!body) throw new CaptureError("A body (the why, not just the what) is required.");

  const target = input.supersedes ? await findSupersedeTarget(repoRoot, input.supersedes) : null;

  const refs = unique((input.refs ?? []).map((r) => normalizeRef(repoRoot, r)).filter(Boolean));
  const tags = unique((input.tags ?? []).map((t) => t.trim()).filter(Boolean));

  const [author, commit, fingerprints] = await Promise.all([
    getGitAuthor(repoRoot),
    getCurrentCommit(repoRoot),
    computeFingerprints(repoRoot, refs),
  ]);

  const entry = await writeEntry(
    repoRoot,
    {
      title,
      author: input.viaAgent ? `${author} (via agent)` : author,
      tags,
      refs,
      supersedes: target?.prior.frontmatter.id ?? null,
      status: "active",
      commit,
      fingerprint: toStoredFingerprints(fingerprints),
      last_checked: null,
    },
    body
  );

  let superseded: MemoryEntry | null = null;
  if (target) {
    superseded =
      target.prior.frontmatter.status === "superseded"
        ? target.prior
        : await updateEntryFrontmatter(target.prior, { status: "superseded" });
  }

  return {
    entry,
    superseded,
    alreadySupersededBy: target?.alreadySupersededBy ?? [],
    unresolvedRefs: refs.filter((r) => fingerprints[r].kind === "missing"),
    wholeFileRefs: refs.filter((r) => fingerprints[r].fellBack),
    outsideRepoRefs: refs.filter((r) => {
      const { file } = parseRef(r);
      return file.startsWith("../") || path.isAbsolute(file);
    }),
  };
}
