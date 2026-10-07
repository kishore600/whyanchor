import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { nanoid } from "nanoid";
import { ZodError } from "zod";
import {
  CONFIG_SCHEMA_VERSION,
  MemoryFrontmatterSchema,
  type MemoryEntry,
  type MemoryFrontmatter,
  type StoreConfig,
} from "./schema.js";

export const MEMORY_DIR = ".memory";
export const ENTRIES_DIR = "entries";
export const CONFIG_FILE = "config.json";
// git doesn't track empty directories: without a placeholder, committing a fresh store and cloning
// it yields a .memory/ with no entries/ folder in it.
export const ENTRIES_PLACEHOLDER = ".gitkeep";

export function memoryDir(repoRoot: string): string {
  return path.join(repoRoot, MEMORY_DIR);
}

export function entriesDir(repoRoot: string): string {
  return path.join(memoryDir(repoRoot), ENTRIES_DIR);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function storeExists(repoRoot: string): Promise<boolean> {
  return exists(memoryDir(repoRoot));
}

/**
 * Creates whatever part of the store is missing — entries/, its .gitkeep, config.json — and
 * returns the paths it created. Never overwrites: re-running on a complete store is a no-op, and
 * running it on a store cloned without its (empty, untracked) entries/ folder repairs it.
 */
export async function initStore(repoRoot: string): Promise<string[]> {
  const created: string[] = [];
  const dir = entriesDir(repoRoot);
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
    created.push(dir);
  }
  const placeholder = path.join(dir, ENTRIES_PLACEHOLDER);
  if (!(await exists(placeholder))) {
    await writeFile(placeholder, "", "utf8");
    created.push(placeholder);
  }
  const configPath = path.join(memoryDir(repoRoot), CONFIG_FILE);
  if (!(await exists(configPath))) {
    const config: StoreConfig = { schemaVersion: CONFIG_SCHEMA_VERSION, createdAt: new Date().toISOString() };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    created.push(configPath);
  }
  return created;
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
  // A title with no ASCII letters or digits at all (e.g. entirely in Japanese) would otherwise
  // leave an empty slug and a `2026-09-27--mem_x.md` file name.
  return slug || "entry";
}

export function entryFileName(date: string, title: string, id: string): string {
  return `${date}-${slugify(title)}-${id}.md`;
}

export function newId(): string {
  return `mem_${nanoid(8)}`;
}

/** Today as YYYY-MM-DD in the local timezone — the day the author actually wrote the note. */
export function localDate(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export async function writeEntry(
  repoRoot: string,
  frontmatter: Omit<MemoryFrontmatter, "id" | "date"> & { id?: string; date?: string },
  body: string
): Promise<MemoryEntry> {
  const id = frontmatter.id ?? newId();
  const date = frontmatter.date ?? localDate();
  const full: MemoryFrontmatter = MemoryFrontmatterSchema.parse({ ...frontmatter, id, date });

  const dir = entriesDir(repoRoot);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, entryFileName(date, full.title, id));
  const content = matter.stringify(body.trim() + "\n", full);
  await writeFile(filePath, content, "utf8");
  return { frontmatter: full, body: body.trim(), filePath };
}

export async function updateEntryFrontmatter(
  entry: MemoryEntry,
  patch: Partial<MemoryFrontmatter>
): Promise<MemoryEntry> {
  const next = MemoryFrontmatterSchema.parse({ ...entry.frontmatter, ...patch });
  const content = matter.stringify(entry.body.trim() + "\n", next);
  await writeFile(entry.filePath, content, "utf8");
  return { ...entry, frontmatter: next };
}

export async function readEntryFile(filePath: string): Promise<MemoryEntry> {
  const raw = await readFile(filePath, "utf8");
  const parsed = matter(raw);
  const frontmatter = MemoryFrontmatterSchema.parse(parsed.data);
  return { frontmatter, body: parsed.content.trim(), filePath };
}

export interface InvalidEntry {
  filePath: string;
  error: string;
}

export interface LoadedEntries {
  entries: MemoryEntry[];
  /** Entry files that could not be parsed — reported, never silently dropped. */
  invalid: InvalidEntry[];
}

function describeError(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues.map((i) => `${i.path.join(".") || "frontmatter"}: ${i.message}`).join("; ");
  }
  // js-yaml puts a multi-line code excerpt after the first line of its message ("… column 13:").
  return (err instanceof Error ? err.message : String(err)).split("\n")[0].replace(/:\s*$/, "");
}

/** Newest first; ties broken by title then id so the order is identical on every filesystem. */
function compareEntries(a: MemoryEntry, b: MemoryEntry): number {
  const fa = a.frontmatter;
  const fb = b.frontmatter;
  if (fa.date !== fb.date) return fa.date < fb.date ? 1 : -1;
  if (fa.title !== fb.title) return fa.title < fb.title ? -1 : 1;
  return fa.id < fb.id ? -1 : fa.id > fb.id ? 1 : 0;
}

/**
 * Reads every entry, isolating failures: one unparseable file (a merge conflict in its
 * frontmatter, a hand-edit gone wrong) is returned in `invalid` instead of taking down every
 * command — callers are expected to report those loudly.
 */
export async function loadEntries(repoRoot: string): Promise<LoadedEntries> {
  const dir = entriesDir(repoRoot);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return { entries: [], invalid: [] };
  }
  const results = await Promise.all(
    files
      .filter((f) => f.endsWith(".md"))
      .map(async (f) => {
        const filePath = path.join(dir, f);
        try {
          return { entry: await readEntryFile(filePath) };
        } catch (err) {
          return { invalid: { filePath, error: describeError(err) } };
        }
      })
  );
  const entries = results.flatMap((r) => (r.entry ? [r.entry] : []));
  const invalid = results.flatMap((r) => (r.invalid ? [r.invalid] : []));
  entries.sort(compareEntries);
  return { entries, invalid };
}

export async function listEntries(repoRoot: string): Promise<MemoryEntry[]> {
  return (await loadEntries(repoRoot)).entries;
}

export async function findEntryById(repoRoot: string, id: string): Promise<MemoryEntry | null> {
  const entries = await listEntries(repoRoot);
  return entries.find((e) => e.frontmatter.id === id) ?? null;
}
