"""Where each face of a video is in its frame (05/11/2026: show the team who appears in a video, below the
player of the panel). Only the box (x, y, width, height) is kept, beside the vector that already existed: the picture
of the face is cut from the video at the moment it is shown and is never stored.

The published videos already analysed go back to the queue, so their boxes are filled.

Revision ID: 0042
Revises: 0041
Create Date: 2026-11-05
"""
from alembic import op

revision = "0042"
down_revision = "0041"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""ALTER TABLE video_face_embeddings ADD COLUMN box_x integer, ADD COLUMN box_y integer,
                  ADD COLUMN box_w integer, ADD COLUMN box_h integer""")
    op.execute("""UPDATE videos SET indexing_status = 'pending', indexing_attempts = 0, indexing_next_at = NULL
                  WHERE indexing_status = 'processed' AND removal_requested_at IS NULL""")


def downgrade() -> None:
    op.execute("""ALTER TABLE video_face_embeddings DROP COLUMN box_x, DROP COLUMN box_y, DROP COLUMN box_w,
                  DROP COLUMN box_h""")
