import { z } from "zod";

// Entries are meant to be hand-editable, but YAML types unquoted scalars: `date: 2026-09-21` (the
// README's own example) parses as a Date, `commit: 1234567` as a number. Accept those and store
// them as the strings the tool itself writes, instead of rejecting a perfectly readable file.
function scalarToString(value: unknown, dateOnly: boolean): unknown {
  if (value instanceof Date) return dateOnly ? value.toISOString().slice(0, 10) : value.toISOString();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return value;
}
const looseString = () => z.preprocess((v) => scalarToString(v, false), z.string());
const looseDate = () => z.preprocess((v) => scalarToString(v, true), z.string());
// `tags: pricing` is as natural to hand-write as `tags: [pricing]`.
const looseStringList = () =>
  z.preprocess((v) => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]), z.array(looseString()));

export const StatusEnum = z.enum(["active", "stale", "superseded"]);
export type Status = z.infer<typeof StatusEnum>;

export const FingerprintEntrySchema = z.object({
  hash: looseString(),
  kind: z.enum(["symbol", "file", "missing"]),
});
export type FingerprintEntry = z.infer<typeof FingerprintEntrySchema>;

export const MemoryFrontmatterSchema = z.object({
  id: looseString(),
  title: looseString(),
  date: looseDate(),
  author: looseString(),
  tags: looseStringList().default([]),
  refs: looseStringList().default([]),
  supersedes: looseString().nullable().default(null),
  status: StatusEnum.default("active"),
  commit: looseString().nullable().default(null),
  fingerprint: z
    .record(z.string(), FingerprintEntrySchema)
    .nullable()
    .default({})
    .transform((v) => v ?? {}),
  last_checked: z.preprocess((v) => scalarToString(v, false), z.string().nullable()).default(null),
});
export type MemoryFrontmatter = z.infer<typeof MemoryFrontmatterSchema>;

export interface MemoryEntry {
  frontmatter: MemoryFrontmatter;
  body: string;
  /** Absolute path to the entry's .md file on disk. */
  filePath: string;
}

export const CONFIG_SCHEMA_VERSION = 1;

export interface StoreConfig {
  schemaVersion: number;
  createdAt: string;
}
