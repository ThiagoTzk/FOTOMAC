"""How each signature was made, and sessions that end after a period without use.

- institutional_people.signature_kind / signature_font / signature_text: the authorization was TYPED (the
  name in a handwriting font), DRAWN or a RUBRICA; revocation_signature_kind for the revocation. Part of the
  proof (LGPD Art. 8 § 2).
- sessions.remember ("Manter conectado") and sessions.last_activity_at: without "Manter conectado", a session
  with no use for the idle period ends (security on shared computers).

Revision ID: 0031
Revises: 0030
Create Date: 2026-10-25
"""
from alembic import op

revision = "0031"
down_revision = "0030"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE institutional_people
            ADD COLUMN signature_kind varchar(10), ADD COLUMN signature_font varchar(40),
            ADD COLUMN signature_text varchar(80), ADD COLUMN revocation_signature_kind varchar(10);
        ALTER TABLE sessions
            ADD COLUMN remember boolean NOT NULL DEFAULT false,
            ADD COLUMN last_activity_at timestamptz NOT NULL DEFAULT now();
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE sessions DROP COLUMN last_activity_at, DROP COLUMN remember;
        ALTER TABLE institutional_people DROP COLUMN revocation_signature_kind, DROP COLUMN signature_text,
            DROP COLUMN signature_font, DROP COLUMN signature_kind;
    """)
