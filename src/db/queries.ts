import type { Pool } from 'pg'

export interface User {
  id: string
  username: string
  display_name: string
}

export interface Room {
  id: string
  name: string
  topic: string
  created_at: string
}

export interface Message {
  id: number
  room_id: string
  sender_id: string
  sender_name: string
  body: string
  client_msg_id: string
  created_at: string
}

export interface Receipt {
  user_id: string
  last_read_message_id: number
}

const MESSAGE_COLUMNS = `m.id, m.room_id, m.sender_id, u.username AS sender_name, m.body, m.client_msg_id, m.created_at`

export function queries(pool: Pool) {
  return {
    async upsertUser(username: string, displayName: string): Promise<User> {
      const { rows } = await pool.query<User>(
        `INSERT INTO users (username, display_name) VALUES ($1, $2)
         ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id, username, display_name`,
        [username, displayName],
      )
      return rows[0]!
    },

    async getUser(id: string): Promise<User | null> {
      const { rows } = await pool.query<User>(
        'SELECT id, username, display_name FROM users WHERE id = $1',
        [id],
      )
      return rows[0] ?? null
    },

    async listRooms(): Promise<(Room & { members: number })[]> {
      const { rows } = await pool.query(
        `SELECT r.id, r.name, r.topic, r.created_at, count(rm.user_id)::int AS members
         FROM rooms r LEFT JOIN room_members rm ON rm.room_id = r.id
         GROUP BY r.id ORDER BY r.created_at`,
      )
      return rows
    },

    async createRoom(name: string, topic: string, createdBy: string): Promise<Room> {
      const { rows } = await pool.query<Room>(
        `INSERT INTO rooms (name, topic, created_by) VALUES ($1, $2, $3)
         RETURNING id, name, topic, created_at`,
        [name, topic, createdBy],
      )
      return rows[0]!
    },

    async getRoom(id: string): Promise<Room | null> {
      const { rows } = await pool.query<Room>(
        'SELECT id, name, topic, created_at FROM rooms WHERE id = $1',
        [id],
      )
      return rows[0] ?? null
    },

    async joinRoom(roomId: string, userId: string): Promise<void> {
      await pool.query(
        'INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [roomId, userId],
      )
    },

    async isMember(roomId: string, userId: string): Promise<boolean> {
      const { rowCount } = await pool.query(
        'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
        [roomId, userId],
      )
      return (rowCount ?? 0) > 0
    },

    async roomMembers(roomId: string): Promise<User[]> {
      const { rows } = await pool.query<User>(
        `SELECT u.id, u.username, u.display_name FROM room_members rm
         JOIN users u ON u.id = rm.user_id WHERE rm.room_id = $1 ORDER BY u.username`,
        [roomId],
      )
      return rows
    },

    /**
     * Idempotent insert: the (room, sender, client_msg_id) unique constraint turns a resend
     * after a lost ack into a no-op that returns the original message.
     */
    async insertMessage(
      roomId: string,
      senderId: string,
      body: string,
      clientMsgId: string,
    ): Promise<{ message: Message; duplicate: boolean }> {
      const inserted = await pool.query<{ id: number }>(
        `INSERT INTO messages (room_id, sender_id, body, client_msg_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (room_id, sender_id, client_msg_id) DO NOTHING
         RETURNING id`,
        [roomId, senderId, body, clientMsgId],
      )
      const duplicate = inserted.rowCount === 0
      const { rows } = await pool.query<Message>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.room_id = $1 AND m.sender_id = $2 AND m.client_msg_id = $3`,
        [roomId, senderId, clientMsgId],
      )
      return { message: rows[0]!, duplicate }
    },

    /** Newest-first page, keyset-paginated by `before` (message id). */
    async listMessages(roomId: string, before: number | null, limit: number): Promise<Message[]> {
      const { rows } = await pool.query<Message>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.room_id = $1 AND ($2::bigint IS NULL OR m.id < $2)
         ORDER BY m.id DESC LIMIT $3`,
        [roomId, before, limit],
      )
      return rows.reverse()
    },

    /** Everything after `afterId`, oldest first — what a reconnecting client missed. */
    async messagesAfter(roomId: string, afterId: number, limit = 500): Promise<Message[]> {
      const { rows } = await pool.query<Message>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.room_id = $1 AND m.id > $2 ORDER BY m.id ASC LIMIT $3`,
        [roomId, afterId, limit],
      )
      return rows
    },

    /** Monotonic: a receipt never moves backwards. Returns the row only if it advanced. */
    async markRead(roomId: string, userId: string, messageId: number): Promise<Receipt | null> {
      const { rows } = await pool.query<Receipt>(
        `INSERT INTO read_receipts (room_id, user_id, last_read_message_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (room_id, user_id) DO UPDATE
           SET last_read_message_id = EXCLUDED.last_read_message_id, updated_at = now()
           WHERE read_receipts.last_read_message_id < EXCLUDED.last_read_message_id
         RETURNING user_id, last_read_message_id`,
        [roomId, userId, messageId],
      )
      return rows[0] ?? null
    },

    async receipts(roomId: string): Promise<Receipt[]> {
      const { rows } = await pool.query<Receipt>(
        'SELECT user_id, last_read_message_id FROM read_receipts WHERE room_id = $1',
        [roomId],
      )
      return rows
    },
  }
}

export type Queries = ReturnType<typeof queries>
