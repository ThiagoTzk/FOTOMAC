"""Notices of the bell dismissed by the person (08/11/2026: a button to remove a notice he already knows
about, on the site and in the app). One row per account and notice: the account, which notice (its kind and where it
leads) and up to which moment it was dismissed. Deleted with the account.

Revision ID: 0043
Revises: 0042
Create Date: 2026-11-08
"""
from alembic import op

revision = "0043"
down_revision = "0042"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""CREATE TABLE notice_dismissals (
                      account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                      key varchar(400) NOT NULL,
                      since timestamptz NOT NULL,
                      PRIMARY KEY (account_id, key))""")


def downgrade() -> None:
    op.execute("DROP TABLE notice_dismissals")
