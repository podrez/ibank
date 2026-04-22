import express from 'express';
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

  return app;
}

export function startApiServer(): void {
  const port = parseInt(process.env.API_PORT ?? '3000');
  const app = createApp();

  app.listen(port, () => {
    logger.info(`REST API listening on port ${port}`);
  });
}
