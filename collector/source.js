// Source on every comment (2026-10-26): on the dev server, each element the app's own files write gets
// data-rv-src="src/pages/AgentFleet.jsx:212:7@AgentTable" (file, line, column, the component it sits in), so a comment
// says exactly where its element is written. Any framework: JSX and TSX (React, Preact, Solid), Vue templates,
// Svelte. Only in review mode (withReview) and only while serving: production builds and plain `npm run dev` never see it.
//
// The parser is the one the project already has: Vite 8's own (rolldown/parseAst), else @babel/parser for JSX,
// @vue/compiler-sfc for .vue, svelte/compiler for .svelte. None found: the file is left as it is (the drawer then
// falls back on what the framework itself knows, and on the element's text).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const ATTR = "data-rv-src";
const JSX = /\.(jsx|tsx|js|ts|mjs|mts)$/;

/* a module from the project's own node_modules, or null */
async function fromProject(root, id) {
  try {
    const req = createRequire(path.join(root, "package.json"));
    return await import(pathToFileURL(req.resolve(id)).href);
  } catch {
    return null;
  }
}

/* line and column (1-based) for every offset, from one pass over the text */
function lineIndex(code) {
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) starts.push(i + 1);
  return (off) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return [lo + 1, off - starts[lo] + 1];
  };
}

/* the inserts, plus a source map that keeps every line and column true (the debugger still points at the file) */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const vlq = (n) => {
  let v = n < 0 ? (-n << 1) | 1 : n << 1, s = "";
  do {
    let d = v & 31;
    v >>>= 5;
    if (v) d |= 32;
    s += B64[d];
  } while (v);
  return s;
};
function apply(code, inserts, file) {
  inserts.sort((a, b) => a.at - b.at);
  let out = "", last = 0;
  for (const ins of inserts) {
    out += code.slice(last, ins.at) + ins.text;
    last = ins.at;
  }
  out += code.slice(last);
  /* one segment at the start of each line, and one after each insert on it */
  const pos = lineIndex(code);
  const byLine = new Map();
  for (const ins of inserts) {
    const [l, c] = pos(ins.at);
    if (!byLine.has(l)) byLine.set(l, []);
    byLine.get(l).push({ col: c - 1, len: ins.text.length });
  }
  const lines = code.split("\n").length;
  let prevOrigLine = 0, prevOrigCol = 0;
  const mapLines = [];
  for (let l = 1; l <= lines; l++) {
    const segs = [];
    let prevGen = 0, shift = 0;
    const cols = [{ col: 0, len: 0 }, ...(byLine.get(l) || [])];
    for (const { col, len } of cols) {
      shift += len;
      const gen = col + shift;
      segs.push(vlq(gen - prevGen) + vlq(0) + vlq(l - 1 - prevOrigLine) + vlq(col - prevOrigCol));
      prevGen = gen;
      prevOrigLine = l - 1;
      prevOrigCol = col;
    }
    mapLines.push(segs.join(","));
  }
  return { code: out, map: { version: 3, sources: [file], sourcesContent: [code], names: [], mappings: mapLines.join(";") } };
}

const esc = (s) => String(s).replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]);

/* ---------- JSX and TSX ---------- */
/* every lower-case element (<div>, <button>, <svg>): components may not pass a stray attribute on, DOM elements do.
   The component an element sits in is the nearest capitalised function or variable above it. */
function stampJsx(ast, code, rel) {
  const pos = lineIndex(code);
  const inserts = [];
  const walk = (node, comp) => {
    if (!node || typeof node.type !== "string") return;
    let here = comp;
    if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id?.name && /^[A-Z]/.test(node.id.name)) here = node.id.name;
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && /^[A-Z]/.test(node.id.name)) here = node.id.name;
    if (node.type === "JSXOpeningElement" && node.name?.type === "JSXIdentifier" && /^[a-z]/.test(node.name.name)) {
      const has = (node.attributes || []).some((a) => a.type === "JSXAttribute" && a.name?.name === ATTR);
      if (!has) {
        const [l, c] = pos(node.start);
        inserts.push({ at: node.name.end, text: ` ${ATTR}="${esc(`${rel}:${l}:${c}${here ? `@${here}` : ""}`)}"` });
      }
    }
    for (const k in node) {
      if (k === "start" || k === "end" || k === "loc" || k === "range") continue;
      const v = node[k];
      if (Array.isArray(v)) for (const x of v) walk(x, here);
      else if (v && typeof v === "object" && typeof v.type === "string") walk(v, here);
    }
  };
  walk(ast, "");
  return inserts;
}

/* ---------- Vue templates ---------- */
function stampVue(sfc, code, rel) {
  const tpl = sfc.descriptor?.template;
  if (!tpl?.ast) return [];
  const pos = lineIndex(code);
  const comp = path.basename(rel).replace(/\.vue$/, "");
  const inserts = [];
  const walk = (n) => {
    /* type 1 is an element; tagType 0 a plain one (not a component, a slot or a <template>) */
    if (n.type === 1 && n.tagType === 0 && !n.props?.some((p) => p.name === ATTR)) {
      const at = n.loc.start.offset + 1 + n.tag.length;
      const [l, c] = pos(n.loc.start.offset);
      inserts.push({ at, text: ` ${ATTR}="${esc(`${rel}:${l}:${c}@${comp}`)}"` });
    }
    for (const ch of n.children || []) walk(ch);
  };
  /* the template's root node is the <template> block itself: its children carry file offsets */
  for (const ch of tpl.ast.children || []) walk(ch);
  return inserts;
}

