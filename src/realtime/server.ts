import type { Server as HttpServer } from 'node:http'
import { Server, type Socket } from 'socket.io'
import { z } from 'zod'
import type { Auth } from '../auth.js'
import type { Config } from '../config.js'
import type { Queries } from '../db/queries.js'
import type { Logger } from '../logger.js'
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from './events.js'
import type { PresenceStore } from './presence.js'

export type IoServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<never, never>,
  SocketData
>
type IoSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<never, never>, SocketData>

const roomIdSchema = z.object({ roomId: z.string().uuid() })
const sendSchema = roomIdSchema.extend({
  body: z.string().trim().min(1).max(4000),
  clientMsgId: z.string().uuid(),
})
const readSchema = roomIdSchema.extend({ messageId: z.number().int().positive() })
const syncSchema = roomIdSchema.extend({ afterId: z.number().int().nonnegative() })
const typingSchema = roomIdSchema.extend({ typing: z.boolean() })

/** Socket.IO room names: `room:<id>` for chat rooms, `user:<id>` for per-user fan-out. */
const roomKey = (roomId: string) => `room:${roomId}`

export interface RealtimeDeps {
  config: Config
  auth: Auth
  db: Queries
  presence: PresenceStore
  log: Logger
  adapter?: Parameters<Server['adapter']>[0]
}

