"""A hired photographer's photo REJECTED with a reason, instead of deleted at once — decision of 22/10/2026.

Before, rejecting deleted the photo, and the hired photographer never knew why. Now the administrator
writes the reason; the photo stays visible to its sender with "Recusada" and the reason, is never
published (never produces facial data), and is eliminated automatically 7 days later. The hired
photographer also no longer replaces files (to send another version, sends another image), which
removes the case of a photo approved and then swapped.

Revision ID: 0026
Revises: 0025
Create Date: 2026-10-22
"""
from alembic import op

revision = "0026"
down_revision = "0025"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE images DROP CONSTRAINT images_approval_check;
        ALTER TABLE images ADD CONSTRAINT images_approval_check CHECK (approval IN ('pending', 'approved', 'rejected'));
        ALTER TABLE images ADD COLUMN rejection_reason varchar(300);
        ALTER TABLE images ADD COLUMN rejected_by uuid REFERENCES accounts(id) ON DELETE SET NULL;
        ALTER TABLE images ADD COLUMN rejected_at timestamptz;
        ALTER TABLE images ADD CONSTRAINT ck_image_rejection_complete
            CHECK ((approval = 'rejected') = (rejection_reason IS NOT NULL AND rejected_at IS NOT NULL));
        -- A rejected photo is never published, whatever the application does.
        ALTER TABLE images ADD CONSTRAINT ck_rejected_never_published
            CHECK (approval IS DISTINCT FROM 'rejected' OR review_status <> 'published');
    """)


def downgrade() -> None:
    op.execute("""
        DELETE FROM images WHERE approval = 'rejected';
        ALTER TABLE images DROP CONSTRAINT ck_rejected_never_published;
        ALTER TABLE images DROP CONSTRAINT ck_image_rejection_complete;
        ALTER TABLE images DROP COLUMN rejected_at;
        ALTER TABLE images DROP COLUMN rejected_by;
        ALTER TABLE images DROP COLUMN rejection_reason;
        ALTER TABLE images DROP CONSTRAINT images_approval_check;
        ALTER TABLE images ADD CONSTRAINT images_approval_check CHECK (approval IN ('pending', 'approved'));
    """)