/* ---------- Svelte ---------- */
function stampSvelte(ast, code, rel) {
  const pos = lineIndex(code);
  const comp = path.basename(rel).replace(/\.svelte$/, "");
  const inserts = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    const isEl = (n.type === "Element" || n.type === "RegularElement") && /^[a-z]/.test(n.name || "") && n.name !== "slot";
    if (isEl && !(n.attributes || []).some((a) => a.name === ATTR)) {
      const [l, c] = pos(n.start);
      inserts.push({ at: n.start + 1 + n.name.length, text: ` ${ATTR}="${esc(`${rel}:${l}:${c}@${comp}`)}"` });
    }
    for (const k of ["children", "fragment", "nodes", "html", "else", "then", "catch", "pending", "body", "consequent", "alternate", "fallback"]) if (n[k]) walk(n[k]);
  };
  walk(ast.html || ast.fragment || ast);
  return inserts;
}

/* the Vite plugin: before every other transform, on the project's own files only */
export function sourcePlugin() {
  let root = process.cwd();
  const parsers = {};
  const need = async (name, load) => (name in parsers ? parsers[name] : (parsers[name] = await load()));
  return {
    name: "review-mode:source",
    apply: "serve",
    enforce: "pre",
    configResolved(c) {
      root = c.root;
    },
    async transform(code, id) {
      /* a virtual module or a sub-request (a .vue file's ?vue&type=… parts): the whole file was stamped already */
      if (id.startsWith("\0") || id.includes("?")) return null;
      const file = id;
      if (file.includes("/node_modules/") || !file.startsWith(root)) return null;
      const rel = path.relative(root, file).split(path.sep).join("/");
      let inserts = [];
      try {
        if (JSX.test(file)) {
          if (!/<[a-z]/.test(code)) return null; // no lower-case element anywhere: nothing to stamp
          const lang = file.endsWith(".tsx") ? "tsx" : file.endsWith(".ts") || file.endsWith(".mts") ? "ts" : "jsx";
          if (lang === "ts") return null; // .ts cannot hold JSX
          const ox = await need("oxc", () => fromProject(root, "rolldown/parseAst"));
          if (ox?.parseAst) inserts = stampJsx(ox.parseAst(code, { lang }), code, rel);
          else {
            const babel = await need("babel", () => fromProject(root, "@babel/parser"));
            if (!babel?.parse) return null;
            const ast = babel.parse(code, { sourceType: "module", plugins: ["jsx", ...(lang === "tsx" ? ["typescript"] : [])], errorRecovery: true });
            inserts = stampJsx(ast.program, code, rel);
          }
        } else if (file.endsWith(".vue")) {
          const vue = await need("vue", () => fromProject(root, "@vue/compiler-sfc"));
          if (!vue?.parse) return null;
          inserts = stampVue(vue.parse(code, { filename: file }), code, rel);
        } else if (file.endsWith(".svelte")) {
          const sv = await need("svelte", () => fromProject(root, "svelte/compiler"));
          if (!sv?.parse) return null;
          inserts = stampSvelte(sv.parse(code), code, rel);
        } else return null;
      } catch {
        return null; // a file the parser cannot read is served as it is; the framework's own error shows as usual
      }
      return inserts.length ? apply(code, inserts, file) : null;
    },
  };
}

/* MAYBE FIXED? (2026-10-26): a fingerprint of the code that draws one element: its opening tag (classes, styles,
   props) and the words right after it, read from its line and column. Kept with the comment when it is made; later
   the drawer reads the element's place again (the live stamp: code added above moves it) and asks for the
   fingerprint there. Another one means this element's code was edited since; a neighbour's edit does not count.
   Only files inside the project are read. */
function tagAt(code, from) {
  let i = from, depth = 0, quote = "";
  for (; i < code.length && i - from < 4000; i++) {
    const ch = code[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth <= 0) break;
  }
  const next = code.indexOf("<", i + 1);
  return code.slice(from, next < 0 ? Math.min(code.length, i + 200) : Math.min(next, i + 400));
}
export function codeNear(root, file, line, col = 1) {
  try {
    const abs = path.resolve(root, String(file || ""));
    if (!abs.startsWith(path.resolve(root) + path.sep) || abs.includes(`${path.sep}node_modules${path.sep}`)) return null;
    const n = Number(line), c = Number(col) || 1;
    if (!Number.isInteger(n) || n < 1) return null;
    const code = fs.readFileSync(abs, "utf8");
    let off = 0;
    for (let k = 1; k < n; k++) {
      off = code.indexOf("\n", off) + 1;
      if (!off) return null;
    }
    const t = tagAt(code, off + c - 1).replace(/\s+/g, " ").trim();
    if (!t.startsWith("<")) return null; // the line moved under us: no answer rather than a wrong one
    let h = 2166136261;
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return { near: (h >>> 0).toString(36), at: fs.statSync(abs).mtimeMs };
  } catch {
    return null;
  }
}
