/**
 * Wires everything together. Exported as a factory so tests can boot several instances
 * (each with its own port and INSTANCE_ID) against one Postgres and one Redis.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createAdapter } from '@socket.io/redis-streams-adapter'
import { createClient, type RedisClientType } from 'redis'
import * as Sentry from '@sentry/node'
import { createAuth } from './auth.js'
import { loadConfig, type Config } from './config.js'
import { migrate } from './db/migrate.js'
import { createPool } from './db/pool.js'
import { queries } from './db/queries.js'
import { createHttp } from './http.js'
import { createLogger } from './logger.js'
import { MemoryPresence, RedisPresence, type PresenceStore } from './realtime/presence.js'
import { createRealtime, type IoServer } from './realtime/server.js'

export interface App {
  config: Config
  io: IoServer
  port: number
  url: string
  close(): Promise<void>
}

export async function createApp(
  overrides: Partial<Record<keyof Config, string>> = {},
): Promise<App> {
  const config = loadConfig(overrides)
  const log = createLogger(config.LOG_LEVEL, config.INSTANCE_ID)

  if (config.SENTRY_DSN) {
    Sentry.init({ dsn: config.SENTRY_DSN, environment: config.NODE_ENV, tracesSampleRate: 0.1 })
  }

  const pool = createPool(config.DATABASE_URL)
  await migrate(pool, (m) => log.info(m))
  const db = queries(pool)
  const auth = createAuth(config.JWT_SECRET, config.JWT_TTL_SECONDS)

  let redis: RedisClientType | null = null
  let presence: PresenceStore
  let adapter: ReturnType<typeof createAdapter> | undefined
  if (config.REDIS_URL) {
    redis = createClient({ url: config.REDIS_URL })
    redis.on('error', (err) => log.error({ err }, 'redis error'))
    await redis.connect()
    presence = new RedisPresence(redis, config.INSTANCE_ID, config.PRESENCE_TTL_SECONDS)
    // Streams (XADD/XREAD) rather than pub/sub: every instance reads the same stream, and
    // it keeps a history so connection-state recovery works across instances.
    adapter = createAdapter(redis, { streamName: 'pulse:socket.io', maxLen: 10_000 })
    log.info('redis adapter enabled: multi-instance mode')
  } else {
    presence = new MemoryPresence()
    log.warn('REDIS_URL not set: single-instance mode (in-memory adapter and presence)')
  }

  const healthChecks = async () => {
    const checks: Record<string, string> = {}
    try {
      await pool.query('SELECT 1')
      checks.postgres = 'ok'
    } catch (err) {
      checks.postgres = `error: ${(err as Error).message}`
    }
    if (redis) {
      try {
        await redis.ping()
        checks.redis = 'ok'
      } catch (err) {
        checks.redis = `error: ${(err as Error).message}`
      }
    }
    return checks
  }

  const http = createHttp({ auth, db, presence, log, instance: config.INSTANCE_ID, healthChecks })
  const server = createServer(http)
  const io = createRealtime(server, { config, auth, db, presence, log, adapter })

  await new Promise<void>((resolve) => server.listen(config.PORT, resolve))
  const port = (server.address() as AddressInfo).port
  log.info({ port }, 'listening')

  return {
    config,
    io,
    port,
    url: `http://localhost:${port}`,
    async close() {
      io.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (redis) await redis.quit()
      await pool.end()
    },
  }
}
