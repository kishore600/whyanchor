import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { dominantEol, upsertMarkedSection, type UpsertResult } from "./agentsFile.js";

export const SERVER_NAME = "whyanchor";

export const USAGE_START = "<!-- whyanchor:usage:start -->";
export const USAGE_END = "<!-- whyanchor:usage:end -->";
const MEMORY_START = "<!-- whyanchor:start -->";

export interface ServerCommand {
  command: string;
  args: string[];
}

export type Agent = "claude" | "cursor" | "codex";

export interface ConnectResult {
  agent: Agent;
  filePath: string;
  action: "created" | "updated" | "unchanged";
}

/** An existing agent config that can't be merged safely — refused rather than overwritten. */
export class ConfigError extends Error {}

/**
 * The command a spawned MCP client should run. Defaults to the absolute path of the
 * currently-executing CLI, which works regardless of how whyanchor was installed
 * (linked globally, cloned from source, or referenced by path from another repo).
 */
export function defaultServerCommand(cliPath: string): ServerCommand {
  return { command: "node", args: [cliPath, "mcp"] };
}

/**
 * Whether the CLI is running out of a package manager's throwaway cache — `npx`'s `_npx/`,
 * `pnpm dlx` / `yarn dlx`, `bunx` — a path that stops existing whenever that cache is pruned,
 * so it must never be written into an agent config.
 */
export function isEphemeralInstall(cliPath: string): boolean {
  return cliPath.split(/[\\/]+/).some((segment) => segment === "_npx" || /^dlx(?:-|$)/.test(segment) || segment.startsWith("bunx-"));
}

/**
 * Launch the server through npx, independent of any one install location. On native Windows npx
 * is a `.cmd` shim that MCP clients can't spawn directly, so it goes through `cmd /c`.
 */
export function npxServerCommand(platform: NodeJS.Platform = process.platform): ServerCommand {
  const npx = ["npx", "-y", SERVER_NAME, "mcp"];
  return platform === "win32" ? { command: "cmd", args: ["/c", ...npx] } : { command: npx[0], args: npx.slice(1) };
}

/** Splits a `--command` string into argv, honoring quotes: `node "C:\Program Files\x\cli.js" mcp`. */
export function parseCommand(input: string): ServerCommand | null {
  const parts = [...input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  if (parts.length === 0) return null;
  return { command: parts[0], args: parts.slice(1) };
}

/** Renders a command for display, quoting any argument that contains whitespace. */
export function formatCommand(server: ServerCommand): string {
  return [server.command, ...server.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
}

function mcpJsonPath(repoRoot: string, agent: "claude" | "cursor"): string {
  return agent === "claude" ? path.join(repoRoot, ".mcp.json") : path.join(repoRoot, ".cursor", "mcp.json");
}

/** Merges the server into a JSON MCP config, preserving every other server already configured. */
export async function connectJsonAgent(
  repoRoot: string,
  agent: "claude" | "cursor",
  server: ServerCommand
): Promise<ConnectResult> {
  const filePath = mcpJsonPath(repoRoot, agent);

  let raw: string | null = null;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    raw = null;
  }

  let config: Record<string, unknown> = {};
  if (raw !== null) {
    let parsed: unknown;
    try {
      // Windows editors (and PowerShell 5.1's Out-File) save UTF-8 with a BOM, which JSON.parse rejects.
      parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    } catch {
      // The file is there but unparseable — refuse rather than overwrite someone's config.
      throw new ConfigError(`${filePath} exists but is not valid JSON. Fix or remove it, then re-run.`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConfigError(`${filePath} is valid JSON but not an object. Fix or remove it, then re-run.`);
    }
    config = parsed as Record<string, unknown>;
  }

  const rawServers = config.mcpServers;
  if (rawServers !== undefined && (!rawServers || typeof rawServers !== "object" || Array.isArray(rawServers))) {
    throw new ConfigError(`${filePath} has an "mcpServers" value that is not an object. Fix or remove it, then re-run.`);
  }
  const servers = (rawServers ?? {}) as Record<string, Record<string, unknown>>;
  const current = servers[SERVER_NAME];
  if (current && current.command === server.command && JSON.stringify(current.args) === JSON.stringify(server.args)) {
    return { agent, filePath, action: "unchanged" };
  }

  // Keep anything else the user put on our entry (`env`, `type`, ...); only the launch command is ours.
  servers[SERVER_NAME] = { ...(current ?? {}), command: server.command, args: server.args };
  config.mcpServers = servers;

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return { agent, filePath, action: raw !== null ? "updated" : "created" };
}

function tomlTable(server: ServerCommand): string {
  const args = server.args.map((a) => JSON.stringify(a)).join(", ");
  return [`[mcp_servers.${SERVER_NAME}]`, `command = ${JSON.stringify(server.command)}`, `args = [${args}]`].join("\n");
}

// `[mcp_servers.whyanchor]`, `[ mcp_servers."whyanchor" ]` and `[mcp_servers.'whyanchor']` all name
// the same table; appending a second copy would be a duplicate key, which makes the file invalid TOML.
const OUR_TOML_HEADERS = new Set([
  `[mcp_servers.${SERVER_NAME}]`,
  `[mcp_servers."${SERVER_NAME}"]`,
  `[mcp_servers.'${SERVER_NAME}']`,
]);
const TOML_TABLE_HEADER = /^\[\[?[^\]]+\]\]?\s*(?:#.*)?$/;

/**
 * Codex uses TOML, not the JSON shape Claude Code and Cursor share. A new `[table]` header
 * always opens a fresh scope, so appending is safe; an existing whyanchor table is replaced
 * in place so re-running stays idempotent.
 */
export async function connectCodex(repoRoot: string, server: ServerCommand): Promise<ConnectResult> {
  const filePath = path.join(repoRoot, ".codex", "config.toml");
  const table = tomlTable(server);

  let existing: string | null = null;
  try {
    existing = await readFile(filePath, "utf8");
  } catch {
    existing = null;
  }

  if (existing === null) {
    const header = [
      "# Project-scoped MCP config for Codex CLI. Codex only reads this for projects you've",
      "# marked as trusted — run `codex trust` on this directory once.",
      "",
    ].join("\n");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, header + table + "\n", "utf8");
    return { agent: "codex", filePath, action: "created" };
  }

  // Find the table by exact header line and run to the next table header — not by regex over
  // the raw text, because an `args = [...]` value contains '[' and would end the match early.
  const eol = dominantEol(existing);
  const text = existing.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const startLine = lines.findIndex((l) => OUR_TOML_HEADERS.has(l.replace(/\s+/g, "")));

  let next: string;
  if (startLine !== -1) {
    let endLine = lines.length;
    for (let i = startLine + 1; i < lines.length; i++) {
      if (TOML_TABLE_HEADER.test(lines[i].trim())) {
        endLine = i;
        break;
      }
    }
    const before = lines.slice(0, startLine).join("\n");
    const after = lines.slice(endLine).join("\n");
    const replaced = (before ? before + "\n" : "") + table + "\n" + (after ? "\n" + after.replace(/^\n+/, "") : "");
    if (replaced.trim() === text.trim()) return { agent: "codex", filePath, action: "unchanged" };
    next = replaced;
  } else {
    next = text.trimEnd() + "\n\n" + table + "\n";
  }

  await writeFile(filePath, eol === "\r\n" ? next.replace(/\n/g, "\r\n") : next, "utf8");
  return { agent: "codex", filePath, action: "updated" };
}

export const CURSOR_RULE_PATH = path.join(".cursor", "rules", "whyanchor.mdc");

/** Claude Code reads a project CLAUDE.md from either the repo root or `.claude/`. */
export const CLAUDE_FILE_PATH = path.join(".claude", "CLAUDE.md");
export const CLAUDE_LEGACY_ROOT_PATH = "CLAUDE.md";

/** Codex, Copilot, Gemini CLI, Windsurf and Zed all read this one, and it must sit at the repo root. */
export const AGENTS_FILE_PATH = "AGENTS.md";

/**
 * Cursor's own rules system needs a `.mdc` file with YAML frontmatter — a plain `.md` file in
 * `.cursor/rules/` is ignored outright. Only written on creation, so any `globs` or description
 * the user tunes afterwards survives regeneration.
 */
function cursorFrontmatter(): string {
  return [
    "---",
    "description: Project memory — decisions and the reasoning behind them, captured with whyanchor",
    "alwaysApply: true",
    "---",
    "",
  ].join("\n");
}

/** Ensures the Cursor rules file exists with frontmatter, and returns its absolute path. */
export async function ensureCursorRuleFile(repoRoot: string): Promise<string> {
  const filePath = path.join(repoRoot, CURSOR_RULE_PATH);
  try {
    await readFile(filePath, "utf8");
  } catch {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, cursorFrontmatter(), "utf8");
  }
  return filePath;
}

