import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FingerprintEntry } from "./schema.js";

export interface ParsedRef {
  file: string;
  symbol: string | null;
}

/** Parses a ref like "src/billing.ts#calculateTax" into its file and optional symbol. */
export function parseRef(ref: string): ParsedRef {
  const hashIndex = ref.indexOf("#");
  if (hashIndex === -1) return { file: ref, symbol: null };
  return { file: ref.slice(0, hashIndex), symbol: ref.slice(hashIndex + 1) || null };
}

/**
 * Canonical form of a ref's file part: repo-relative with forward slashes. "./src\\a.ts",
 * "src/a.ts" and an absolute path inside the repo all become "src/a.ts", so a ref typed on
 * Windows still resolves on macOS, and an agent that passes an absolute path still matches.
 * A path outside the repo is returned with normalized slashes but otherwise untouched.
 */
export function normalizeRefPath(repoRoot: string, file: string): string {
  let f = file.trim().replace(/\\/g, "/");
  if (path.isAbsolute(f) || /^[A-Za-z]:\//.test(f)) {
    const rel = path.relative(repoRoot, f).replace(/\\/g, "/");
    if (rel && !rel.startsWith("../") && rel !== ".." && !path.isAbsolute(rel)) f = rel;
  }
  return f.replace(/^(?:\.\/)+/, "");
}

