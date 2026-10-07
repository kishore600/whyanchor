import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Inside this repo's npm workspace (apps/cli/graph-app), `next` is hoisted to the repo-root
 * node_modules, which is outside this app's own folder. Turbopack refuses to resolve packages
 * above its root, so when building in the workspace the root has to be the workspace root.
 * Installed from npm there is no workspace — graph-app sits next to dist/ — and the package
 * directory stays the root, exactly as before.
 */
function workspaceRoot() {
  const candidate = path.join(appDir, "..", "..", "..");
  try {
    const pkg = JSON.parse(readFileSync(path.join(candidate, "package.json"), "utf8"));
    return pkg.name === "whyanchor-monorepo" ? candidate : null;
  } catch {
    return null;
  }
}

// This app is launched by `whyanchor viewgraph` from an arbitrary installed location
// (global install, npx cache, or a linked clone) and reads compiled files from the sibling
// ../dist directory — outside this app's own folder — so file-tracing needs to look at least
// one level up to find them.
const root = workspaceRoot() ?? path.join(appDir, "..");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: root,
  turbopack: { root },
};

export default nextConfig;
