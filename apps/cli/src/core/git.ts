import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const out = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return out === "true";
}

export async function getRepoRoot(cwd: string): Promise<string | null> {
  const out = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return out || null;
}

export async function getGitAuthor(cwd: string): Promise<string> {
  const email = await git(cwd, ["config", "user.email"]);
  if (email) return email;
  const name = await git(cwd, ["config", "user.name"]);
  return name || "unknown";
}

export async function getCurrentCommit(cwd: string): Promise<string | null> {
  const out = await git(cwd, ["rev-parse", "HEAD"]);
  return out || null;
}

/** Whether `sha` names a commit in this repository's object database. */
export async function commitExists(cwd: string, sha: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Number of commits that touched `filePath` between `sinceCommit` (exclusive) and HEAD
 * (inclusive) — or null when `sinceCommit` is not in this clone's history (rewritten by a rebase
 * or squash, or cut off by a shallow clone), where the count is unknowable rather than zero.
 * `rev-list --count` prints a single number, so a long history can't overflow execFile's buffer.
 */
export async function countCommitsSince(
  cwd: string,
  sinceCommit: string | null,
  filePath: string
): Promise<number | null> {
  if (sinceCommit && !(await commitExists(cwd, sinceCommit))) return null;
  const range = sinceCommit ? `${sinceCommit}..HEAD` : "HEAD";
  const count = Number.parseInt(await git(cwd, ["rev-list", "--count", range, "--", filePath]), 10);
  return Number.isNaN(count) ? 0 : count;
}
