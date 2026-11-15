import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

// Data lives in ./data (or wherever MFM_DATA_DIR points, e.g. MFM_DATA_DIR=../marswalk-hybrid/data):
//   data/processed  Jezero site + app assets (draco/, models/) -> served at /
//   data/global     globe bake                                  -> served at /global/
//   data/sites/<id> other sites                                 -> served at /sites/<id>/
// Walk logs are saved to ./runs by the dev server. No other network use at runtime.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const DATA_DIR = resolve(HERE, process.env.MFM_DATA_DIR || "data");
const GLOBAL_DIR = join(DATA_DIR, "global");
const SITES_DIR = join(DATA_DIR, "sites");
const RUNS_DIR = join(HERE, "runs");
const TYPES: Record<string, string> = {
  ".json": "application/json", ".jpg": "image/jpeg", ".png": "image/png", ".spz": "application/octet-stream", ".ply": "application/octet-stream", ".ktx2": "image/ktx2",
  ".i16": "application/octet-stream", ".u8": "application/octet-stream", ".f32": "application/octet-stream",
};

function serveGlobal(): Plugin {
  return {
    name: "marswalk-global-data",
    configureServer(server) {
      for (const [prefix, DIR] of [["/global", GLOBAL_DIR], ["/sites", SITES_DIR]] as const) server.middlewares.use(prefix, (req, res, next) => {
        const rel = normalize(decodeURIComponent((req.url || "/").split("?")[0])).replace(/^([/\\])+/, "");
        const file = join(DIR, rel);
        if (!file.startsWith(DIR) || !existsSync(file) || statSync(file).isDirectory()) return next();
        res.setHeader("Content-Type", TYPES[extname(file)] || "application/octet-stream");
        res.setHeader("Cache-Control", "no-cache"); // re-baked files must show up on reload
        createReadStream(file).pipe(res);
      });
    },
  };
}

// Sim run logs (PRD: save to runs/, allow loading old runs). Dev-server only; local files.
function runsApi(): Plugin {
  return {
    name: "marswalk-runs",
    configureServer(server) {
      server.middlewares.use("/api/runs", (req, res) => {
        const send = (code: number, body: unknown) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); };
        mkdirSync(RUNS_DIR, { recursive: true });
        const name = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "");
        if (req.method === "POST") {
          const chunks: Buffer[] = [];
          req.on("data", (c) => chunks.push(c));
          req.on("end", () => {
            try {
              const run = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              const file = `${String(run.id || Date.now()).replace(/[^\w.-]/g, "_")}.json`;
              writeFileSync(join(RUNS_DIR, file), JSON.stringify(run));
              send(200, { file });
            } catch (e) { send(400, { error: String(e) }); }
          });
          return;
        }
        if (!name) {
          const list = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json")).sort().reverse().map((f) => {
            try { const r = JSON.parse(readFileSync(join(RUNS_DIR, f), "utf8")); return { file: f, created: r.created, outcome: r.outcome, ticks: r.log?.length ?? 0, site: r.site }; }
            catch { return { file: f }; }
          });
          return send(200, list);
        }
        const file = join(RUNS_DIR, normalize(name).replace(/^([/\\])+/, ""));
        if (!file.startsWith(RUNS_DIR) || !existsSync(file)) return send(404, { error: "not found" });
        res.setHeader("Content-Type", "application/json");
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  publicDir: join(DATA_DIR, "processed"),
  plugins: [serveGlobal(), runsApi()],
  server: { port: 5173, open: true },
  worker: { format: "es" },
  build: {
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL("index.html", import.meta.url)),
        phase1: fileURLToPath(new URL("phase1.html", import.meta.url)),
      },
    },
  },
});
