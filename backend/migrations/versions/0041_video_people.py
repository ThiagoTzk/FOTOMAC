"""How many different people a video shows (05/11/2026, user test: "rostos em 14 segundos" did not say that he
was the only one in the video). Only the count is kept: no "profile" per person is stored.

The published videos already analysed go back to the queue, so the count appears for them too.

Revision ID: 0041
Revises: 0040
Create Date: 2026-11-05
"""
from alembic import op

revision = "0041"
down_revision = "0040"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE videos ADD COLUMN face_people smallint")
    op.execute("""UPDATE videos SET indexing_status = 'pending', indexing_attempts = 0, indexing_next_at = NULL
                  WHERE indexing_status = 'processed' AND removal_requested_at IS NULL""")


def downgrade() -> None:
    op.execute("ALTER TABLE videos DROP COLUMN face_people")
