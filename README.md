# Pulse — real-time chat that scales sideways

Node 22 · TypeScript · Socket.IO 4 · Redis Streams adapter · PostgreSQL 16 · Express · Zod · Docker Compose (2 instances + nginx) · GitHub Actions

Rooms, presence, typing indicators, delivery acknowledgements and read receipts — the
messenger feature set — built so that users connected to _different server instances_ talk
to each other, and so that a dropped connection is recovered without losing messages.

```
docker compose up --build
```

| URL                           | What                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------- |
| http://localhost:3000         | nginx load balancer (`ip_hash`) in front of two instances                       |
| http://localhost:3001 / :3002 | the two instances directly — open one tab on each to watch messages cross Redis |
| `GET /health`                 | `{status, instance, postgres, redis}`                                           |

The header of the UI shows which instance the tab is connected to.

---

## Architecture

```
  browser A ──ws──▶ chat-1 ─┐                       ┌──▶ Postgres  (users, rooms, messages, receipts)
                            ├── Redis Streams ──────┤
  browser B ──ws──▶ chat-2 ─┘   (XADD / XREAD)      └──▶ Redis     (adapter stream + presence sets)
         ▲
         └── nginx :3000 (ip_hash sticky)  or straight to :3001 / :3002
```

```
src/
  index.ts             bootstrap + graceful shutdown (SIGTERM closes sockets so clients reconnect elsewhere)
  app.ts               factory: config → pool → migrate → auth → Redis (adapter + presence) → HTTP → Socket.IO
  config.ts            zod-validated environment
  http.ts              Express: /api/auth/login, /api/rooms, /api/rooms/:id/messages (keyset pagination), static client
  auth.ts              HS256 JWT issue/verify (also used for the socket handshake)
  logger.ts            pino JSON, `instance` on every line, `reqId`/`socketId` children
  db/migrate.ts        forward-only SQL migrator with an advisory lock (safe when N instances boot at once)
  db/queries.ts        every SQL statement, typed
  realtime/events.ts   the typed client↔server event contract
  realtime/presence.ts PresenceStore: Redis (multi-instance) or in-memory (dev/tests)
  realtime/server.ts   Socket.IO: JWT middleware, rooms, messages, receipts, typing, sync, recovery
migrations/001_init.sql
public/index.html      dependency-free browser client
test/                  vitest: 15 single-instance tests + a 2-instance Redis test (CI)
```

### Horizontal scaling: Redis Streams adapter

Socket.IO's default adapter only knows about sockets in its own process. With
`@socket.io/redis-streams-adapter` every `io.to(room).emit(...)` is appended to one Redis
stream that all instances read, so a message sent on `chat-1` reaches members connected to
`chat-2`. Streams were chosen over classic pub/sub because the stream keeps a short history
(`maxLen: 10000`), which is what makes **connection state recovery** work across instances
(see below). `test/cluster.test.ts` boots two instances against one Redis and asserts that
messages, typing, receipts and presence cross the boundary.

nginx uses `ip_hash` so the HTTP long-polling fallback stays on one instance; WebSocket-only
clients don't strictly need stickiness.

### Presence (online / offline)

"Online" means _at least one live socket on any instance_. Redis holds one set per user
(`presence:<userId>`) of `instance:socketId` members with a TTL; every instance refreshes the
TTL for its connected users on a heartbeat (half the TTL). Consequences:

