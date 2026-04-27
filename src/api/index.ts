import express from 'express';
import path from 'path';
import { router } from './routes';
import { logger } from '../logger';

export function createApp() {
  const app = express();

  app.use(express.json());

  // Request logging
  app.use((req, _res, next) => {
    logger.debug(`${req.method} ${req.path}`);
    next();
  });

  app.use('/api', router);

  // Health check (no auth required)
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Web UI — served from public/ relative to the project root
  const publicDir = path.join(__dirname, '../../public');
  app.use(express.static(publicDir));

  return app;
}

export function startApiServer(): void {
  const port = parseInt(process.env.API_PORT ?? '3000');
  const app = createApp();

  app.listen(port, () => {
    logger.info(`REST API listening on port ${port}`);
  });
}
