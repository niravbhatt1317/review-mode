// The two lines a project needs in .review/vite.config.js:
//   import base from "../vite.config.js";
//   export default withReview(base);
// The project's own config, untouched, plus the collector and the review port (review.config.json, default 4178).
import review from "./plugin.js";
import { loadConfig } from "./config.js";

export function withReview(base = {}, options = {}) {
  const cfg = loadConfig(options.root || process.cwd());
  const port = options.port || cfg.port;
  return async (env) => {
    const resolved = typeof base === "function" ? await base(env) : base;
    return {
      ...resolved,
      plugins: [...(resolved.plugins || []), review(options)],
      server: { ...(resolved.server || {}), port, strictPort: true },
    };
  };
}
export { review };
