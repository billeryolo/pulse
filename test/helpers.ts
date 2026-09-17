import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { io as connect, type Socket } from 'socket.io-client'
import { createApp, type App } from '../src/app.js'
import type { ClientToServerEvents, ServerToClientEvents } from '../src/realtime/events.js'

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://pulse:pulse@localhost:5432/pulse_test'

export type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>

export async function bootApp(extra: Record<string, string> = {}): Promise<App> {
  return createApp({
    // Single-instance (in-memory adapter + presence) unless a test passes REDIS_URL
    // explicitly; CI exports REDIS_URL globally for the cluster suite.
    REDIS_URL: undefined as unknown as string,
    NODE_ENV: 'test',
    PORT: '0',
    LOG_LEVEL: 'silent',
    DATABASE_URL: TEST_DATABASE_URL,
    INSTANCE_ID: extra.INSTANCE_ID ?? `test-${randomUUID().slice(0, 8)}`,
    PRESENCE_TTL_SECONDS: '5',
    ...extra,
  })
}

export async function resetDb(): Promise<void> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL })
  await pool.query('TRUNCATE users, rooms, room_members, messages, read_receipts CASCADE')
  await pool.end()
}

export async function login(
  url: string,
  username: string,
): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { token: string; user: { id: string } }
  return { token: body.token, userId: body.user.id }
}

export async function createRoom(url: string, token: string, name: string): Promise<string> {
  const res = await fetch(`${url}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  })
  if (res.status !== 201) throw new Error(`createRoom failed: ${res.status}`)
  return ((await res.json()) as { id: string }).id
}

const hellos = new WeakMap<ClientSocket, Promise<{ instance: string; recovered: boolean }>>()

export function connectClient(url: string, token: string): Promise<ClientSocket> {
  const socket: ClientSocket = connect(url, {
    auth: { token },
    transports: ['websocket'],
    reconnectionDelay: 50,
    reconnectionDelayMax: 200,
    autoConnect: false,
  })
  // `hello` is emitted the instant the server accepts the socket, which can be before the
  // test gets a chance to listen — capture the first one up front.
  hellos.set(socket, new Promise((resolve) => socket.once('hello', resolve)))
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket))
    socket.once('connect_error', reject)
    socket.connect()
  })
}

export function firstHello(socket: ClientSocket) {
  return hellos.get(socket)!
}

export function joinRoom(socket: ClientSocket, roomId: string) {
  return new Promise<Parameters<Parameters<ClientToServerEvents['room:join']>[1]>[0]>((resolve) =>
    socket.emit('room:join', { roomId }, resolve),
  )
}

export function sendMessage(
  socket: ClientSocket,
  roomId: string,
  body: string,
  clientMsgId = randomUUID(),
) {
  return new Promise<Parameters<Parameters<ClientToServerEvents['message:send']>[1]>[0]>(
    (resolve) => socket.emit('message:send', { roomId, body, clientMsgId }, resolve),
  )
}

/** Resolve with the next `event` payload, or reject after `ms`. */
export function waitFor<K extends keyof ServerToClientEvents>(
  socket: ClientSocket,
  event: K,
  ms = 5000,
  predicate?: (payload: Parameters<ServerToClientEvents[K]>[0]) => boolean,
): Promise<Parameters<ServerToClientEvents[K]>[0]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler as never)
      reject(new Error(`timed out waiting for ${String(event)}`))
    }, ms)
    const handler = (payload: Parameters<ServerToClientEvents[K]>[0]) => {
      if (predicate && !predicate(payload)) return
      clearTimeout(timer)
      socket.off(event, handler as never)
      resolve(payload)
    }
    socket.on(event, handler as never)
  })
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
