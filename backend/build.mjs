// One file to run: src/server.ts and everything it imports, bundled for Node 22.
import { build } from "esbuild";

await build({
  entryPoints: ["src/server.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/server.js",
  sourcemap: true,
  logLevel: "info",
  // Some dependencies call require() from inside an ES module bundle.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
