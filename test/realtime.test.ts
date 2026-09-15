import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { App } from '../src/app.js'
import {
  bootApp,
  connectClient,
  createRoom,
  firstHello,
  joinRoom,
  login,
  resetDb,
  sendMessage,
  sleep,
  waitFor,
  type ClientSocket,
} from './helpers.js'

let app: App
const sockets: ClientSocket[] = []

beforeAll(async () => {
  app = await bootApp()
})
afterAll(async () => {
  await app.close()
})
beforeEach(resetDb)
afterEach(() => {
  for (const s of sockets.splice(0)) s.disconnect()
})

async function twoUsersInRoom(): Promise<{
  a: ClientSocket
  b: ClientSocket
  roomId: string
  aId: string
  bId: string
}> {
  const alice = await login(app.url, 'alice')
  const bob = await login(app.url, 'bob')
  const roomId = await createRoom(app.url, alice.token, 'dev')
  const a = await connectClient(app.url, alice.token)
  const b = await connectClient(app.url, bob.token)
  sockets.push(a, b)
  expect((await joinRoom(a, roomId)).ok).toBe(true)
  expect((await joinRoom(b, roomId)).ok).toBe(true)
  return { a, b, roomId, aId: alice.userId, bId: bob.userId }
}

describe('authentication', () => {
  it('rejects sockets without a valid JWT', async () => {
    await expect(connectClient(app.url, 'garbage')).rejects.toThrow(/unauthorized/)
  })

  it('validates login payloads', async () => {
    const res = await fetch(`${app.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Bad Name!' }),
    })
    expect(res.status).toBe(422)
  })

  it('greets a connected socket with the instance id', async () => {
    const alice = await login(app.url, 'alice')
    const a = await connectClient(app.url, alice.token)
    sockets.push(a)
    const hello = await firstHello(a)
    expect(hello.instance).toBe(app.config.INSTANCE_ID)
    expect(hello.recovered).toBe(false)
  })
})

describe('messaging', () => {
  it('delivers a message to other members and acks the sender with the persisted row', async () => {
    const { a, b, roomId, aId } = await twoUsersInRoom()
    const incoming = waitFor(b, 'message:new')
    const ack = await sendMessage(a, roomId, 'hello bob')
    expect(ack.ok).toBe(true)
    expect(ack.data).toMatchObject({ body: 'hello bob', sender_id: aId, sender_name: 'alice' })
    expect(ack.data!.id).toBeGreaterThan(0)
    expect(await incoming).toEqual(ack.data)
  })

  it('treats a resend with the same clientMsgId as the same message', async () => {
    const { a, b, roomId } = await twoUsersInRoom()
    const received: unknown[] = []
    b.on('message:new', (m) => received.push(m))
    const id = randomUUID()
    const first = await sendMessage(a, roomId, 'once', id)
    const second = await sendMessage(a, roomId, 'once', id)
    expect(second.data!.id).toBe(first.data!.id)
    await sleep(100)
    expect(received).toHaveLength(1)
  })

  it('rejects invalid payloads and sends to rooms not joined', async () => {
    const { a, roomId } = await twoUsersInRoom()
    expect((await sendMessage(a, roomId, '')).ok).toBe(false)
    expect((await sendMessage(a, roomId, 'x'.repeat(4001))).ok).toBe(false)
    const other = await createRoom(app.url, (await login(app.url, 'alice')).token, 'other')
    const ack = await sendMessage(a, other, 'sneaky')
    expect(ack).toMatchObject({ ok: false, error: 'join the room first' })
  })

  it('pages history newest-first with a keyset cursor', async () => {
    const { a, roomId } = await twoUsersInRoom()
    for (let i = 1; i <= 7; i++) await sendMessage(a, roomId, `m${i}`)
    const token = (await login(app.url, 'alice')).token
    const page1 = (await (
      await fetch(`${app.url}/api/rooms/${roomId}/messages?limit=3`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { messages: { body: string; id: number }[]; nextBefore: number | null }
    expect(page1.messages.map((m) => m.body)).toEqual(['m5', 'm6', 'm7'])
    expect(page1.nextBefore).toBe(page1.messages[0]!.id)
    const page2 = (await (
      await fetch(`${app.url}/api/rooms/${roomId}/messages?limit=3&before=${page1.nextBefore}`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { messages: { body: string }[] }
    expect(page2.messages.map((m) => m.body)).toEqual(['m2', 'm3', 'm4'])
  })
})

describe('typing indicator', () => {
  it('broadcasts typing state to everyone but the sender', async () => {
    const { a, b, roomId, aId } = await twoUsersInRoom()
    let selfEcho = false
    a.on('typing', () => (selfEcho = true))
    const seen = waitFor(b, 'typing')
    a.emit('typing', { roomId, typing: true })
    expect(await seen).toEqual({ roomId, userId: aId, username: 'alice', typing: true })
    await sleep(50)
    expect(selfEcho).toBe(false)
  })
})

describe('read receipts', () => {
  it('broadcasts when a member advances their read cursor, never backwards', async () => {
    const { a, b, roomId, bId } = await twoUsersInRoom()
    const m1 = (await sendMessage(a, roomId, 'one')).data!
    const m2 = (await sendMessage(a, roomId, 'two')).data!

    const seen = waitFor(a, 'message:read', 5000, (e) => e.userId === bId)
    b.emit('message:read', { roomId, messageId: m2.id }, () => {})
    expect(await seen).toEqual({ roomId, userId: bId, messageId: m2.id })

    // Going backwards is ignored: no broadcast.
    let regressed = false
    a.on('message:read', (e) => {
      if (e.userId === bId && e.messageId === m1.id) regressed = true
    })
    await new Promise<void>((r) => b.emit('message:read', { roomId, messageId: m1.id }, () => r()))
    await sleep(100)
    expect(regressed).toBe(false)

    const c = await connectClient(app.url, (await login(app.url, 'carol')).token)
    sockets.push(c)
    const joined = await joinRoom(c, roomId)
    expect(joined.data!.receipts).toContainEqual({ user_id: bId, last_read_message_id: m2.id })
  })

  it('sending a message implies reading everything before it', async () => {
    const { a, b, roomId, aId } = await twoUsersInRoom()
    const seen = waitFor(b, 'message:read', 5000, (e) => e.userId === aId)
    const msg = (await sendMessage(a, roomId, 'yo')).data!
    expect((await seen).messageId).toBe(msg.id)
  })
})

describe('presence', () => {
  it('goes online on first socket and offline only when the last socket leaves', async () => {
    const { a, b, roomId, bId } = await twoUsersInRoom()
    const carol = await login(app.url, 'carol')

    const online = waitFor(a, 'presence', 5000, (e) => e.userId === carol.userId)
    const c1 = await connectClient(app.url, carol.token)
    sockets.push(c1)
    expect(await online).toMatchObject({ username: 'carol', online: true })

    // A second tab for the same user must not re-announce.
    let announcedAgain = false
    a.on('presence', (e) => {
      if (e.userId === carol.userId) announcedAgain = true
    })
    const c2 = await connectClient(app.url, carol.token)
    sockets.push(c2)
    await joinRoom(c2, roomId)
    const joined = await joinRoom(b, roomId)
    expect(joined.data!.online).toEqual(expect.arrayContaining([carol.userId, bId]))

    c1.disconnect()
    await sleep(150)
    expect(announcedAgain).toBe(false)

    const offline = waitFor(a, 'presence', 5000, (e) => e.userId === carol.userId && !e.online)
    c2.disconnect()
    expect(await offline).toMatchObject({ username: 'carol', online: false })
  })
})

describe('reconnection', () => {
  it('room:sync returns everything missed while offline', async () => {
    const { a, b, roomId } = await twoUsersInRoom()
    const last = (await sendMessage(a, roomId, 'before')).data!
    b.disconnect()
    await sendMessage(a, roomId, 'missed 1')
    await sendMessage(a, roomId, 'missed 2')

    b.connect()
    await new Promise<void>((r) => b.once('connect', () => r()))
    const sync = await new Promise<{ ok: boolean; data?: { messages: { body: string }[] } }>(
      (resolve) => b.emit('room:sync', { roomId, afterId: last.id }, resolve),
    )
    expect(sync.ok).toBe(true)
    expect(sync.data!.messages.map((m) => m.body)).toEqual(['missed 1', 'missed 2'])

    // And b is back in the room: live delivery resumes.
    const live = waitFor(b, 'message:new')
    await sendMessage(a, roomId, 'after')
    expect((await live).body).toBe('after')
  })

  it('recovers state automatically after a transient network drop', async () => {
    const { a, b, roomId } = await twoUsersInRoom()
    const hello = waitFor(b, 'hello', 10000, (h) => h.recovered)
    const missed = waitFor(b, 'message:new', 10000)
    // Kill the underlying transport without telling the server: looks like a network blip.
    b.io.engine.close()
    await sendMessage(a, roomId, 'while you were away')
    expect((await hello).recovered).toBe(true)
    expect((await missed).body).toBe('while you were away')
  })
})

describe('rooms api', () => {
  it('lists, creates with validation and rejects duplicates', async () => {
    const { token } = await login(app.url, 'alice')
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
    expect((await fetch(`${app.url}/api/rooms`)).status).toBe(401)
    let res = await fetch(`${app.url}/api/rooms`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Bad Name' }),
    })
    expect(res.status).toBe(422)
    res = await fetch(`${app.url}/api/rooms`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'ops', topic: 'on-call' }),
    })
    expect(res.status).toBe(201)
    res = await fetch(`${app.url}/api/rooms`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'ops' }),
    })
    expect(res.status).toBe(409)
    const rooms = (await (await fetch(`${app.url}/api/rooms`, { headers })).json()) as {
      name: string
    }[]
    expect(rooms.map((r) => r.name)).toEqual(['ops'])
  })

  it('reports health with the instance id', async () => {
    const body = (await (await fetch(`${app.url}/health`)).json()) as Record<string, string>
    expect(body).toMatchObject({ status: 'ok', postgres: 'ok', instance: app.config.INSTANCE_ID })
  })
})
