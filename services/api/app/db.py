from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
import os

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql+psycopg://postgres:dev@db:5432/crewtalk")
engine = create_engine(DATABASE_URL, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)

DDL = [
    """
    create table if not exists sessions (
      id uuid primary key default gen_random_uuid(),
      title text not null,
      problem_statement text not null,
      strategy text not null,
      phase text not null default 'discover',
      status text not null default 'idle',
      time_limit_sec int not null,
      turn_index int not null default 0,
      deadline timestamptz,
      started_at timestamptz default now(),
      ended_at timestamptz,
      created_by text
    );
    """,
    """
    create table if not exists agents (
      id uuid primary key default gen_random_uuid(),
      session_id uuid references sessions(id) on delete cascade,
      name text not null,
      role text not null,
      trait text,
      model_hint text,
      is_active boolean default true,
      created_at timestamptz default now()
    );
    """,
    """
    create table if not exists messages (
      id bigserial primary key,
      session_id uuid references sessions(id) on delete cascade,
      agent_id uuid references agents(id) on delete set null,
      phase text not null,
      turn_index int not null default 0,
      text text not null,
      sentiment numeric,
      confidence numeric,
      created_at timestamptz default now()
    );
    """,
    """
    create table if not exists notepad_snapshots (
      id bigserial primary key,
      session_id uuid references sessions(id) on delete cascade,
      content text not null,
      updated_by text,
      created_at timestamptz default now()
    );
    """,
    """
    create table if not exists rewards (
      id bigserial primary key,
      session_id uuid references sessions(id) on delete cascade,
      agent_id uuid references agents(id) on delete cascade,
      label text not null,
      created_at timestamptz default now()
    );
    """,
]

def init_db():
    with engine.begin() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS pgcrypto"))
        for stmt in DDL:
            conn.execute(text(stmt))
        # Columns that may have been missing on older databases
        conn.execute(text("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS status text not null default 'idle'"))
        conn.execute(text("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS turn_index int not null default 0"))
        conn.execute(text("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS deadline timestamptz"))
        conn.execute(text("ALTER TABLE messages ADD COLUMN IF NOT EXISTS turn_index int not null default 0"))
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS idx_messages_session_created "
                "ON messages (session_id, created_at)"
            )
        )
        conn.execute(
            text("CREATE INDEX IF NOT EXISTS idx_agents_session ON agents (session_id)")
        )
        conn.execute(
            text(
                "ALTER TABLE agents ADD COLUMN IF NOT EXISTS created_at timestamptz default now()"
            )
        )
        conn.execute(
            text(
                "UPDATE agents SET created_at = COALESCE(created_at, now()) WHERE created_at IS NULL"
            )
        )
