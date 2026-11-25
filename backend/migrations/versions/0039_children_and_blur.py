"""Events with children, and faces blurred in the file (04/11/2026, answer of the coordinator and the
advisor to the questions of 19/10/2026: the system stays at CESMAC, which keeps the parents' authorisation
for the use of children's images).

- events.has_children: "Este evento contém imagens com crianças", shown to the team and to the visitor.
- events.children_authorization_ref / _declared_by / _declared_at: turning it on records WHO declared that
  the guardians' authorisation was collected and WHERE the signed terms are (LGPD Art. 8, § 2: proving the
  consent is the controller's burden; Art. 14, § 1: the consent of one of the parents).
- images.faces_blurred: faces hidden IN the file by the panel's blur tool. The file with the faces is not kept.

Revision ID: 0039
Revises: 0038
Create Date: 2026-11-04
"""
from alembic import op

revision = "0039"
down_revision = "0038"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE events
            ADD COLUMN has_children boolean NOT NULL DEFAULT false,
            ADD COLUMN children_authorization_ref varchar(300),
            ADD COLUMN children_declared_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
            ADD COLUMN children_declared_at timestamptz,
            ADD CONSTRAINT ck_event_children_declared
                CHECK (NOT has_children OR (children_authorization_ref IS NOT NULL AND children_declared_at IS NOT NULL))
    """)
    op.execute("ALTER TABLE images ADD COLUMN faces_blurred smallint NOT NULL DEFAULT 0")


def downgrade() -> None:
    op.execute("ALTER TABLE images DROP COLUMN faces_blurred")
    op.execute("""
        ALTER TABLE events
            DROP CONSTRAINT ck_event_children_declared,
            DROP COLUMN children_declared_at,
            DROP COLUMN children_declared_by,
            DROP COLUMN children_authorization_ref,
            DROP COLUMN has_children
    """)
