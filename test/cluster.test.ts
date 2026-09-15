/**
 * Horizontal scaling: two independent server processes (well, instances) share nothing but
 * Postgres and Redis. A client on instance 1 must see messages, typing, read receipts and
 * presence from a client on instance 2. Needs a real Redis → runs in CI, skipped locally
 * unless REDIS_URL is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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
  waitFor,
} from './helpers.js'

const REDIS_URL = process.env.REDIS_URL

describe.skipIf(!REDIS_URL)('multi-instance via Redis Streams adapter', () => {
  let one: App
  let two: App

  beforeAll(async () => {
    one = await bootApp({ REDIS_URL: REDIS_URL!, INSTANCE_ID: 'one' })
    two = await bootApp({ REDIS_URL: REDIS_URL!, INSTANCE_ID: 'two' })
  })
  afterAll(async () => {
    await Promise.all([one.close(), two.close()])
  })
  beforeEach(resetDb)

  it('fans out messages, typing, receipts and presence across instances', async () => {
    const alice = await login(one.url, 'alice')
    const bob = await login(two.url, 'bob')
    const roomId = await createRoom(one.url, alice.token, 'cross')

    const a = await connectClient(one.url, alice.token)
    expect((await firstHello(a)).instance).toBe('one')
    await joinRoom(a, roomId)

    const bobOnline = waitFor(a, 'presence', 5000, (e) => e.userId === bob.userId && e.online)
    const b = await connectClient(two.url, bob.token)
    expect((await firstHello(b)).instance).toBe('two')
    await joinRoom(b, roomId)
    expect(await bobOnline).toMatchObject({ username: 'bob', online: true })

    const typing = waitFor(a, 'typing')
    b.emit('typing', { roomId, typing: true })
    expect((await typing).username).toBe('bob')

    const incoming = waitFor(b, 'message:new')
    const ack = await sendMessage(a, roomId, 'across the wire')
    expect(await incoming).toEqual(ack.data)

    const read = waitFor(a, 'message:read', 5000, (e) => e.userId === bob.userId)
    b.emit('message:read', { roomId, messageId: ack.data!.id }, () => {})
    expect((await read).messageId).toBe(ack.data!.id)

    // Presence is global: instance one sees bob leave instance two.
    const bobOffline = waitFor(a, 'presence', 5000, (e) => e.userId === bob.userId && !e.online)
    b.disconnect()
    expect(await bobOffline).toMatchObject({ online: false })
    a.disconnect()
  })
})
