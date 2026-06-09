import pino from 'pino'
import { env } from './env.js'

const isDev = env.NODE_ENV === 'development'

export const logger = pino({
  level: isDev ? 'debug' : 'info',
  base: {
    service: 'kuma',
    env: env.NODE_ENV,
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.token',
      '*.apiKey',
      '*.api_key',
      'ANTHROPIC_API_KEY',
      'DATABASE_URL',
      'REDIS_URL',
    ],
    censor: '[REDACTED]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname,service,env',
            singleLine: false,
          },
        },
      }
    : {}),
})

export type Logger = typeof logger