/** Normalizes a whole ref ("file" or "file#symbol") — see normalizeRefPath. */
export function normalizeRef(repoRoot: string, ref: string): string {
  const { file, symbol } = parseRef(ref.trim());
  const normalizedFile = normalizeRefPath(repoRoot, file);
  const normalizedSymbol = symbol?.trim();
  return normalizedSymbol ? `${normalizedFile}#${normalizedSymbol}` : normalizedFile;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Line endings and a leading BOM are checkout artifacts, not code: git's core.autocrlf, editors
 * and formatters rewrite them freely, so the same commit can be LF on one machine and CRLF on
 * another. Fingerprints are taken over normalized text so a note captured on macOS is not flagged
 * stale the moment a teammate (or CI) checks the repo out with different line endings.
 */
export function normalizeContent(content: string): string {
  return content.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Identifier boundaries that, unlike \b, treat `$` as part of an identifier (valid in JS/TS).
const ID_START = "(?<![\\w$])";
const ID_END = "(?![\\w$])";

// Leading modifiers/annotations before a declaration: `export default`, `pub(crate)`,
// `public static async`, `@Override`, ... — words only, so `x = `, `obj.` or `if (` never qualify.
const MODIFIERS = "^\\s*(?:[\\w$@]+(?:\\([^)]*\\))?\\s+)*?";

const DECLARATION_KEYWORDS =
  "class|interface|type|enum|struct|trait|union|record|namespace|module|def|fn|func|fun|const|let|var|val";

// Words that start a statement or expression, never a declaration. A method-style match whose
// prefix contains one of these is a call site (`return fmt(x)`, `await save(a)`), not a definition.
const STATEMENT_WORDS = new Set([
  "return", "await", "yield", "throw", "new", "delete", "typeof", "instanceof", "in", "of", "case",
  "else", "do", "if", "while", "for", "switch", "catch", "with", "go", "defer", "echo", "print",
  "not", "and", "or", "as", "is", "elif", "lambda", "assert", "raise", "puts", "import", "from",
]);

const SIGNATURE_WINDOW = 50;

function isCommentLine(line: string): boolean {
  return /^\s*(?:\/\/|\/\*|\*|#|--|<!--)/.test(line);
}

function lineIndent(line: string): number {
  return /^[ \t]*/.exec(line)![0].length;
}

/** Index of the line holding the `}` that closes the `{` at (line, col), or -1 if never closed. */
function matchBraces(lines: string[], line: number, col: number): number {
  let depth = 0;
  for (let i = line; i < lines.length; i++) {
    const text = lines[i];
    for (let c = i === line ? col : 0; c < text.length; c++) {
      if (text[c] === "{") depth++;
      else if (text[c] === "}" && --depth === 0) return i;
    }
  }
  return -1;
}

/** Last line of an indentation-delimited body (Python/Ruby) whose header ends on `headerEnd`. */
function indentBlockEnd(lines: string[], headerEnd: number, declIndent: number): number {
  let last = headerEnd;
  for (let i = headerEnd + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (lineIndent(lines[i]) <= declIndent) break;
    last = i;
  }
  return last;
}

const CONTINUES_AT_END = /(?:[,(=:|&+\-*/<]|=>|->|\b(?:extends|implements|throws|where|with))$/;
const CONTINUES_AT_START = /^(?:[.)\]|&:?{]|=>|->|(?:throws|where|extends|implements|with)\b)/;

/**
 * Whether a declaration that reached the end of `lines[i]` (outside any parentheses, with no `{`
 * or `;` yet) carries on to the next line — an Allman brace, a wrapped `throws` clause, a trailing
 * `=>` — or ended there, like `const TAX_RATE = 0.2` in a semicolon-free file.
 */
function continuesOnNextLine(lines: string[], i: number): boolean {
  if (CONTINUES_AT_END.test(lines[i].trim())) return true;
  const next = lines[i + 1];
  return next !== undefined && next.trim() !== "" && CONTINUES_AT_START.test(next.trim());
}

type ExtentKind = "brace" | "semicolon" | "indent" | "eol" | "window" | "unbalanced";

interface Extent {
  end: number;
  kind: ExtentKind;
}

function braceExtent(lines: string[], line: number, col: number): Extent {
  const end = matchBraces(lines, line, col);
  return end === -1 ? { end: lines.length - 1, kind: "unbalanced" } : { end, kind: "brace" };
}

/**
 * Finds where the declaration whose name starts at (declIdx, startCol) ends: the matching `}` of
 * its body, a terminating `;` (a one-liner such as `const TAX_RATE = 0.2;` or a bodiless
 * overload), the end of an indented block (Python/Ruby), or the line where a brace-less
 * declaration stops. Only a `{` outside parentheses opens the body — one inside them is a
 * destructured parameter or an inline object type (`function Button({ label }: Props) {`).
 */
function declarationExtent(lines: string[], declIdx: number, startCol: number, keyword: string | null): Extent {
  const declIndent = lineIndent(lines[declIdx]);
  // Python/Ruby bodies are delimited by indentation, and a `{` in the signature is a dict literal.
  const indentDelimited = keyword === "def";
  const limit = Math.min(lines.length, declIdx + SIGNATURE_WINDOW);
  let depth = 0;
  // A `{` inside parentheses, kept as a fallback for a long wrapped expression such as
  // `memo(function App() { ... })` whose closing `)` lies beyond the search window.
  let nestedBrace: [number, number] | null = null;

  for (let i = declIdx; i < limit; i++) {
    const text = lines[i];
    for (let c = i === declIdx ? startCol : 0; c < text.length; c++) {
      const ch = text[c];
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
      else if (indentDelimited) continue;
      else if (ch === "{") {
        if (depth === 0) return braceExtent(lines, i, c);
        nestedBrace ??= [i, c];
      } else if (ch === ";" && depth === 0) {
        return { end: i, kind: "semicolon" };
      }
    }
    if (depth > 0) continue; // still inside a (possibly multi-line) parameter list or call

    const code = text.replace(/\s+#.*$/, "").trim();
    if (indentDelimited || (keyword === "class" && code.endsWith(":"))) {
      return { end: indentBlockEnd(lines, i, declIndent), kind: "indent" };
    }
    if (!continuesOnNextLine(lines, i)) return { end: i, kind: "eol" };
  }
  if (nestedBrace) return braceExtent(lines, nestedBrace[0], nestedBrace[1]);
  return { end: declIdx, kind: "window" };
}

interface Candidate {
  line: number;
  /** Column where the symbol's name starts on that line. */
  col: number;
  keyword: string | null;
}

/**
 * Lines matching `re`, skipping comments and imports. `re` must capture the symbol in a named
 * group `sym` (and may capture a declaration keyword in `kw`); it is compiled with the `d` flag
 * so the scan for the body can start at the name itself rather than the start of the line.
 */
function findCandidates(lines: string[], re: RegExp): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isCommentLine(lines[i]) || /^\s*import\b/.test(lines[i])) continue;
    const m = re.exec(lines[i]);
    const symIndex = m?.indices?.groups?.sym;
    if (m && symIndex) out.push({ line: i, col: symIndex[0], keyword: m.groups?.kw ?? null });
  }
  return out;
}

function sliceBlock(lines: string[], start: number, end: number): string {
  return lines.slice(start, end + 1).join("\n").trimEnd();
}

/** Only blank lines, comments and decorators/attributes sit between two lines. */
function onlyTriviaBetween(lines: string[], from: number, to: number): boolean {
  for (let i = from + 1; i < to; i++) {
    const t = lines[i].trim();
    if (t !== "" && !isCommentLine(lines[i]) && !t.startsWith("@") && !t.startsWith("#[")) return false;
  }
  return true;
}

/**
 * Best-effort extraction of the source block for `symbol` out of `content`, for brace-delimited
 * languages (JS/TS, Go, Java, C#, Rust, Kotlin, ...) and indentation-delimited ones (Python,
 * Ruby). Candidates are tried strongest-signal first — a declaration keyword at the start of a
 * line, then a function assigned to the name, then a method-style signature, then a plain
 * assignment — so a call site like `fmt(x) : y` never outranks the real declaration of `fmt`.
 * Returns null when no declaration can be located; callers then fall back to fingerprinting the
 * whole file.
 */
export function extractSymbolBlock(content: string, symbol: string): string | null {
  const trimmed = symbol.trim();
  if (!trimmed) return null;
  const lines = content.split("\n");
  const s = `(?<sym>${escapeRegExp(trimmed)})`;

  // Tier 1: `function foo`, `class Foo`, `func Foo`, `def foo`, `const FOO`, Go `func (r *T) Foo`, ...
  const keywordRe = new RegExp(
    `${MODIFIERS}(?:function(?:\\s*\\*\\s*|\\s+)|(?<kw>${DECLARATION_KEYWORDS})\\s+|func\\s*\\([^)]*\\)\\s*)${s}${ID_END}`,
    "d"
  );
  const keywordHits = findCandidates(lines, keywordRe);
  if (keywordHits.length) {
    const first = keywordHits[0];
    let extent = declarationExtent(lines, first.line, first.col, first.keyword);
    // TS overload signatures / C forward declarations: bodiless declarations directly followed by
    // another declaration of the same name are one unit, so fold them into the implementation.
    for (const next of keywordHits.slice(1)) {
      if (extent.kind !== "semicolon" || !onlyTriviaBetween(lines, extent.end, next.line)) break;
      extent = declarationExtent(lines, next.line, next.col, next.keyword);
    }
    return sliceBlock(lines, first.line, extent.end);
  }

  // Tier 2: a function assigned to the name — `foo = (a) =>`, `foo: function(`, `exports.foo = async (`.
  const assignedRe = new RegExp(
    `${MODIFIERS}(?:[\\w$]+\\.)*${s}\\s*[:=]\\s*(?:async\\s+)?(?:function${ID_END}|\\(|[\\w$]+\\s*=>|<)`,
    "d"
  );
  const assigned = findCandidates(lines, assignedRe);
  if (assigned.length) {
    const { line, col } = assigned[0];
    return sliceBlock(lines, line, declarationExtent(lines, line, col, null).end);
  }

  // Tier 3: method-style signature with no keyword — `public decimal Foo(`, `async render(`,
  // `get x()`, `public static <T> List<T> of(`.
  const methodRe = new RegExp(
    `^(?<prefix>\\s*(?:(?:<[^()]*>|[\\w$@]+(?:<[^()]*>)?(?:\\[\\])*[?*&]*(?:\\([^)]*\\))?)\\s+)*)${s}\\s*(?:<[^()]*>)?\\s*\\(`
  );
  for (let i = 0; i < lines.length; i++) {
    if (isCommentLine(lines[i]) || /^\s*import\b/.test(lines[i])) continue;
    const m = methodRe.exec(lines[i]);
    if (!m?.groups) continue;
    const prefix = m.groups.prefix.trim();
    const words = prefix.split(/\s+/).filter(Boolean).map((w) => w.replace(/\(.*$/, ""));
    if (words.some((w) => STATEMENT_WORDS.has(w))) continue;
    const col = m.groups.prefix.length;
    const extent = declarationExtent(lines, i, col, null);
    if (extent.kind === "brace" || extent.kind === "unbalanced") return sliceBlock(lines, i, extent.end);
    // Without a body this is either a signature (interface member, abstract method) or a bare
    // call statement. A call has nothing before the name and no return type after the `)`.
    const declText = lines.slice(i, extent.end + 1).join("\n").slice(col);
    const hasReturnType = /\)\s*:\s*[^;]+;?\s*$/.test(declText.trim());
    if (prefix !== "" || hasReturnType) return sliceBlock(lines, i, extent.end);
  }

  // Tier 4: a plain assignment or field at the start of a line — Python `TAX_RATE = 0.2`,
  // `private cache: Map<K, V> = new Map()`, Go `cfg := load()`.
  const assignmentRe = new RegExp(`${MODIFIERS}${s}\\s*(?::[^=;]*)?=(?![=>])`, "d");
  const assignments = findCandidates(lines, assignmentRe);
  if (assignments.length) {
    const { line, col } = assignments[0];
    return sliceBlock(lines, line, declarationExtent(lines, line, col, null).end);
  }

  // Tier 5: a `function`/`class` declaration anywhere on a line — `module.exports = function foo(`,
  // `export default connect(m)(class Foo extends Component {`.
  const inlineRe = new RegExp(`${ID_START}(?:function(?:\\s*\\*\\s*|\\s+)|class\\s+)${s}${ID_END}`, "d");
  const inline = findCandidates(lines, inlineRe);
  if (inline.length) {
    const { line, col } = inline[0];
    return sliceBlock(lines, line, declarationExtent(lines, line, col, null).end);
  }

  return null;
}

/**
 * How to fingerprint a ref. "auto" (capture time) anchors to the symbol when it can be found and
 * otherwise falls back to the whole file. "symbol" and "file" (check time) recompute exactly what
 * was recorded, so a note that fell back to the whole file keeps being compared as a whole file,
 * and a symbol that has since disappeared is reported missing rather than silently widened.
 */
export type FingerprintMode = "auto" | "symbol" | "file";

export interface FingerprintResult extends FingerprintEntry {
  /**
   * Hash of the same block over the raw, un-normalized bytes, set only when they differ (the file
   * has CRLF endings or a BOM). Fingerprints recorded before normalization were taken over raw
   * bytes, so matching this keeps those notes fresh on the checkout they were captured on.
   */
  legacyHash?: string;
  /** True when the ref names a symbol that could not be located, so the whole file was hashed. */
  fellBack?: boolean;
}

/** Fingerprints already-read file content — see computeFingerprint. */
export function fingerprintContent(raw: string, symbol: string | null, mode: FingerprintMode = "auto"): FingerprintResult {
  const normalized = normalizeContent(raw);
  const hasRawVariant = normalized !== raw;

  if (symbol && mode !== "file") {
    const block = extractSymbolBlock(normalized, symbol);
    if (block !== null) {
      const result: FingerprintResult = { hash: hashContent(block), kind: "symbol" };
      if (hasRawVariant) {
        const rawBlock = extractSymbolBlock(raw, symbol);
        if (rawBlock !== null) result.legacyHash = hashContent(rawBlock);
      }
      return result;
    }
    if (mode === "symbol") return { hash: "", kind: "missing" };
  }

  const result: FingerprintResult = { hash: hashContent(normalized), kind: "file" };
  if (hasRawVariant) result.legacyHash = hashContent(raw);
  if (symbol && mode === "auto") result.fellBack = true;
  return result;
}

/** Reads a ref's file relative to the repo root, or null when it doesn't exist (or isn't a file). */
export async function readRefFile(repoRoot: string, file: string): Promise<string | null> {
  try {
    return await readFile(path.resolve(repoRoot, file), "utf8");
  } catch {
    return null;
  }
}

/** Computes a fingerprint for a single ref against the working tree rooted at `repoRoot`. */
export async function computeFingerprint(
  repoRoot: string,
  ref: string,
  mode: FingerprintMode = "auto"
): Promise<FingerprintResult> {
  const { file, symbol } = parseRef(ref);
  const content = await readRefFile(repoRoot, file);
  if (content === null) return { hash: "", kind: "missing" };
  return fingerprintContent(content, symbol, mode);
}

export async function computeFingerprints(
  repoRoot: string,
  refs: string[]
): Promise<Record<string, FingerprintResult>> {
  const entries = await Promise.all(refs.map(async (ref) => [ref, await computeFingerprint(repoRoot, ref)] as const));
  return Object.fromEntries(entries);
}

/** The persisted part of a fingerprint — what goes into an entry's frontmatter. */
export function toStoredFingerprints(results: Record<string, FingerprintResult>): Record<string, FingerprintEntry> {
  return Object.fromEntries(Object.entries(results).map(([ref, r]) => [ref, { hash: r.hash, kind: r.kind }]));
}
