import prompts from "prompts";
import { CaptureError, captureEntry, findSupersedeTarget, type CaptureResult } from "../core/capture.js";
import { getRepoRoot } from "../core/git.js";
import { storeExists } from "../core/store.js";
import { displayPath } from "./output.js";

export interface CaptureOptions {
  title?: string;
  message?: string;
  refs?: string[];
  tags?: string[];
  supersedes?: string;
}

function splitList(input?: string[]): string[] {
  if (!input) return [];
  return input
    .flatMap((s) => s.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
}

function fail(message: string): void {
  console.error(`✖ ${message}`);
  process.exitCode = 1;
}

export async function runCapture(cwd: string, opts: CaptureOptions): Promise<void> {
  const repoRoot = (await getRepoRoot(cwd)) ?? cwd;

  if (!(await storeExists(repoRoot))) {
    fail("No memory store found. Run `whyanchor init` first.");
    return;
  }

  // Check --supersedes before asking anything, so a mistyped id doesn't cost the user their answers.
  if (opts.supersedes) {
    try {
      await findSupersedeTarget(repoRoot, opts.supersedes);
    } catch (err) {
      if (!(err instanceof CaptureError)) throw err;
      fail(err.message);
      return;
    }
  }

  let title = opts.title;
  let message = opts.message;
  let refs = splitList(opts.refs);
  let tags = splitList(opts.tags);

  const interactive = !title || !message;
  if (interactive) {
    const answers = await prompts(
      [
        { type: title ? null : "text", name: "title", message: "One-line title for this memory:" },
        {
          type: message ? null : "text",
          name: "message",
          message: "What should future you (or another dev) know? (a few sentences)",
        },
        {
          type: refs.length ? null : "text",
          name: "refs",
          message: "Files/symbols this is anchored to (comma-separated, e.g. src/billing.ts#calculateTax):",
          initial: "",
        },
        {
          type: tags.length ? null : "text",
          name: "tags",
          message: "Tags (comma-separated, optional):",
          initial: "",
        },
      ],
      { onCancel: () => process.exit(1) }
    );
    title = title ?? answers.title;
    message = message ?? answers.message;
    if (!refs.length && answers.refs) refs = splitList([answers.refs]);
    if (!tags.length && answers.tags) tags = splitList([answers.tags]);
  }

  if (!title?.trim() || !message?.trim()) {
    fail("A title and message are required.");
    return;
  }

  let result: CaptureResult;
  try {
    result = await captureEntry(repoRoot, { title, body: message, refs, tags, supersedes: opts.supersedes });
  } catch (err) {
    if (!(err instanceof CaptureError)) throw err;
    fail(err.message);
    return;
  }

  if (result.superseded) {
    const id = result.superseded.frontmatter.id;
    console.log(`✔ Marked ${id} as superseded.`);
    if (result.alreadySupersededBy.length) {
      console.warn(
        `⚠ ${id} had already been superseded by ${result.alreadySupersededBy.join(", ")}, so more than one ` +
          `active entry now replaces it. If you meant to update the newer one, supersede that instead.`
      );
    }
  }
  console.log(`✔ Captured "${result.entry.frontmatter.title}" → ${displayPath(repoRoot, result.entry.filePath)}`);
  if (result.unresolvedRefs.length) {
    console.warn(
      `⚠ Could not resolve ${result.unresolvedRefs.length} ref(s) (file not found), captured anyway: ${result.unresolvedRefs.join(", ")}`
    );
  }
  if (result.wholeFileRefs.length) {
    console.warn(`⚠ Symbol not found — watching the whole file instead: ${result.wholeFileRefs.join(", ")}`);
  }
  if (result.outsideRepoRefs.length) {
    console.warn(`⚠ Ref(s) outside this repository: ${result.outsideRepoRefs.join(", ")}`);
  }
  console.log("Run `whyanchor generate` to reflect this in CLAUDE.md / AGENTS.md.");
}
