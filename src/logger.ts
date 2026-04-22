import winston from 'winston';

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      return `${timestamp} [${level.toUpperCase()}] ${message}${extra}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: './data/app.log', maxsize: 5_242_880, maxFiles: 3 }),
  ],
});
