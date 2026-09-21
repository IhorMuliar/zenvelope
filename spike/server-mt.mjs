// Static server for the M4 threaded proving spike. Same as server.mjs, plus one thing:
// anything under `/plain/...` is served from the same files but WITHOUT the COOP/COEP
// headers, so the test can load the identical wasm in a page that is not
// cross-origin-isolated and see exactly how it fails.
//
// Usage: node server-mt.mjs [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.argv[2] ?? 5601);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

const ISOLATION = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  let rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const plain = rel.startsWith("/plain/");
  if (plain) rel = rel.slice("/plain".length);
  const path = join(ROOT, rel === "/" ? "index-mt.html" : rel);
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(path)] ?? "application/octet-stream",
      ...(plain ? {} : ISOLATION),
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`spike-mt server on http://127.0.0.1:${PORT}/ (plain: /plain/...)`);
});
