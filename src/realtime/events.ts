/**
 * Typed Socket.IO contract. The browser client in /public mirrors these names.
 *
 * Every client→server event that mutates state takes an acknowledgement callback so the
 * client knows whether the server persisted it — "sent" vs "sending" in the UI.
 */
import type { Message, Receipt, User } from '../db/queries.js'

export interface Ack<T = undefined> {
  ok: boolean
  error?: string
  data?: T
}

export interface TypingEvent {
  roomId: string
  userId: string
  username: string
  typing: boolean
}

export interface ReadEvent {
  roomId: string
  userId: string
  messageId: number
}

export interface PresenceEvent {
  userId: string
  username: string
  online: boolean
}

export interface ClientToServerEvents {
  'room:join': (
    payload: { roomId: string },
    ack: (
      r: Ack<{ members: User[]; online: string[]; receipts: Receipt[]; messages: Message[] }>,
    ) => void,
  ) => void
  'room:leave': (payload: { roomId: string }, ack: (r: Ack) => void) => void
  'message:send': (
    payload: { roomId: string; body: string; clientMsgId: string },
    ack: (r: Ack<Message>) => void,
  ) => void
  'message:read': (payload: { roomId: string; messageId: number }, ack: (r: Ack) => void) => void
  'room:sync': (
    payload: { roomId: string; afterId: number },
    ack: (r: Ack<{ messages: Message[]; receipts: Receipt[]; online: string[] }>) => void,
  ) => void
  typing: (payload: { roomId: string; typing: boolean }) => void
}

export interface ServerToClientEvents {
  'message:new': (message: Message) => void
  'message:read': (event: ReadEvent) => void
  typing: (event: TypingEvent) => void
  presence: (event: PresenceEvent) => void
  'room:member': (event: { roomId: string; user: User }) => void
  hello: (info: { instance: string; userId: string; recovered: boolean }) => void
}

export interface SocketData {
  userId: string
  username: string
}
