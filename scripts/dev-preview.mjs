/* Local preview of the client against the LIVE league data, read-only.
   Serves public/ and proxies GET /api/* to the live site (POSTs get a 405, so
   nothing here can touch real picks or payments). appVersion in /api/state is
   rewritten to this checkout's APP_BUILD so the self-updater stays quiet.
   Run: LIVE=https://your-league.netlify.app node scripts/dev-preview.mjs   (PORT=8922) */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join, normalize } from "node:path";

const ROOT = fileURLToPath(new URL("../public/", import.meta.url));
const LIVE = process.env.LIVE;
if (!LIVE) { console.error("Set LIVE to your deployed league, e.g. LIVE=https://your-league.netlify.app"); process.exit(1); }
const PORT = Number(process.env.PORT || 8922);
const BUILD = (await readFile(join(ROOT, "app.js"), "utf8")).match(/const APP_BUILD = "([^"]+)"/)?.[1];
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json" };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith("/api/")) {
    if (req.method !== "GET") { res.writeHead(405).end("read-only preview: writes are not proxied"); return; }
    try {
      const r = await fetch(LIVE + url.pathname + url.search, { headers: { accept: "application/json" } });
      let body = Buffer.from(await r.arrayBuffer());
      if (url.pathname === "/api/state" && r.ok && BUILD) {
        try { const j = JSON.parse(body.toString("utf8")); j.appVersion = BUILD; body = Buffer.from(JSON.stringify(j)); } catch {}
      }
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/json", "cache-control": "no-store" });
      res.end(body);
    } catch (e) { res.writeHead(502).end(String(e)); }
    return;
  }
  const path = join(ROOT, normalize(url.pathname === "/" ? "/index.html" : url.pathname));
  if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  let body;
  try { body = await readFile(path); } catch { res.writeHead(404).end("not found"); return; }
  res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream", "cache-control": "no-store" });
  res.end(body);
}).listen(PORT, () => console.log(`preview http://localhost:${PORT}  (client ${BUILD}, /api GET -> ${LIVE})`));
