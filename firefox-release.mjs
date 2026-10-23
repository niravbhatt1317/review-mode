// After Mozilla has signed a version: the files for the Firefox update site, into docs/firefox/ (GitHub Pages).
//   node firefox-release.mjs ~/Downloads/<signed>.xpi && git add docs && git commit -m "Firefox 2.0.43" && git push
// docs/firefox/: the signed file under its version, a copy as review-mode.xpi (the install link that never changes)
// and updates.json (what Firefox checks daily). Older .xpi files stay.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { FIREFOX_SITE } from "./site.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = process.argv[2];
if (!src || !fs.existsSync(src)) {
  console.error("give the signed .xpi Mozilla produced (Manage Status & Versions → the version → download)");
  process.exit(1);
}
const site = path.join(here, "docs", "firefox");
fs.mkdirSync(site, { recursive: true });
/* the version from the manifest inside the xpi (a zip): read it without unzipping tools */
import { execSync } from "node:child_process";
const manifest = JSON.parse(execSync(`unzip -p "${src}" manifest.json`).toString());
const id = manifest.browser_specific_settings?.gecko?.id;
const version = manifest.version;
const file = `review-mode-${version}.xpi`;
fs.copyFileSync(src, path.join(site, file));
fs.copyFileSync(src, path.join(site, "review-mode.xpi"));
const sha = (f) => "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const versions = fs.readdirSync(site).filter((f) => /^review-mode-\d+\.\d+\.\d+\.xpi$/.test(f)).map((f) => f.match(/^review-mode-(.+)\.xpi$/)[1]).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const updates = { addons: { [id]: { updates: versions.map((v) => ({ version: v, update_link: `${FIREFOX_SITE}review-mode-${v}.xpi`, update_hash: sha(path.join(site, `review-mode-${v}.xpi`)) })) } } };
fs.writeFileSync(path.join(site, "updates.json"), JSON.stringify(updates, null, 2) + "\n");
console.log(`${version} ready in ${path.relative(process.cwd(), site)}: commit and push docs/ and the site serves it`);
console.log(`install link: ${FIREFOX_SITE}review-mode.xpi`);
