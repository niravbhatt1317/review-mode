// What a project tells the collector and the command line, and what the package brings along.
//   review.config.json in the project root (written by `npx review init`):
//     { "project": "acme-app", "port": 4178, "hub": { "url": "...", "anonKey": "...", "people": { ... } } }
//   hub: optional; without it the package's own hub.json (the team's hub) is used. `people` adds to it.
//   .review/hub.local.json in the project: a local override (another project name for a trial), git-ignored.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
/* the project root: the folder with review.config.json, walking up from `from` (the Vite root, or the cwd) */
export function projectRoot(from = process.cwd()) {
  let dir = path.resolve(from);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "review.config.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.resolve(from);
}
export function loadConfig(from = process.cwd()) {
  const root = projectRoot(from);
  const own = readJson(path.join(root, "review.config.json")) || {};
  const local = readJson(path.join(root, ".review", "hub.local.json")) || {};
  const packaged = readJson(path.join(pkgDir, "hub.json")) || {};
  const hub = { ...packaged, ...(own.hub || {}), ...local };
  const people = { ...(packaged.people || {}), ...(own.hub?.people || {}), ...(local.people || {}) };
  const project = process.env.REVIEW_PROJECT || local.project || own.project || readJson(path.join(root, "package.json"))?.name || path.basename(root);
  return {
    root,
    project: String(project).replace(/^@[^/]+\//, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-"),
    port: Number(own.port) || 4178,
    hub: hub.url && hub.anonKey ? { url: String(hub.url).replace(/\/+$/, ""), key: hub.anonKey } : null,
    people,
    reviewDir: path.join(root, ".review"),
    sessionsDir: path.join(root, ".review", "sessions"),
    cacheDir: path.join(root, ".review", ".cache"),
  };
}
export { pkgDir };
