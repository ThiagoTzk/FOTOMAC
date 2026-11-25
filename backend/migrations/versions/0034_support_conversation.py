"""Support as a conversation (31/10/2026, user test): not every problem is solved at once.

- support_messages.status gains "analyzing" (Em análise) and "fixing" (Em correção) between "open" and "resolved".
- support_messages.kind gains "access": a suspended or expired account asking to come back.
- support_entries: the conversation after the first message — a reply of either side, or a status change made by
  the administration. The single "answer" column becomes the first entry and goes away.
- requester_seen_at / admin_seen_at: until when each side has read the conversation (the bell tells the other
  side about what is new).

Revision ID: 0034
Revises: 0033
Create Date: 2026-10-31
"""
from alembic import op

revision = "0034"
down_revision = "0033"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE support_messages DROP CONSTRAINT support_messages_status_check;
        ALTER TABLE support_messages ADD CONSTRAINT support_messages_status_check
            CHECK (status IN ('open', 'analyzing', 'fixing', 'resolved'));
        ALTER TABLE support_messages DROP CONSTRAINT support_messages_kind_check;
        ALTER TABLE support_messages ADD CONSTRAINT support_messages_kind_check
            CHECK (kind IN ('problem', 'suggestion', 'question', 'access'));
        ALTER TABLE support_messages ADD COLUMN requester_seen_at timestamptz, ADD COLUMN admin_seen_at timestamptz,
                                     ADD COLUMN last_entry_at timestamptz;
        CREATE TABLE support_entries (
            id uuid PRIMARY KEY,
            message_id uuid NOT NULL REFERENCES support_messages(id) ON DELETE CASCADE,
            author_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
            from_admin boolean NOT NULL,
            body varchar(2000),
            status varchar(10) CHECK (status IN ('open', 'analyzing', 'fixing', 'resolved')),
            created_at timestamptz NOT NULL DEFAULT now(),
            CHECK (body IS NOT NULL OR status IS NOT NULL)
        );
        CREATE INDEX ix_support_entries_message ON support_entries (message_id, created_at);
        INSERT INTO support_entries (id, message_id, author_id, from_admin, body, status, created_at)
            SELECT gen_random_uuid(), id, resolved_by, true, answer, 'resolved', resolved_at
            FROM support_messages WHERE status = 'resolved';
        UPDATE support_messages SET last_entry_at = coalesce(resolved_at, created_at),
                                    requester_seen_at = created_at, admin_seen_at = coalesce(resolved_at, created_at);
        ALTER TABLE support_messages DROP COLUMN answer;
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE support_messages ADD COLUMN answer varchar(2000);
        UPDATE support_messages m SET answer = (SELECT e.body FROM support_entries e WHERE e.message_id = m.id
                                                AND e.from_admin AND e.body IS NOT NULL ORDER BY e.created_at DESC LIMIT 1);
        DROP TABLE support_entries;
        UPDATE support_messages SET status = 'open' WHERE status IN ('analyzing', 'fixing');
        DELETE FROM support_messages WHERE kind = 'access';
        ALTER TABLE support_messages DROP CONSTRAINT support_messages_status_check;
        ALTER TABLE support_messages ADD CONSTRAINT support_messages_status_check CHECK (status IN ('open', 'resolved'));
        ALTER TABLE support_messages DROP CONSTRAINT support_messages_kind_check;
        ALTER TABLE support_messages ADD CONSTRAINT support_messages_kind_check
            CHECK (kind IN ('problem', 'suggestion', 'question'));
        ALTER TABLE support_messages DROP COLUMN requester_seen_at, DROP COLUMN admin_seen_at, DROP COLUMN last_entry_at;
    """)
