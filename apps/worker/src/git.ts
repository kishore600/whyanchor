import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The version string of the `git` on PATH. The staleness engine shells out to real git
 * (`rev-list`, `cat-file`) and the sync job runs `git clone --filter=blob:none`, so a worker
 * image without git is broken. Throws when git is missing, so the worker can fail fast on boot
 * instead of failing on the first job.
 */
export async function gitVersion(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["--version"]);
  return stdout.trim();
}
