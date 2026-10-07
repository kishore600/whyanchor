import { hashContent, normalizeContent } from "./fingerprint.js";

/**
 * The symbol extractor earlier versions of whyanchor shipped, kept verbatim for one job only:
 * recognizing fingerprints it recorded. It often hashed just part of a symbol — the braces of a
 * destructured or `= {}` parameter instead of the body, or a one-liner plus whatever function
 * followed it — so a match here means "the part the old baseline covered is unchanged", never
 * "fresh". Do not use it to fingerprint anything new.
 */
function extractSymbolBlockV1(content: string, symbol: string): string | null {
  const lines = content.split("\n");
  const declRe = new RegExp(
    `\\b(function\\s+${symbol}\\b|class\\s+${symbol}\\b|(const|let|var)\\s+${symbol}\\b|def\\s+${symbol}\\b|${symbol}\\s*[:=]\\s*(async\\s*)?\\(|${symbol}\\s*\\([^)]*\\)\\s*[:{])`
  );

  let declLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (declRe.test(lines[i])) {
      declLineIdx = i;
      break;
    }
  }
  if (declLineIdx === -1) return null;

  const declLine = lines[declLineIdx];

  if (/:\s*$/.test(declLine.trimEnd()) && !declLine.includes("{")) {
    const declIndent = declLine.match(/^(\s*)/)?.[1].length ?? 0;
    const blockLines = [declLine];
    for (let i = declLineIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") {
        blockLines.push(line);
        continue;
      }
      const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (indent <= declIndent) break;
      blockLines.push(line);
    }
    return blockLines.join("\n").trimEnd();
  }

  let braceLine = -1;
  let braceCol = -1;
  outer: for (let i = declLineIdx; i < Math.min(lines.length, declLineIdx + 50); i++) {
    for (let c = 0; c < lines[i].length; c++) {
      if (lines[i][c] === "{") {
        braceLine = i;
        braceCol = c;
        break outer;
      }
    }
  }
  if (braceLine === -1) return declLine;

  let depth = 0;
  for (let i = braceLine; i < lines.length; i++) {
    for (let c = i === braceLine ? braceCol : 0; c < lines[i].length; c++) {
      if (lines[i][c] === "{") depth++;
      else if (lines[i][c] === "}" && --depth === 0) return lines.slice(declLineIdx, i + 1).join("\n").trimEnd();
    }
  }
  return null;
}

/**
 * Hashes the earlier extractor would have recorded for `symbol` in this file — over the raw
 * bytes it actually hashed, and over normalized text for a note captured on a checkout with
 * different line endings.
 */
export function legacySymbolHashes(raw: string, symbol: string): string[] {
  const hashes = new Set<string>();
  for (const content of new Set([raw, normalizeContent(raw)])) {
    try {
      const block = extractSymbolBlockV1(content, symbol);
      if (block !== null) hashes.add(hashContent(block));
    } catch {
      // The old extractor threw on regex metacharacters, so it can't have recorded anything here.
    }
  }
  return [...hashes];
}