export function renderUsageSection(): string {
  return [
    USAGE_START,
    "## Working with project memory (whyanchor)",
    "",
    "This repo has the `whyanchor` MCP server registered. Use its tools proactively, don't wait",
    "to be asked:",
    "",
    "- **Before editing a file**, call `get_memory_for_file` with its path. Prior decisions about",
    "  that file surface there, not just in the generated snapshot below (which can lag).",
    "- **Before an architectural or otherwise non-obvious choice**, call `search_memory` first —",
    "  someone (human or a prior agent session) may have already decided this and written down why.",
    "- **When you and the user land on a decision worth remembering** — a rejected approach, a",
    "  non-obvious constraint, a \"why we didn't just do X\" — call `capture_memory`. It writes a",
    "  git-tracked markdown file; it never commits on its own, so the user reviews it like any",
    "  other change before it lands. If it replaces an earlier entry, pass that entry's id as",
    "  `supersedes`.",
    "- **Before relying on an entry for something risky**, call `list_stale_memory` to check whether",
    "  the code it references has drifted since it was written.",
    "",
    "Command-line equivalents, for when MCP isn't available: `whyanchor capture`, `whyanchor check`,",
    "`whyanchor list`.",
    "",
    "Generated by `whyanchor connect` — edit freely, it is only rewritten if you re-run that command.",
    USAGE_END,
  ].join("\n");
}

/** Writes the agent usage instructions above the generated memory block, if one exists. */
export async function writeUsageInstructions(repoRoot: string, fileName: string): Promise<UpsertResult> {
  const filePath = path.join(repoRoot, fileName);
  await mkdir(path.dirname(filePath), { recursive: true });
  return upsertMarkedSection(filePath, renderUsageSection(), {
    startMarker: USAGE_START,
    endMarker: USAGE_END,
    insertBefore: MEMORY_START,
  });
}

/**
 * Claude Code loads BOTH `./CLAUDE.md` and `./.claude/CLAUDE.md` when both exist, so a leftover
 * root file would inject every note twice. Returns true when one is present and ours.
 */
export async function hasLegacyRootClaudeFile(repoRoot: string): Promise<boolean> {
  try {
    const content = await readFile(path.join(repoRoot, CLAUDE_LEGACY_ROOT_PATH), "utf8");
    return content.includes(MEMORY_START) || content.includes(USAGE_START);
  } catch {
    return false;
  }
}
