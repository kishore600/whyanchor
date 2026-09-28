// Shared helpers for the demo scripts: builds throwaway copies of the demo billing service, with
// and without whyanchor, using the whyanchor CLI from this checkout.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const demoDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(demoDir, "..");
export const cliPath = process.env.WHYANCHOR_CLI ?? path.join(repoRoot, "dist", "cli.js");

// Three decisions a teammate recorded. Each one looks like a mistake when you only read the code.
export const TEAM_NOTES = [
  {
    title: "Enterprise discount is fixed at 30% by contract",
    message:
      "Legal signed master agreement MSA-2025-114 with our enterprise customers, and it requires exactly 30% off. " +
      "Changing the number without written sign-off from Legal (Dana Ruiz) breaches the contract.",
    refs: ["src/billing.js#calculateDiscount"],
    tags: ["pricing", "legal"],
  },
  {
    title: "Tax is rounded down to the cent on purpose",
    message:
      "Our ERP truncates tax to the cent on every invoice. If we round to the nearest cent instead, roughly a third " +
      "of invoices end up 1 cent off from the ERP and finance's monthly reconciliation fails. Keep Math.floor.",
    refs: ["src/billing.js#calculateTax"],
    tags: ["billing", "finance"],
  },
  {
    title: "PayCo sync must stay at 1 request per second",
    message:
      "PayCo bans our API account for 24 hours if we send more than 1 request per second. It happened in March 2026 " +
      "and invoicing was down for a full day. The 1100 ms sleep is deliberate headroom, so don't remove it or send " +
      "requests in parallel.",
    refs: ["src/billing.js#syncInvoices"],
    tags: ["billing", "payco"],
  },
];

// What a developer types to the agent. Identical for both folders.
export const PROMPTS = {
  cleanup: "Please clean up src/billing.js: fix anything that looks like a bug and tidy up the code.",
  discount: "For the Q4 sales push, raise the enterprise discount in src/billing.js from 30% to 35%.",
  teach:
    "Some context first: the 1100 ms sleep between PayCo calls in syncInvoices is deliberate. PayCo bans our API " +
    "account for 24 hours if we send more than 1 request per second. That happened in March and invoicing was down " +
    'for a whole day. Today\'s task: add a formatCurrency(cents) function to src/format.js that returns strings like "$12.34".',
  speedup: "Syncing invoices is too slow: 500 invoices take almost 10 minutes. Please make syncInvoices in src/billing.js faster.",
};

export function run(cmd, args, cwd, { allowFail = false } = {}) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) {
    throw new Error(`${path.basename(cmd)} ${args.join(" ")} failed in ${cwd}:\n${result.stderr || result.stdout}`);
  }
  return result;
}

export const git = (cwd, ...args) => run("git", args, cwd).stdout.trim();
export const whyanchor = (cwd, ...args) => run(process.execPath, [cliPath, ...args], cwd);

export function ensureCli() {
  if (!existsSync(cliPath)) {
    throw new Error(`whyanchor isn't built yet (${cliPath} is missing). Run "npm install && npm run build" in ${repoRoot} first.`);
  }
}

export function setIdentity(dir, email) {
  git(dir, "config", "user.email", email);
  git(dir, "config", "user.name", email.split("@")[0]);
}

export function commitAll(dir, message) {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", message);
}

/** A fresh git repo holding the demo billing service, committed as `email`. */
export function makeRepo(dir, email) {
  mkdirSync(dir, { recursive: true });
  cpSync(path.join(demoDir, "fixture"), dir, { recursive: true });
  git(dir, "-c", "init.defaultBranch=main", "init", "-q");
  git(dir, "config", "core.autocrlf", "false");
  // Entry filenames run to ~90 characters; in a deep folder on Windows that passes git's 260-char limit.
  git(dir, "config", "core.longpaths", "true");
  setIdentity(dir, email);
  commitAll(dir, "Initial billing service");
}

/** A teammate's clone of `source`, the way someone else on the team would get the repo. */
export function cloneRepo(source, dir, email) {
  run("git", ["clone", "-q", "-c", "core.autocrlf=false", "-c", "core.longpaths=true", source, dir], path.dirname(dir));
  setIdentity(dir, email);
}

/**
 * Sets whyanchor up in `dir` the way the README describes: init, record `notes`, connect Claude Code
 * (MCP server + usage instructions), and generate the memory section of CLAUDE.md.
 */
export function addWhyanchor(dir, notes = []) {
  whyanchor(dir, "init");
  for (const note of notes) {
    whyanchor(dir, "capture", "-t", note.title, "-m", note.message, "-r", ...note.refs, "--tags", ...note.tags);
  }
  const cli = cliPath.replace(/\\/g, "/");
  whyanchor(dir, "connect", "--agent", "claude", "--command", `node "${cli}" mcp`);
  whyanchor(dir, "generate", "--target", "claude");
  // Pre-approve the project's MCP server so Claude Code doesn't stop to ask when the folder is opened.
  mkdirSync(path.join(dir, ".claude"), { recursive: true });
  writeFileSync(path.join(dir, ".claude", "settings.local.json"), JSON.stringify({ enabledMcpjsonServers: ["whyanchor"] }, null, 2) + "\n");
  commitAll(dir, "Add whyanchor");
}