export function createRealtime(httpServer: HttpServer, deps: RealtimeDeps): IoServer {
  const { config, auth, db, presence, log } = deps

  const io: IoServer = new Server(httpServer, {
    cors: { origin: true },
    // Lets a client that reconnects within the window resume its rooms and receive the
    // packets it missed, without any application code. The Redis Streams adapter supports
    // this across instances; the in-memory adapter within one.
    connectionStateRecovery: { maxDisconnectionDuration: config.RECOVERY_WINDOW_MS },
    pingInterval: 20_000,
    pingTimeout: 20_000,
  })
  if (deps.adapter) io.adapter(deps.adapter)

  // --- authentication: JWT in the handshake -------------------------------------------
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token
    if (typeof token !== 'string') return next(new Error('unauthorized: missing token'))
    try {
      const identity = auth.verify(token)
      socket.data.userId = identity.userId
      socket.data.username = identity.username
      next()
    } catch {
      next(new Error('unauthorized: invalid token'))
    }
  })

  // --- presence heartbeat --------------------------------------------------------------
  const heartbeat = setInterval(
    async () => {
      const users = new Set<string>()
      for (const socket of await io.local.fetchSockets()) users.add(socket.data.userId)
      await presence
        .heartbeat([...users])
        .catch((err) => log.warn({ err }, 'presence heartbeat failed'))
    },
    (config.PRESENCE_TTL_SECONDS * 1000) / 2,
  )
  heartbeat.unref()
  io.on('close' as never, () => clearInterval(heartbeat))

  io.on('connection', async (socket: IoSocket) => {
    const { userId, username } = socket.data
    const slog = log.child({ socketId: socket.id, userId })
    slog.info({ recovered: socket.recovered }, 'socket connected')

    socket.join(`user:${userId}`)
    socket.emit('hello', { instance: config.INSTANCE_ID, userId, recovered: socket.recovered })

    // Presence: broadcast only on the offline→online edge, to everyone sharing a room.
    const cameOnline = await presence.connect(userId, socket.id)
    if (cameOnline) io.emit('presence', { userId, username, online: true })

    socket.on('room:join', async (payload, ack) => {
      const parsed = roomIdSchema.safeParse(payload)
      if (!parsed.success) return ack({ ok: false, error: 'invalid payload' })
      const { roomId } = parsed.data
      const room = await db.getRoom(roomId)
      if (!room) return ack({ ok: false, error: 'room not found' })

      const alreadyMember = await db.isMember(roomId, userId)
      await db.joinRoom(roomId, userId)
      await socket.join(roomKey(roomId))
      if (!alreadyMember) {
        socket
          .to(roomKey(roomId))
          .emit('room:member', { roomId, user: { id: userId, username, display_name: username } })
      }
      const members = await db.roomMembers(roomId)
      const [online, receipts, messages] = await Promise.all([
        presence.onlineAmong(members.map((m) => m.id)),
        db.receipts(roomId),
        db.listMessages(roomId, null, 50),
      ])
      slog.info({ roomId }, 'joined room')
      ack({ ok: true, data: { members, online, receipts, messages } })
    })

    socket.on('room:leave', async (payload, ack) => {
      const parsed = roomIdSchema.safeParse(payload)
      if (!parsed.success) return ack({ ok: false, error: 'invalid payload' })
      await socket.leave(roomKey(parsed.data.roomId))
      ack({ ok: true })
    })

    socket.on('message:send', async (payload, ack) => {
      const parsed = sendSchema.safeParse(payload)
      if (!parsed.success) return ack({ ok: false, error: 'invalid payload' })
      const { roomId, body, clientMsgId } = parsed.data
      if (!socket.rooms.has(roomKey(roomId)))
        return ack({ ok: false, error: 'join the room first' })

      const { message, duplicate } = await db.insertMessage(roomId, userId, body, clientMsgId)
      if (!duplicate) {
        // Persisted → fan out to every instance (adapter) except the sender, who gets the ack.
        socket.to(roomKey(roomId)).emit('message:new', message)
        // Sending implies having read everything up to your own message.
        await db.markRead(roomId, userId, message.id)
        socket.to(roomKey(roomId)).emit('message:read', { roomId, userId, messageId: message.id })
      } else {
        slog.info({ clientMsgId }, 'duplicate send ignored')
      }
      ack({ ok: true, data: message })
    })

    socket.on('message:read', async (payload, ack) => {
      const parsed = readSchema.safeParse(payload)
      if (!parsed.success) return ack({ ok: false, error: 'invalid payload' })
      const { roomId, messageId } = parsed.data
      if (!socket.rooms.has(roomKey(roomId)))
        return ack({ ok: false, error: 'join the room first' })
      const advanced = await db.markRead(roomId, userId, messageId)
      if (advanced) io.to(roomKey(roomId)).emit('message:read', { roomId, userId, messageId })
      ack({ ok: true })
    })

    // After a reconnect that fell outside the recovery window the client asks for what it
    // missed, keyed by the last message id it has. Cheap thanks to (room_id, id) index.
    socket.on('room:sync', async (payload, ack) => {
      const parsed = syncSchema.safeParse(payload)
      if (!parsed.success) return ack({ ok: false, error: 'invalid payload' })
      const { roomId, afterId } = parsed.data
      if (!(await db.isMember(roomId, userId))) return ack({ ok: false, error: 'not a member' })
      await socket.join(roomKey(roomId))
      const members = await db.roomMembers(roomId)
      const [messages, receipts, online] = await Promise.all([
        db.messagesAfter(roomId, afterId),
        db.receipts(roomId),
        presence.onlineAmong(members.map((m) => m.id)),
      ])
      ack({ ok: true, data: { messages, receipts, online } })
    })

    // Typing is ephemeral: no persistence, no ack, volatile so it is dropped under pressure.
    socket.on('typing', (payload) => {
      const parsed = typingSchema.safeParse(payload)
      if (!parsed.success) return
      const { roomId, typing } = parsed.data
      if (!socket.rooms.has(roomKey(roomId))) return
      socket.to(roomKey(roomId)).volatile.emit('typing', { roomId, userId, username, typing })
    })

    socket.on('disconnect', async (reason) => {
      slog.info({ reason }, 'socket disconnected')
      const wentOffline = await presence.disconnect(userId, socket.id)
      if (wentOffline) io.emit('presence', { userId, username, online: false })
    })
  })

  return io
}
