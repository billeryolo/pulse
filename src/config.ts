import { z } from 'zod'
import os from 'node:os'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).default(3000), // 0 = random free port (tests)
  INSTANCE_ID: z.string().min(1).default(`${os.hostname()}-${process.pid}`),
  DATABASE_URL: z.string().url().default('postgresql://pulse:pulse@localhost:5432/pulse'),
  /** Unset → single-instance in-memory adapter/presence (dev + unit tests). */
  REDIS_URL: z.string().url().optional(),
  JWT_SECRET: z.string().min(32).default('dev-only-secret-please-change-me-32-bytes'),
  JWT_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24),
  LOG_LEVEL: z.string().default('info'),
  SENTRY_DSN: z.string().optional(),
  /** Presence keys expire after this; heartbeats refresh them at half the interval. */
  PRESENCE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  /** How long a disconnected socket may recover its state (missed packets) on reconnect. */
  RECOVERY_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 60 * 1000),
})

export type Config = z.infer<typeof schema>

export function loadConfig(overrides: Partial<Record<keyof Config, string>> = {}): Config {
  const parsed = schema.safeParse({ ...process.env, ...overrides })
  if (!parsed.success) {
    throw new Error(
      `Invalid configuration:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    )
  }
  return parsed.data
}
