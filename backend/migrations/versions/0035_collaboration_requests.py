"""Collaboration by request (01/11/2026, user test): a photographer sees every active event and asks the person
responsible to work on one; the responsible accepts or declines, and each side is told on the bell.

- event_collaborators: accounts accepted BY NAME. They send to the event even with the collaboration closed; turning
  their access off is the existing block (event_access_blocks).
- collaboration_requests: the request (to send photos and/or to accept RAW files), with an optional message, and the
  answer, with an optional reply. Answered requests are deleted after 90 days (same period as the support page).

Revision ID: 0035
Revises: 0034
Create Date: 2026-11-01
"""
from alembic import op

revision = "0035"
down_revision = "0034"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE event_collaborators (
            event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
            account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            added_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
            added_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (event_id, account_id)
        );
        CREATE INDEX ix_event_collaborators_account ON event_collaborators (account_id);
        CREATE TABLE collaboration_requests (
            id uuid PRIMARY KEY,
            event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
            requester_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            wants_upload boolean NOT NULL,
            wants_raw boolean NOT NULL,
            message varchar(500),
            status varchar(10) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
            reply varchar(500),
            raw_turned_on boolean NOT NULL DEFAULT false,
            created_at timestamptz NOT NULL DEFAULT now(),
            decided_at timestamptz,
            decided_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
            requester_seen_at timestamptz,
            CHECK (wants_upload OR wants_raw)
        );
        -- One request waiting per person and event: asking twice only repeats the notice.
        CREATE UNIQUE INDEX uq_collaboration_requests_pending ON collaboration_requests (event_id, requester_id)
            WHERE status = 'pending';
        CREATE INDEX ix_collaboration_requests_requester ON collaboration_requests (requester_id, created_at);
    """)


def downgrade() -> None:
    op.execute("""
        DROP TABLE collaboration_requests;
        DROP TABLE event_collaborators;
    """)
