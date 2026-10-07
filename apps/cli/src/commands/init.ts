import { getRepoRoot, isGitRepo } from "../core/git.js";
import { initStore, memoryDir, storeExists } from "../core/store.js";
import { displayPath } from "./output.js";

export async function runInit(cwd: string): Promise<void> {
  if (!(await isGitRepo(cwd))) {
    console.error("✖ Not a git repository. whyanchor is git-backed — run `git init` first.");
    process.exitCode = 1;
    return;
  }

  const repoRoot = (await getRepoRoot(cwd)) ?? cwd;
  const existed = await storeExists(repoRoot);
  const created = await initStore(repoRoot);

  if (existed) {
    console.log(`Memory store already exists at ${memoryDir(repoRoot)}`);
    if (created.length) {
      console.log(`✔ Restored missing ${created.map((p) => displayPath(repoRoot, p)).join(", ")}`);
    }
    return;
  }

  console.log(`✔ Initialized memory store at ${memoryDir(repoRoot)}`);
  console.log("");
  console.log("Next steps:");
  console.log("  whyanchor connect     wire the MCP server into Claude Code / Cursor / Codex");
  console.log("  whyanchor capture     capture a decision or piece of context");
  console.log("  whyanchor generate    write captured entries into CLAUDE.md / AGENTS.md");
  console.log("  whyanchor check       check captured entries for staleness");
}
