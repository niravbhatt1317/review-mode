// A release of the extension: bumps the version and zips the folder (without the dev-only files) twice,
// dist/review-mode-<version>.zip for the Chrome Web Store and dist/review-mode-<version>-firefox.zip for Mozilla's
// add-ons site. The Firefox zip carries its own manifest: a background script instead of a service worker (Firefox
// has no service-worker background yet) and the add-on's id.
//   node pack.mjs            patch: 2.0.0 -> 2.0.1 (manifest and package.json)
//   node pack.mjs minor      2.0.1 -> 2.1.0
//   node pack.mjs --no-bump  the current version, as the release workflow does
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
import { FIREFOX_SITE } from "./site.mjs";
const m = JSON.parse(fs.readFileSync(path.join(here, "manifest.json"), "utf8"));
const how = process.argv[2];
if (how !== "--no-bump") {
  const [a, b, c] = m.version.split(".").map(Number);
  m.version = how === "minor" ? `${a}.${b + 1}.0` : how === "major" ? `${a + 1}.0.0` : `${a}.${b}.${c + 1}`;
  fs.writeFileSync(path.join(here, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
  const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));
  pkg.version = m.version;
  fs.writeFileSync(path.join(here, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
}
const dist = path.join(here, "dist");
fs.mkdirSync(dist, { recursive: true });
const skip = '"dist/*" "docs/*" ".github/*" "node_modules/*" ".git/*" "pack.mjs" "firefox-release.mjs" "site.mjs" "package.json" "package-lock.json" "README.md" "STORE.md" "LICENSE" ".gitignore" "icons/icon.svg" "*.DS_Store" "manifest.firefox.json"';
const out = path.join(dist, `review-mode-${m.version}.zip`);
fs.rmSync(out, { force: true });
execSync(`cd "${here}" && zip -qr "${out}" . -x ${skip}`);
console.log(`${m.version}  ${path.relative(process.cwd(), out)}  ${Math.round(fs.statSync(out).size / 1024)} KB  (Chrome, Edge)`);
/* Firefox: the same files, its manifest */
/* Mozilla asks every new add-on to say in the manifest what it collects: the person's GitHub name and handle
   (personalInfo), the screenshot and the commented element's text (websiteContent), the clicks recorded on a
   switched-on site so a comment can be found again (websiteActivity) */
const ff = { ...m, background: { scripts: ["background.js"], type: "module" }, browser_specific_settings: { gecko: { id: "review-mode@heynirav", strict_min_version: "140.0", update_url: FIREFOX_SITE + "updates.json", data_collection_permissions: { required: ["personallyIdentifyingInfo", "websiteContent", "websiteActivity"] } } } };
fs.writeFileSync(path.join(here, "manifest.firefox.json"), JSON.stringify(ff, null, 2) + "\n");
const outFf = path.join(dist, `review-mode-${m.version}-firefox.zip`);
fs.rmSync(outFf, { force: true });
const tmp = fs.mkdtempSync(path.join(dist, "ff-"));
execSync(`cd "${here}" && zip -qr "${outFf}" . -x ${skip} "manifest.json"`);
fs.copyFileSync(path.join(here, "manifest.firefox.json"), path.join(tmp, "manifest.json"));
execSync(`cd "${tmp}" && zip -q "${outFf}" manifest.json`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${m.version}  ${path.relative(process.cwd(), outFf)}  ${Math.round(fs.statSync(outFf).size / 1024)} KB  (Firefox)`);
