#!/usr/bin/env node
// Walks through whyanchor's staleness check on a scratch copy of the demo repo, next to a
// hand-written decisions file holding the same facts. No AI is involved, so the output is the same
// on every run.
//
//   node demo/staleness.mjs [out]        default out: a new folder under the OS temp dir
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TEAM_NOTES, addWhyanchor, commitAll, ensureCli, makeRepo, run, setIdentity, cliPath } from "./lib.mjs";

ensureCli();
const out = path.resolve(process.argv[2] ?? mkdtempSync(path.join(os.tmpdir(), "whyanchor-staleness-")));
const repo = path.join(out, "repo");

const check = (...flags) => {
  const result = run(process.execPath, [cliPath, "check", ...flags], repo, { allowFail: true });
  return { output: (result.stdout + result.stderr).trim(), exitCode: result.status };
};
const step = (title) => console.log(`\n=== ${title} ===`);
const editBilling = (edit) => {
  const file = path.join(repo, "src", "billing.js");
  writeFileSync(file, edit(readFileSync(file, "utf8")));
};

makeRepo(repo, "priya@acme.example");
// The "without whyanchor" version of the same knowledge: a hand-written file nothing ever checks.
writeFileSync(
  path.join(repo, "DECISIONS.md"),
  "# Decisions\n\n" + TEAM_NOTES.map((n) => `- **${n.title}.** ${n.message}`).join("\n") + "\n"
);
addWhyanchor(repo, TEAM_NOTES);

step("1. Right after the notes are written");
console.log(check().output);

step("2. A teammate adds a new function to billing.js, without touching the three anchored ones");
setIdentity(repo, "sam@acme.example");
editBilling((src) => src + "\nexport function calculateShipping(weightKg) {\n  return weightKg <= 1 ? 5 : 5 + (weightKg - 1) * 2;\n}\n");
commitAll(repo, "Add shipping cost");
console.log(check().output);

step("3. A teammate changes the enterprise discount to 35%");
editBilling((src) => src.replace("total * 0.3;", "total * 0.35;"));
commitAll(repo, "Q4 promo: enterprise discount 35%");
console.log(check().output);

step("4. The same check as a pre-commit hook or CI step");
const gate = check("--fail-on-stale");
console.log(`whyanchor check --fail-on-stale  →  exit code ${gate.exitCode}${gate.exitCode === 1 ? " (the commit or CI build is stopped)" : ""}`);

step("5. The hand-written DECISIONS.md after the same change");
console.log(readFileSync(path.join(repo, "DECISIONS.md"), "utf8").split("\n").find((l) => l.includes("30%")));
console.log("(Still says 30%, and nothing flagged it.)");

console.log(`\nRepo kept at ${repo}`);
