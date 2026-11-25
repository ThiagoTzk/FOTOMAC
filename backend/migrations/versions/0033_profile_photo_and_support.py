"""Profile photo of the staff accounts, and the support page.

- accounts.photo_key / photo_updated_at: an optional photo instead of the initials (28/10/2026). Re-encoded on
  arrival (no metadata, no GPS) and never used for face recognition.
- support_messages: a problem, a suggestion or a question sent by someone of the team to the administration,
  who answers and marks it solved. Solved messages are deleted after a period (minimization).

Revision ID: 0033
Revises: 0032
Create Date: 2026-10-29
"""
from alembic import op

revision = "0033"
down_revision = "0032"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE accounts ADD COLUMN photo_key text, ADD COLUMN photo_updated_at timestamptz;
        CREATE TABLE support_messages (
            id uuid PRIMARY KEY,
            account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            kind varchar(12) NOT NULL CHECK (kind IN ('problem', 'suggestion', 'question')),
            subject varchar(120) NOT NULL,
            message varchar(3000) NOT NULL,
            page varchar(200),
            status varchar(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
            answer varchar(2000),
            created_at timestamptz NOT NULL DEFAULT now(),
            resolved_at timestamptz,
            resolved_by uuid REFERENCES accounts(id) ON DELETE SET NULL
        );
        CREATE INDEX ix_support_messages_account ON support_messages (account_id, created_at);
        CREATE INDEX ix_support_messages_status ON support_messages (status, created_at);
    """)


def downgrade() -> None:
    op.execute("""
        DROP TABLE support_messages;
        ALTER TABLE accounts DROP COLUMN photo_updated_at, DROP COLUMN photo_key;
    """)
