"""Sessions that end when the browser closes, and the bell's "seen" mark.

- sessions.seen_at: the last "a tab of the site is open" sign (every minute). sessions.closed_at: the last tab
  said it was closing. Without "Manter conectado", the session ends when no tab is open — even when the browser
  restores its session cookie on reopening ("continuar de onde parou").
- accounts.notices_seen_at: when the person last opened the bell; the counter shows only what came after.

Revision ID: 0032
Revises: 0031
Create Date: 2026-10-29
"""
from alembic import op

revision = "0032"
down_revision = "0031"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE sessions ADD COLUMN seen_at timestamptz, ADD COLUMN closed_at timestamptz;
        ALTER TABLE accounts ADD COLUMN notices_seen_at timestamptz;
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE accounts DROP COLUMN notices_seen_at;
        ALTER TABLE sessions DROP COLUMN closed_at, DROP COLUMN seen_at;
    """)
