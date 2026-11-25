"""Chat in the collaboration request (01/11/2026, user test: "pode ser um chat de verdade para ficar salvo o
que foi conversado"). The requester and the responsible talk inside the request; the administrator joins only where
the responsible's account is not active (it takes over then).

- collaboration_messages: one message of the conversation; goes with its request.
- collaboration_reads: when each participant last read the conversation (the bell tells about what is newer).

The conversation is deleted with the request, 90 days after its last activity.

Revision ID: 0036
Revises: 0035
Create Date: 2026-11-01
"""
from alembic import op

revision = "0036"
down_revision = "0035"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE collaboration_messages (
            id uuid PRIMARY KEY,
            request_id uuid NOT NULL REFERENCES collaboration_requests(id) ON DELETE CASCADE,
            author_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
            body varchar(1000) NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX ix_collaboration_messages_request ON collaboration_messages (request_id, created_at);
        CREATE TABLE collaboration_reads (
            request_id uuid NOT NULL REFERENCES collaboration_requests(id) ON DELETE CASCADE,
            account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            read_at timestamptz NOT NULL,
            PRIMARY KEY (request_id, account_id)
        );
    """)


def downgrade() -> None:
    op.execute("""
        DROP TABLE collaboration_reads;
        DROP TABLE collaboration_messages;
    """)
