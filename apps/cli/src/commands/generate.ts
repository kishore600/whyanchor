import { mkdir } from "node:fs/promises";
import path from "node:path";
import { getRepoRoot } from "../core/git.js";
import { loadEntries, storeExists } from "../core/store.js";
import {
  AGENTS_FILE_PATH,
  CLAUDE_FILE_PATH,
  CLAUDE_LEGACY_ROOT_PATH,
  CURSOR_RULE_PATH,
  ensureCursorRuleFile,
  hasLegacyRootClaudeFile,
} from "../generators/agentConfig.js";
import { fileExists, MarkerError, renderMemorySection, upsertMemorySection } from "../generators/agentsFile.js";
import { displayPath, warnInvalidEntries } from "./output.js";

export type GenerateTarget = "claude" | "agents" | "cursor" | "all";

export interface GenerateOptions {
  target?: GenerateTarget;
}

export const GENERATE_TARGETS: GenerateTarget[] = ["claude", "agents", "cursor", "all"];

const TARGET_PATHS: Record<Exclude<GenerateTarget, "all">, string> = {
  claude: CLAUDE_FILE_PATH,
  agents: AGENTS_FILE_PATH,
  cursor: CURSOR_RULE_PATH,
};

const LABEL = { created: "Created", updated: "Updated", unchanged: "Unchanged" } as const;

export async function runGenerate(cwd: string, opts: GenerateOptions): Promise<void> {
  const repoRoot = (await getRepoRoot(cwd)) ?? cwd;

  if (!(await storeExists(repoRoot))) {
    console.error("✖ No memory store found. Run `whyanchor init` first.");
    process.exitCode = 1;
    return;
  }

  const target = opts.target ?? "all";
  if (!GENERATE_TARGETS.includes(target)) {
    console.error(`✖ Unknown target "${target}". Use one of: ${GENERATE_TARGETS.join(", ")}.`);
    process.exitCode = 1;
    return;
  }

  const { entries, invalid } = await loadEntries(repoRoot);
  warnInvalidEntries(repoRoot, invalid);
  const section = renderMemorySection(entries);

  const targets: Exclude<GenerateTarget, "all">[] =
    target === "all" ? ["claude", "agents", "cursor"] : [target];

  for (const t of targets) {
    const filePath = path.join(repoRoot, TARGET_PATHS[t]);
    try {
      const existedBefore = await fileExists(filePath);
      if (t === "cursor") {
        await ensureCursorRuleFile(repoRoot);
      } else {
        await mkdir(path.dirname(filePath), { recursive: true });
      }
      const result = await upsertMemorySection(filePath, section);
      console.log(`✔ ${existedBefore ? LABEL[result] : LABEL.created} ${displayPath(repoRoot, filePath)}`);
    } catch (err) {
      // One damaged file shouldn't stop the other targets from being written.
      if (!(err instanceof MarkerError)) throw err;
      console.error(`✖ ${err.message}`);
      process.exitCode = 1;
    }
  }

  if (targets.includes("claude") && (await hasLegacyRootClaudeFile(repoRoot))) {
    console.warn(
      `⚠ ${CLAUDE_LEGACY_ROOT_PATH} still exists at the repo root. Claude Code loads it ` +
        `alongside ${CLAUDE_FILE_PATH.replace(/\\/g, "/")}, so your notes will be injected twice — delete the root one.`
    );
  }
}
