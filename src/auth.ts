import jwt from 'jsonwebtoken'

export interface Identity {
  userId: string
  username: string
}

export function createAuth(secret: string, ttlSeconds: number) {
  return {
    sign(identity: Identity): string {
      return jwt.sign({ sub: identity.userId, username: identity.username }, secret, {
        algorithm: 'HS256',
        expiresIn: ttlSeconds,
      })
    },
    verify(token: string): Identity {
      const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as jwt.JwtPayload
      if (typeof payload.sub !== 'string' || typeof payload.username !== 'string') {
        throw new Error('malformed token')
      }
      return { userId: payload.sub, username: payload.username }
    },
  }
}

export type Auth = ReturnType<typeof createAuth>
