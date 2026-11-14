import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { getDb } from './server/db/schema';
import { seedPlatformData } from './server/db/seed';
import { createApiRouter } from './server/routes/api';
import { startBackgroundWorker } from './server/intelligence/scheduler';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3000);

  app.use(express.json({ limit: '2mb' }));

  // Initialize persistent SQLite database and idempotent regional/demo seed
  const db = getDb();
  seedPlatformData(db);
  startBackgroundWorker(db);

  // Mount versioned API routes
  app.use('/api/v1', createApiRouter(db));

  // Vite middleware in dev, or serve built dist/ in production
  if (process.env.NODE_ENV === 'production') {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`KhetPatch server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start KhetPatch server:', err);
  process.exit(1);
});
