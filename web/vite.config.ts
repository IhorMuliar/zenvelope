import { readdirSync, readFileSync, statSync } from "node:fs";
import { createReadStream } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));

// COOP/COEP so SharedArrayBuffer (and therefore WASM threads) are available in
// dev and in preview, matching public/_headers in production. Without these the
// threaded core cannot instantiate and the core worker falls back to the
// single-threaded package: see web/src/core/worker.ts.
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

/** Where scripts/build-core.sh writes the threaded package, and where it is served. */
const MT_SOURCE = resolve(HERE, "src/wasm/core-mt");
const MT_ROUTE = "/wasm/core-mt/";

const MIME: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

/** Everything in the package except the things only a package manager wants. */
function mtFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      // The .wasm, the glue and the rayon snippets ship; wasm-pack's packaging
      // leftovers (types, package.json, the crate README) do not.
      if (
        entry.endsWith(".d.ts") ||
        entry.endsWith(".md") ||
        entry === "package.json" ||
        entry === ".gitignore"
      ) {
        continue;
      }
      out.push(relative(MT_SOURCE, full));
    }
  };
  try {
    walk(MT_SOURCE);
  } catch {
    // No threaded build in this checkout. That is a supported state: the core worker
    // falls back to the single-threaded package and the footer says "proving: 1 thread".
  }
  return out;
}

/**
 * Serves and copies `src/wasm/core-mt` **verbatim**, outside Vite's module graph.
 *
 * It cannot go through the bundler. wasm-bindgen-rayon's no-bundler glue spawns each
 * rayon worker by fetching its own `import.meta.url` as a blob and re-importing the main
 * module by URL, so both files have to exist, unrenamed, at a path the browser can
 * resolve at run time. Bundling them would rewrite exactly those two URLs.
 */
function coreMtAssets(): Plugin {
  return {
    name: "zenvelope-core-mt",

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        if (!url.startsWith(MT_ROUTE)) return next();
        const rel = decodeURIComponent(url.slice(MT_ROUTE.length));
        // No traversal out of the package, ever.
        const file = resolve(MT_SOURCE, rel);
        if (!file.startsWith(MT_SOURCE) || !mtFiles().includes(relative(MT_SOURCE, file))) {
          return next();
        }
        res.setHeader("Content-Type", MIME[extname(file)] ?? "application/octet-stream");
        // The threaded module needs a shared memory, which needs the page and every
        // subresource to be cross-origin isolated.
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        createReadStream(file).pipe(res);
      });
    },

    generateBundle() {
      const files = mtFiles();
      if (files.length === 0) {
        this.warn(
          "no threaded core at web/src/wasm/core-mt; the app will fall back to the " +
            "single-threaded package. Run ./scripts/build-core.sh.",
        );
        return;
      }
      for (const rel of files) {
        this.emitFile({
          type: "asset",
          fileName: `wasm/core-mt/${rel.split(/[\\/]/).join("/")}`,
          source: readFileSync(join(MT_SOURCE, rel)),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), coreMtAssets()],
  build: {
    target: "esnext",
  },
  worker: {
    // The core worker is an ES module: it uses import.meta.glob for the single-threaded
    // wasm package and a dynamic import for the threaded one.
    format: "es",
  },
  optimizeDeps: {
    // The wasm-bindgen glue must not be pre-bundled: esbuild would break its
    // import.meta.url handling for the .wasm asset.
    exclude: ["zenvelope-core", "@zenvelope/core"],
    esbuildOptions: { target: "esnext" },
  },
  server: {
    headers: crossOriginIsolation,
  },
  preview: {
    headers: crossOriginIsolation,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
