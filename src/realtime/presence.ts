/**
 * Presence = "does this user have at least one live socket on *any* instance?"
 *
 * Redis implementation: one SET per user holding `instance:socketId` members, with a TTL
 * that every instance refreshes on a heartbeat. If an instance dies without cleaning up,
 * its entries simply expire, so a crashed pod cannot leave ghosts online forever.
 * The return value of connect/disconnect tells the caller whether the user's overall state
 * flipped, so an `online`/`offline` broadcast happens exactly once per transition.
 */
import type { RedisClientType } from 'redis'

export interface PresenceStore {
  connect(userId: string, socketId: string): Promise<boolean> // true → user came online
  disconnect(userId: string, socketId: string): Promise<boolean> // true → user went offline
  heartbeat(userIds: string[]): Promise<void>
  isOnline(userId: string): Promise<boolean>
  onlineAmong(userIds: string[]): Promise<string[]>
}

export class MemoryPresence implements PresenceStore {
  private sockets = new Map<string, Set<string>>()

  async connect(userId: string, socketId: string): Promise<boolean> {
    const set = this.sockets.get(userId) ?? new Set<string>()
    const wasOffline = set.size === 0
    set.add(socketId)
    this.sockets.set(userId, set)
    return wasOffline
  }

  async disconnect(userId: string, socketId: string): Promise<boolean> {
    const set = this.sockets.get(userId)
    if (!set) return false
    set.delete(socketId)
    if (set.size === 0) {
      this.sockets.delete(userId)
      return true
    }
    return false
  }

  async heartbeat(): Promise<void> {}

  async isOnline(userId: string): Promise<boolean> {
    return (this.sockets.get(userId)?.size ?? 0) > 0
  }

  async onlineAmong(userIds: string[]): Promise<string[]> {
    return userIds.filter((id) => (this.sockets.get(id)?.size ?? 0) > 0)
  }
}

export class RedisPresence implements PresenceStore {
  constructor(
    private redis: RedisClientType,
    private instance: string,
    private ttlSeconds: number,
  ) {}

  private key(userId: string) {
    return `presence:${userId}`
  }

  async connect(userId: string, socketId: string): Promise<boolean> {
    const key = this.key(userId)
    const [before] = await this.redis
      .multi()
      .sCard(key)
      .sAdd(key, `${this.instance}:${socketId}`)
      .expire(key, this.ttlSeconds)
      .exec()
    return Number(before) === 0
  }

  async disconnect(userId: string, socketId: string): Promise<boolean> {
    const key = this.key(userId)
    const [, after] = await this.redis
      .multi()
      .sRem(key, `${this.instance}:${socketId}`)
      .sCard(key)
      .exec()
    return Number(after) === 0
  }

  async heartbeat(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return
    const multi = this.redis.multi()
    for (const id of userIds) multi.expire(this.key(id), this.ttlSeconds)
    await multi.exec()
  }

  async isOnline(userId: string): Promise<boolean> {
    return (await this.redis.exists(this.key(userId))) === 1
  }

  async onlineAmong(userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) return []
    const multi = this.redis.multi()
    for (const id of userIds) multi.exists(this.key(id))
    const results = await multi.exec()
    return userIds.filter((_, i) => Number(results[i]) === 1)
  }
}
