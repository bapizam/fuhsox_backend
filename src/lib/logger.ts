import pino from 'pino';

const isDev = process.env['NODE_ENV'] !== 'production';

const logger = pino({
  level: isDev ? 'debug' : 'info',
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize:      true,
        translateTime: 'SYS:standard',
        ignore:        'pid,hostname',
      },
    },
  }),
  base: {
    service: 'fuhsox-api',
    env:     process.env['NODE_ENV'] ?? 'development',
  },
  redact: {
    paths:  ['req.headers.authorization', 'req.body.password', 'req.body.otp'],
    censor: '[REDACTED]',
  },
});

export default logger;
