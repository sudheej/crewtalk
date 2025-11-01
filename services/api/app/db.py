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
      time_limit_sec int not null,
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
      is_active boolean default true
    );
    """,
    """
    create table if not exists messages (
      id bigserial primary key,
      session_id uuid references sessions(id) on delete cascade,
      agent_id uuid references agents(id) on delete set null,
      phase text not null,
      text text not null,
      sentiment numeric,
      confidence numeric,
      created_at timestamptz default now()
    );
    """,
]

def init_db():
    with engine.begin() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS pgcrypto"))
        for stmt in DDL:
            conn.execute(text(stmt))
