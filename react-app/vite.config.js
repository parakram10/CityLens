import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dev-only: serve the backend pipeline's live js/live.json fresh on every request,
// so `npm run dev` reflects new detector runs without a stale copy in public/.
// (In production, backend/serve.py maps /live.json to js/live.json directly.)
function liveJsonDevMiddleware() {
  return {
    name: 'citylens-live-json-dev',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || req.url.split('?')[0] !== '/live.json') return next();
        fs.readFile(path.resolve(__dirname, '../js/live.json'), (err, data) => {
          if (err) { res.statusCode = 404; res.end(); return; }
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(data);
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), liveJsonDevMiddleware()],
  build: {
    // Avoid colliding with /assets/* (evidence photos, served from the repo's real
    // assets/ dir by backend/serve.py) which also lives at the web root.
    assetsDir: '_assets',
    // /assets and /runs are served straight from the repo root in production
    // (backend/serve.py) — skip copying the symlinked 130MB+ of video/photos into dist.
    copyPublicDir: false,
  },
});
