import path from "node:path";
import type { InvalidEntry } from "../core/store.js";

/** A path for display: relative to the repo root with forward slashes, as git would show it. */
export function displayPath(repoRoot: string, filePath: string): string {
  const rel = path.relative(repoRoot, filePath);
  return (rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : filePath).replace(/\\/g, "/");
}

/** Unreadable entries are skipped so one bad file can't take a command down — but never quietly. */
export function warnInvalidEntries(repoRoot: string, invalid: InvalidEntry[]): void {
  for (const bad of invalid) {
    console.warn(`⚠ Skipping unreadable entry ${displayPath(repoRoot, bad.filePath)} — ${bad.error}`);
  }
}
