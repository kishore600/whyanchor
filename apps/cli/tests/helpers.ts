import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { vi } from "vitest";
import { initStore } from "../src/core/store.js";

const execFileAsync = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

/** A fresh temp git repo with an initialized memory store. */
export async function makeRepo(prefix: string, { withStore = true } = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  await git(dir, ["init"]);
  await git(dir, ["config", "user.email", "dev@example.com"]);
  await git(dir, ["config", "user.name", "Dev"]);
  await git(dir, ["config", "core.autocrlf", "false"]);
  if (withStore) await initStore(dir);
  return dir;
}

/** Silences console output for the test and collects it, one string per call. */
export function captureConsole(): string[] {
  const lines: string[] = [];
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  }
  return lines;
}
