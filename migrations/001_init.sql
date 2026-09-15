-- Pulse: chat schema

CREATE TABLE users (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username     varchar(32) NOT NULL UNIQUE,
    display_name varchar(64) NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_users_username CHECK (username ~ '^[a-z0-9_]{2,32}$')
);

CREATE TABLE rooms (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       varchar(64) NOT NULL UNIQUE,
    topic      varchar(200) NOT NULL DEFAULT '',
    created_by uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE room_members (
    room_id   uuid NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (room_id, user_id)
);
CREATE INDEX ix_room_members_user ON room_members (user_id);

-- bigserial ids give a total order per room, which makes "messages after X" (sync after a
-- reconnect) and cursor pagination trivial and index-friendly.
CREATE TABLE messages (
    id            bigserial PRIMARY KEY,
    room_id       uuid NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    sender_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    body          text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
    -- Client-generated id: a resend after a lost ack returns the original row instead of
    -- creating a duplicate.
    client_msg_id uuid NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (room_id, sender_id, client_msg_id)
);
CREATE INDEX ix_messages_room_id_id ON messages (room_id, id);

-- One row per (room, user): the highest message id the user has read. Read receipts are
-- therefore O(members) per room, not O(messages × members).
CREATE TABLE read_receipts (
    room_id              uuid NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    user_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    last_read_message_id bigint NOT NULL,
    updated_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (room_id, user_id)
);

-- Seed a public lobby so a fresh install has somewhere to talk.
INSERT INTO rooms (name, topic) VALUES ('general', 'Say hello');
