"""Event settings: the person responsible turns off, one by one, who may still work on the event.

A row here = that account no longer sends photos to the event nor changes the ones it sent (they stay in
the collection, with its credit and data). Removing the row gives the access back. The responsible
photographer and administrators are never blocked (checked in the service).

Revision ID: 0029
Revises: 0028
Create Date: 2026-10-24
"""
from alembic import op

revision = "0029"
down_revision = "0028"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE event_access_blocks (
            event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
            account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
            blocked_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
            blocked_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (event_id, account_id)
        );
    """)


def downgrade() -> None:
    op.execute("DROP TABLE event_access_blocks")
