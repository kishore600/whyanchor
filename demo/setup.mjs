#!/usr/bin/env node
// Creates two copies of the same small billing service for a side-by-side demo:
//
//   <out>/without   the plain repo
//   <out>/with      the same code plus whyanchor: three decisions a teammate recorded,
//                   connected to Claude Code (MCP server + CLAUDE.md)
//
//   node demo/setup.mjs [out]        default out: ~/whyanchor-demo
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROMPTS, TEAM_NOTES, addWhyanchor, demoDir, ensureCli, makeRepo, setIdentity } from "./lib.mjs";

const out = path.resolve(process.argv[2] ?? path.join(os.homedir(), "whyanchor-demo"));
if (existsSync(out) && readdirSync(out).length > 0) {
  console.error(`✖ ${out} already exists and isn't empty. Pass another folder, or delete it first.`);
  process.exit(1);
}
ensureCli();

const without = path.join(out, "without");
const withMemory = path.join(out, "with");

makeRepo(without, "priya@acme.example");
makeRepo(withMemory, "priya@acme.example");
addWhyanchor(withMemory, TEAM_NOTES);
// From here on the developer at the keyboard is someone else, who never heard of these decisions.
setIdentity(without, "alex@acme.example");
setIdentity(withMemory, "alex@acme.example");

console.log(`✔ Demo folders ready:
    without whyanchor: ${without}
    with whyanchor:    ${withMemory}

Open each folder in its own Claude Code session (desktop app: open the folder; terminal: cd into it
and run "claude"), then paste the same prompt into both:

  1. ${PROMPTS.cleanup}
  2. ${PROMPTS.discount}

When both agents finish, score what each one did:

  node "${path.join(demoDir, "evaluate.mjs")}" "${without}"
  node "${path.join(demoDir, "evaluate.mjs")}" "${withMemory}"

Reset a folder between prompts with: git checkout -- . && git clean -fd`);
