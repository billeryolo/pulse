import express, { type Request, type Response, type NextFunction } from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pinoHttp } from 'pino-http'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Auth } from './auth.js'
import type { Queries } from './db/queries.js'
import type { Logger } from './logger.js'
import type { PresenceStore } from './realtime/presence.js'

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public')

const loginSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_]{2,32}$/, 'lowercase letters, digits, underscore; 2–32 chars'),
  displayName: z.string().trim().min(1).max(64).optional(),
})
const roomSchema = z.object({
  name: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{2,64}$/),
  topic: z.string().trim().max(200).default(''),
})
const pageSchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export interface HttpDeps {
  auth: Auth
  db: Queries
  presence: PresenceStore
  log: Logger
  instance: string
  healthChecks: () => Promise<Record<string, 'ok' | string>>
}

export function createHttp({ auth, db, presence, log, instance, healthChecks }: HttpDeps) {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '32kb' }))
  app.use(
    pinoHttp({
      logger: log,
      genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
      autoLogging: {
        ignore: (req) => req.url === '/health' || req.url?.startsWith('/socket.io') === true,
      },
      customSuccessMessage: () => 'request',
    }),
  )
  app.use((req, res, next) => {
    res.setHeader('X-Request-ID', String(req.id))
    next()
  })

  app.get('/health', async (_req, res) => {
    const checks = await healthChecks()
    const ok = Object.values(checks).every((v) => v === 'ok')
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', instance, ...checks })
  })

  // Demo auth: any username gets an identity. A real product would put a password or OAuth
  // here; the interesting part is downstream (JWT in the socket handshake).
  app.post('/api/auth/login', async (req, res) => {
    const parsed = loginSchema.safeParse(req.body)
    if (!parsed.success) return res.status(422).json({ error: parsed.error.issues })
    const user = await db.upsertUser(
      parsed.data.username,
      parsed.data.displayName ?? parsed.data.username,
    )
    const token = auth.sign({ userId: user.id, username: user.username })
    res.json({ token, user })
  })

  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    if (!token) return res.status(401).json({ error: 'missing bearer token' })
    try {
      res.locals.identity = auth.verify(token)
      next()
    } catch {
      res.status(401).json({ error: 'invalid token' })
    }
  }

  app.get('/api/rooms', requireAuth, async (_req, res) => {
    res.json(await db.listRooms())
  })

  app.post('/api/rooms', requireAuth, async (req, res) => {
    const parsed = roomSchema.safeParse(req.body)
    if (!parsed.success) return res.status(422).json({ error: parsed.error.issues })
    try {
      const room = await db.createRoom(
        parsed.data.name,
        parsed.data.topic,
        res.locals.identity.userId,
      )
      res.status(201).json(room)
    } catch (err) {
      if ((err as { code?: string }).code === '23505')
        return res.status(409).json({ error: 'room exists' })
      throw err
    }
  })

  app.get('/api/rooms/:id/messages', requireAuth, async (req, res) => {
    const room = await db.getRoom(String(req.params.id))
    if (!room) return res.status(404).json({ error: 'room not found' })
    const page = pageSchema.safeParse(req.query)
    if (!page.success) return res.status(422).json({ error: page.error.issues })
    const messages = await db.listMessages(room.id, page.data.before ?? null, page.data.limit)
    res.json({
      messages,
      nextBefore: messages.length === page.data.limit ? messages[0]!.id : null,
    })
  })

  app.get('/api/rooms/:id/members', requireAuth, async (req, res) => {
    const members = await db.roomMembers(String(req.params.id))
    const online = new Set(await presence.onlineAmong(members.map((m) => m.id)))
    res.json(members.map((m) => ({ ...m, online: online.has(m.id) })))
  })

  app.use(express.static(PUBLIC_DIR))

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    req.log.error({ err }, 'unhandled error')
    res.status(500).json({ error: 'internal error', requestId: req.id })
  })

  return app
}
