import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRepoRoot, isGitRepo } from "../core/git.js";
import { storeExists } from "../core/store.js";
import {
  AGENTS_FILE_PATH,
  CLAUDE_FILE_PATH,
  ConfigError,
  connectCodex,
  connectJsonAgent,
  defaultServerCommand,
  formatCommand,
  isEphemeralInstall,
  npxServerCommand,
  parseCommand,
  writeUsageInstructions,
  type Agent,
  type ConnectResult,
  type ServerCommand,
} from "../generators/agentConfig.js";
import { MarkerError } from "../generators/agentsFile.js";
import { displayPath } from "./output.js";

export interface ConnectOptions {
  agent?: string;
  command?: string;
  noInstructions?: boolean;
  /** Overrides the running CLI's path (tests). */
  cliPath?: string;
}

const ALL_AGENTS: Agent[] = ["claude", "cursor", "codex"];

function resolveCliPath(): string {
  // The absolute path of the CLI that is running right now — works whether whyanchor was
  // globally linked, cloned from source, or referenced by path from another repo.
  return path.resolve(fileURLToPath(new URL("../cli.js", import.meta.url)));
}

function parseAgents(input?: string): Agent[] | null {
  if (!input || input === "all") return ALL_AGENTS;
  const requested = input
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const invalid = requested.filter((a) => !ALL_AGENTS.includes(a as Agent));
  if (invalid.length) return null;
  return requested as Agent[];
}

function fail(message: string): void {
  console.error(`✖ ${message}`);
  process.exitCode = 1;
}

export async function runConnect(cwd: string, opts: ConnectOptions): Promise<void> {
  if (!(await isGitRepo(cwd))) {
    fail("Not a git repository. whyanchor is git-backed — run `git init` first.");
    return;
  }

  const repoRoot = (await getRepoRoot(cwd)) ?? cwd;

  if (!(await storeExists(repoRoot))) {
    fail("No memory store found. Run `whyanchor init` first.");
    return;
  }

  const agents = parseAgents(opts.agent);
  if (!agents) {
    fail(`Unknown agent. Use one or more of: ${ALL_AGENTS.join(", ")} (or "all").`);
    return;
  }

  let server: ServerCommand;
  let note: string | null = null;
  if (opts.command !== undefined) {
    const parsed = parseCommand(opts.command);
    if (!parsed) {
      fail("--command is empty.");
      return;
    }
    server = parsed;
  } else {
    const cliPath = opts.cliPath ?? resolveCliPath();
    if (isEphemeralInstall(cliPath)) {
      // The README's own quick start is `npx whyanchor ...`: registering this run's path would point
      // every agent at a cache directory that npx prunes, and the server would silently vanish.
      server = npxServerCommand();
      note =
        "whyanchor is running from a temporary package cache, so its path would stop resolving once " +
        `that cache is pruned — registered "${formatCommand(server)}" instead. Pass --command to override.`;
    } else {
      server = defaultServerCommand(cliPath);
    }
  }

  // Each agent's config is independent: one unmergeable file must not stop the others.
  let failures = 0;
  for (const agent of agents) {
    try {
      const r: ConnectResult =
        agent === "codex" ? await connectCodex(repoRoot, server) : await connectJsonAgent(repoRoot, agent, server);
      console.log(`✔ ${r.agent.padEnd(6)} ${r.action.padEnd(9)} ${displayPath(repoRoot, r.filePath)}`);
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      failures++;
      console.error(`✖ ${agent.padEnd(6)} ${err.message}`);
    }
  }

  if (!opts.noInstructions) {
    for (const fileName of [CLAUDE_FILE_PATH, AGENTS_FILE_PATH]) {
      try {
        const action = await writeUsageInstructions(repoRoot, fileName);
        console.log(`✔ ${"docs".padEnd(6)} ${action.padEnd(9)} ${displayPath(repoRoot, path.join(repoRoot, fileName))}`);
      } catch (err) {
        if (!(err instanceof MarkerError)) throw err;
        failures++;
        console.error(`✖ ${"docs".padEnd(6)} ${err.message}`);
      }
    }
  }

  console.log("");
  console.log(`Registered as "${formatCommand(server)}".`);
  if (note) console.log(note);
  console.log("Restart your agent (or reopen the project) to pick up the new MCP server.");
  if (agents.includes("codex")) {
    console.log("Codex only reads project config for trusted projects — run `codex trust` here once.");
  }
  if (failures) process.exitCode = 1;
}