- Two tabs for one user → one `online` event, and `offline` only when the last tab closes
  (the store returns whether the user's state _flipped_, so broadcasts happen once).
- An instance that dies without cleaning up cannot leave ghosts: its entries expire.
- `room:join` returns which members are currently online, so a fresh tab is correct instantly.

### Reconnection

Two layers, because they cover different outage lengths:

1. **Socket.IO connection state recovery** (`connectionStateRecovery`, 2-minute window). On a
   transient drop the client reconnects with its previous session id; the server restores its
   rooms and replays the packets it missed from the adapter's stream. The client sees
   `hello.recovered === true` and nothing else to do.
   `test: 'recovers state automatically after a transient network drop'` kills the transport
   under the client, sends a message meanwhile, and asserts it arrives with `recovered: true`.
2. **Application-level `room:sync`** for anything longer. The client remembers the last
   message id it has; after a non-recovered reconnect it asks for `messages WHERE id > $last`
   (cheap thanks to `bigserial` ids and the `(room_id, id)` index), plus current receipts and
   presence.

Sends are safe to retry: every message carries a client-generated `clientMsgId` and the table
has `UNIQUE (room_id, sender_id, client_msg_id)`, so a resend after a lost acknowledgement
returns the original row instead of duplicating it. The browser client uses a 5 s ack timeout
and re-sends on reconnect.

### Delivery acknowledgements and read receipts

- `message:send` is acknowledged only after the `INSERT` commits; the ack carries the
  persisted row (id, timestamp). The UI shows the bubble faded until then, then `✓`.
- Read state is one row per `(room, user)` — the highest message id read — rather than one
  row per message per user. `message:read` is monotonic (`… WHERE last_read < EXCLUDED`) and
  only broadcasts when the cursor actually advanced. Sending a message implicitly marks
  everything before it as read. The UI renders `✓✓ N` from the receipts map.

### Typing indicator

`typing {roomId, typing}` is broadcast to the room with `.volatile` (dropped if the socket is
not writable — nobody wants a queue of stale "is typing"), never persisted, never acknowledged.
The client debounces to one `true` and one `false` per burst and auto-clears after 3 s.

### Validation and auth

Every socket payload is parsed with zod before it touches the database (`invalid payload`
acks otherwise); HTTP bodies and query strings likewise. Sockets present a JWT in the
handshake `auth` field and are rejected in middleware if it doesn't verify. Membership is
checked on `message:send`/`message:read` (socket must have joined) and on `room:sync`.

### Observability

pino JSON logs with `instance` on every line; HTTP requests carry `reqId` (honours
`X-Request-ID`, echoed back), sockets carry `socketId`/`userId`. `SENTRY_DSN` enables
`@sentry/node`. `/health` reports Postgres and Redis reachability plus the instance id.

---

## Database schema

```
users ──< room_members >── rooms ──< messages
  └──────< read_receipts >───┘
```

| Table           | Notes                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`         | `username` unique, `CHECK` regex                                                                                                                                           |
| `rooms`         | `name` unique                                                                                                                                                              |
| `room_members`  | PK `(room_id, user_id)`, CASCADE both ways                                                                                                                                 |
| `messages`      | `bigserial` id (total order per room), `UNIQUE (room_id, sender_id, client_msg_id)` for idempotent sends, index `(room_id, id)` for sync + pagination, `CHECK` body length |
| `read_receipts` | PK `(room_id, user_id)`, `last_read_message_id`                                                                                                                            |

## API

| Method | Path                                     | Notes                                                            |
| ------ | ---------------------------------------- | ---------------------------------------------------------------- |
| POST   | `/api/auth/login`                        | `{username}` → `{token, user}` (demo auth; JWT is the real part) |
| GET    | `/api/rooms`                             | with member counts                                               |
| POST   | `/api/rooms`                             | `{name, topic}` → 201 / 409                                      |
| GET    | `/api/rooms/:id/messages?before=&limit=` | newest-first keyset page, `nextBefore` cursor                    |
| GET    | `/api/rooms/:id/members`                 | with `online` flag                                               |

Socket events (see `src/realtime/events.ts`): `room:join`, `room:leave`, `message:send`,
`message:read`, `room:sync`, `typing` → `message:new`, `message:read`, `typing`, `presence`,
`room:member`, `hello`.

## Tests

```bash
TEST_DATABASE_URL=postgresql://pulse:pulse@localhost:5432/pulse_test npm test
REDIS_URL=redis://localhost:6379 npm test        # also runs the two-instance suite
```

Single-instance suite (15): JWT rejection, hello/instance, delivery + ack, idempotent resend,
payload validation, keyset pagination, typing broadcast (no self-echo), receipts (monotonic,
implied-by-send), presence edges with multiple tabs, `room:sync`, automatic recovery after a
transport drop, rooms API, health. Cluster suite (1, needs Redis): fan-out of messages /
typing / receipts / presence between two instances.

## CI

eslint → prettier → tsc → vitest (Postgres + Redis services, so the cluster test runs) → `docker compose build`.

## Running locally without Docker

```bash
npm install
cp .env.example .env            # leave REDIS_URL empty for single-instance mode
npm run dev                     # http://localhost:3000
# second instance to see fan-out (needs REDIS_URL set in both):
PORT=3001 INSTANCE_ID=two npm run dev
```
