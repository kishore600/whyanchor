import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CaptureError, captureEntry } from "../core/capture.js";
import { normalizeRef, parseRef } from "../core/fingerprint.js";
import { findRelatedEntries } from "../core/graph.js";
import { getRepoRoot } from "../core/git.js";
import { rankEntries } from "../core/search.js";
import { checkEntries } from "../core/staleness.js";
import { loadEntries, memoryDir, storeExists } from "../core/store.js";
import type { MemoryEntry } from "../core/schema.js";
import { getVersion } from "../core/version.js";

const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_RELATED_LIMIT = 10;

function summarize(entry: MemoryEntry): Record<string, unknown> {
  const { id, title, date, author, tags, refs, status, supersedes } = entry.frontmatter;
  const firstLine = entry.body.split("\n").find((l) => l.trim().length > 0) ?? "";
  return { id, title, date, author, tags, refs, status, supersedes, summary: firstLine };
}

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}

// Default filesystems on Windows and macOS are case-insensitive, so `src/Billing.ts` is the file
// a ref spelled `src/billing.ts` points at.
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";
const samePath = (a: string, b: string): boolean => (CASE_INSENSITIVE_FS ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Builds the MCP server for the memory store in `repoRoot`, without connecting a transport. */
export function createMcpServer(repoRoot: string, launchedFrom: string = repoRoot): McpServer {
  const server = new McpServer({ name: "whyanchor", version: getVersion() });

  // Unreadable entries are skipped (one bad file must not break every tool) but reported once each
  // on stderr, which MCP clients surface in their server logs — stdout carries the protocol.
  const reported = new Set<string>();
  async function load(): Promise<MemoryEntry[] | string> {
    if (!(await storeExists(repoRoot))) {
      // Without this, every read tool answers `[]` — indistinguishable from "nothing recorded" —
      // when the real problem is that the agent launched the server outside the repo.
      return (
        `No whyanchor memory store at ${memoryDir(repoRoot)}. If this project has one, the MCP server ` +
        `was started outside it (working directory: ${launchedFrom}) — configure the agent to launch ` +
        "it from the project directory. Otherwise run `whyanchor init` in the repo."
      );
    }
    const { entries, invalid } = await loadEntries(repoRoot);
    for (const bad of invalid) {
      if (reported.has(bad.filePath)) continue;
      reported.add(bad.filePath);
      console.error(`whyanchor: skipping unreadable entry ${bad.filePath} — ${bad.error}`);
    }
    return entries;
  }

  server.tool(
    "search_memory",
    "Search captured project memory (decisions, context, gotchas) by keyword and/or tag, ranked by " +
      "relevance (local lexical scoring over title, tags, refs and body — no embeddings, no network " +
      "calls). Use this before making an architectural decision or touching an unfamiliar area of the repo.",
    {
      query: z.string().optional().describe("Free-text search over titles, tags, refs and body"),
      tag: z.string().optional().describe("Filter to entries with this tag"),
      limit: z.number().int().positive().optional().describe(`Max results to return (default ${DEFAULT_SEARCH_LIMIT})`),
    },
    async ({ query, tag, limit }) => {
      const loaded = await load();
      if (typeof loaded === "string") return errorResult(loaded);
      let entries = loaded.filter((e) => e.frontmatter.status !== "superseded");
      if (tag) entries = entries.filter((e) => e.frontmatter.tags.includes(tag));

      const results = query
        ? rankEntries(entries, query)
            .filter((r) => r.score > 0)
            .map((r) => r.entry)
        : entries;
      return textResult(results.slice(0, limit ?? DEFAULT_SEARCH_LIMIT).map(summarize));
    }
  );

  server.tool(
    "get_related_memory",
    "Find memory entries related to one you already have, via shared file/symbol references, shared " +
      "tags, or a supersedes relationship — the same connections `whyanchor viewgraph` draws as edges. " +
      "Use this to discover connected decisions without re-searching or scanning the whole store. Works " +
      "for superseded entries too: the entry that replaced one comes back via its supersedes chain.",
    {
      id: z.string().describe("The memory entry id to find related entries for, e.g. mem_a8AwCAoR"),
      limit: z.number().int().positive().optional().describe(`Max related entries to return (default ${DEFAULT_RELATED_LIMIT})`),
    },
    async ({ id, limit }) => {
      const loaded = await load();
      if (typeof loaded === "string") return errorResult(loaded);
      if (!loaded.some((e) => e.frontmatter.id === id)) return errorResult(`No entry with id ${id}`);
      // Superseded entries only count through the supersedes chain itself — that link is the point
      // ("this replaced mem_X, which said ..."); matching them on files or tags would resurface
      // outdated decisions.
      const related = findRelatedEntries(loaded, id, Number.POSITIVE_INFINITY)
        .filter((r) => r.entry.frontmatter.status !== "superseded" || r.reasons.includes("supersedes chain"))
        .slice(0, limit ?? DEFAULT_RELATED_LIMIT);
      return textResult(related.map((r) => ({ ...summarize(r.entry), relatedness: r.score, reasons: r.reasons })));
    }
  );

  server.tool(
    "get_memory_for_file",
    "Retrieve memory entries anchored to a specific file. Call this when opening or editing a file to " +
      "surface prior decisions and context about it before making changes. Accepts a repo-relative or " +
      "absolute path; append #symbol (e.g. src/billing.ts#calculateTax) to narrow to notes on that " +
      "symbol plus notes on the whole file.",
    { path: z.string().describe("File path, e.g. src/billing.ts or src/billing.ts#calculateTax") },
    async ({ path: input }) => {
      const loaded = await load();
      if (typeof loaded === "string") return errorResult(loaded);
      const wanted = parseRef(normalizeRef(repoRoot, input));
      const matches = loaded.filter(
        (e) =>
          e.frontmatter.status !== "superseded" &&
          e.frontmatter.refs.some((r) => {
            const ref = parseRef(normalizeRef(repoRoot, r));
            if (!samePath(ref.file, wanted.file)) return false;
            // A whole-file note applies to every symbol in it.
            return !wanted.symbol || !ref.symbol || ref.symbol === wanted.symbol;
          })
      );
      return textResult(matches.map((e) => ({ ...summarize(e), body: e.body })));
    }
  );

  server.tool(
    "get_memory_entry",
    "Fetch the full content of one memory entry by id, including what it supersedes and what (if " +
      "anything) superseded it.",
    { id: z.string() },
    async ({ id }) => {
      const loaded = await load();
      if (typeof loaded === "string") return errorResult(loaded);
      const entry = loaded.find((e) => e.frontmatter.id === id);
      if (!entry) return errorResult(`No entry with id ${id}`);
      const supersededBy = loaded.filter((e) => e.frontmatter.supersedes === id).map((e) => e.frontmatter.id);
      return textResult({ ...summarize(entry), superseded_by: supersededBy, body: entry.body });
    }
  );

  server.tool(
    "list_stale_memory",
    "Run the fast-tier staleness check and return entries whose referenced code has likely drifted. " +
      "Use this to sanity-check whether memory you're about to rely on is still trustworthy.",
    {},
    async () => {
      const loaded = await load();
      if (typeof loaded === "string") return errorResult(loaded);
      const active = loaded.filter((e) => e.frontmatter.status !== "superseded");
      const results = await checkEntries(repoRoot, active);
      const flagged = results.filter((r) => r.level === "high" || r.level === "missing");
      return textResult(
        flagged.map((r) => ({
          ...summarize(r.entry),
          level: r.level,
          refs: r.refs.filter((ref) => ref.level !== "fresh"),
        }))
      );
    }
  );

  server.tool(
    "capture_memory",
    "Record a new memory entry: a decision, gotcha, or piece of context worth remembering about this repo. " +
      "The entry is written as a git-tracked markdown file for the developer to review at commit time — it is " +
      "never committed automatically. Use this when you and the user land on a non-obvious decision, or the " +
      "user tells you something explicitly worth remembering. When it corrects or replaces an existing entry " +
      "(e.g. one list_stale_memory flagged), pass that entry's id as `supersedes`.",
    {
      title: z.string().trim().min(1).describe("One-line summary"),
      body: z.string().trim().min(1).describe("A few sentences of context — the why, not just the what"),
      refs: z.array(z.string()).default([]).describe("Anchoring refs, e.g. ['src/billing.ts#calculateTax']"),
      tags: z.array(z.string()).default([]),
      supersedes: z.string().optional().describe("Id of an existing entry this one replaces; it is marked superseded"),
    },
    async ({ title, body, refs, tags, supersedes }) => {
      if (!(await storeExists(repoRoot))) return errorResult((await load()) as string);
      try {
        const result = await captureEntry(repoRoot, { title, body, refs, tags, supersedes, viaAgent: true });
        const warnings: string[] = [];
        if (result.unresolvedRefs.length) {
          warnings.push(`File not found, so these refs can't be checked for staleness: ${result.unresolvedRefs.join(", ")}`);
        }
        if (result.wholeFileRefs.length) {
          warnings.push(`Symbol not found, watching the whole file instead: ${result.wholeFileRefs.join(", ")}`);
        }
        if (result.outsideRepoRefs.length) warnings.push(`Refs outside the repository: ${result.outsideRepoRefs.join(", ")}`);
        if (result.alreadySupersededBy.length) {
          warnings.push(
            `${supersedes} had already been superseded by ${result.alreadySupersededBy.join(", ")}; more than one ` +
              "active entry now replaces it."
          );
        }
        return textResult({
          created: result.entry.frontmatter.id,
          filePath: result.entry.filePath,
          refs: result.entry.frontmatter.refs,
          superseded: result.superseded?.frontmatter.id,
          warnings,
        });
      } catch (err) {
        if (err instanceof CaptureError) return errorResult(err.message);
        throw err;
      }
    }
  );

  return server;
}

export async function startMcpServer(cwd: string): Promise<void> {
  const repoRoot = (await getRepoRoot(cwd)) ?? cwd;
  const server = createMcpServer(repoRoot, cwd);
  await server.connect(new StdioServerTransport());
}
