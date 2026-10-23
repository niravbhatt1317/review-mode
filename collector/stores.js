// The two places a session's comments can live, behind one interface: the hub (Supabase, through hub-core's
// client, with a disk cache for pictures under .review/.cache/<project>/) and local files (.review/sessions/<name>/,
// for test sessions whose name starts with "_").
import fs from "node:fs";
import path from "node:path";
import { makeHub, prepare, sentence, normalise, numbered } from "../hub-core.js";

export function hubStore(cfg) {
  const cacheDir = path.join(cfg.cacheDir, cfg.project);
  const cache = {
    get(file) {
      const p = path.join(cacheDir, file);
      return fs.existsSync(p) ? fs.readFileSync(p) : null;
    },
    put(file, bytes) {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, file), bytes);
    },
    drop(file) {
      fs.rmSync(path.join(cacheDir, file), { force: true });
    },
  };
  return makeHub({ url: cfg.hub.url, key: cfg.hub.key, project: cfg.project, cache });
}

export function readComments(dir) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(dir, "comments.json"), "utf8"));
    for (const c of list) {
      c.text = sentence(c.text);
      normalise(c);
      c.thumb = fs.existsSync(path.join(dir, `${c.id}.t.jpg`)) ? `${c.id}.t.jpg` : null;
    }
    return numbered(list);
  } catch {
    return [];
  }
}
export function writeComments(dir, list) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "comments.json"), JSON.stringify(list, null, 2));
}
export function fileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return {
    kind: "file",
    project: path.basename(dir),
    async list() {
      return readComments(dir);
    },
    async get(id) {
      return readComments(dir).find((c) => c.id === id) || null;
    },
    async insert(entry, png, thumb) {
      if (png) {
        entry.shot = `${entry.id}.png`; // named by identity, not by number: numbers move
        fs.writeFileSync(path.join(dir, entry.shot), png);
      }
      if (thumb) fs.writeFileSync(path.join(dir, `${entry.id}.t.jpg`), thumb);
      const list = readComments(dir);
      list.push(entry);
      writeComments(dir, numbered(list));
      return entry;
    },
    async put(c) {
      const list = readComments(dir);
      const i = list.findIndex((x) => x.id === c.id);
      if (i < 0) throw new Error("no such comment");
      list[i] = c;
      writeComments(dir, list);
      return c;
    },
    async putThumb(id, jpg) {
      fs.writeFileSync(path.join(dir, `${id}.t.jpg`), jpg);
    },
    async remove(c) {
      if (c.shot) fs.rmSync(path.join(dir, c.shot), { force: true });
      fs.rmSync(path.join(dir, `${c.id}.t.jpg`), { force: true });
      writeComments(dir, numbered(readComments(dir).filter((x) => x.id !== c.id)));
    },
    async shot(file) {
      const p = path.join(dir, file);
      return fs.existsSync(p) ? fs.readFileSync(p) : null;
    },
    async people() {
      return {};
    },
    async sign() {
      return {};
    },
    async usage() {
      return null;
    },
    async sweep() {
      return 0;
    },
  };
}
/* the store for a session name: "_xxx" is a local test session; anything else is the hub (or local "main" without one) */
export function storeFor(cfg, hubs, sess) {
  if (sess && /^_[a-z0-9-]+$/.test(sess)) return fileStore(path.join(cfg.sessionsDir, sess));
  if (cfg.hub) {
    if (!hubs.has(cfg.project)) hubs.set(cfg.project, hubStore(cfg));
    return hubs.get(cfg.project);
  }
  return fileStore(path.join(cfg.sessionsDir, "main"));
}
export { prepare };
