 -- File: upgrade.sql
 -- Version: test-data#159874
 -- Parents: root#000000

CREATE TABLE person (
    id SERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    name TEXT,
    email TEXT NOT NULL UNIQUE,
    last_active_at TIMESTAMPTZ
);

CREATE TABLE session (
    id SERIAL PRIMARY KEY,
    session_token TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id INTEGER NOT NULL REFERENCES person(id),
    last_active_at TIMESTAMPTZ
);