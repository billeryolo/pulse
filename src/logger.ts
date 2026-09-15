import pino from 'pino'

/**
 * JSON logs to stdout. Every line carries `instance` so logs from horizontally scaled
 * containers can be told apart; request/socket-scoped children add `reqId` / `socketId`.
 */
export function createLogger(level: string, instance: string) {
  return pino({
    level,
    base: { instance },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: ['req.headers.authorization'],
  })
}

export type Logger = ReturnType<typeof createLogger>
