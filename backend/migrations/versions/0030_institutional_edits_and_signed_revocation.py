"""Institutional person: data corrected after signing, e-mail change confirmed by the person, signed revocation.

- signed_identity: name, position, unit and e-mail AS SIGNED. The signed document and its verification code
  are built from it, so correcting the name or the position later (LGPD Art. 18, III) never changes the proof.
- *_changed_at: when each field was last corrected (shown as "alterado" with the date).
- pending_email / email_change_*: a new institutional e-mail only replaces the old one after the person
  confirms it, signing at a link sent to the NEW address.
- revoke_request_*: the administrator sends the revocation term at the person's request; the person's own
  link (from the confirmation e-mail) keeps working too.
- revocation_*: the revocation is signed like the authorization, and the signature is kept as proof.

Revision ID: 0030
Revises: 0029
Create Date: 2026-10-24
"""
from alembic import op

revision = "0030"
down_revision = "0029"
branch_labels = None
depends_on = None

COLUMNS = """
    signed_identity jsonb,
    name_changed_at timestamptz, position_changed_at timestamptz, unit_changed_at timestamptz,
    email_changed_at timestamptz,
    pending_email varchar(254), email_change_hash varchar(64), email_change_expires_at timestamptz,
    email_change_signature_key text,
    revoke_request_hash varchar(64), revoke_requested_at timestamptz,
    revocation_signature_key text, revocation_ip varchar(45)
"""


def upgrade() -> None:
    adds = ", ".join(f"ADD COLUMN {c.strip()}" for c in COLUMNS.replace("\n", " ").split(",") if c.strip())
    op.execute(f"ALTER TABLE institutional_people {adds}")
    # Rows signed before this migration: the data in the row is still the data signed.
    op.execute("""
        UPDATE institutional_people SET signed_identity = jsonb_build_object(
            'full_name', full_name, 'position', position, 'unit', unit, 'email', email)
        WHERE authorized_at IS NOT NULL
    """)


def downgrade() -> None:
    drops = ", ".join(f"DROP COLUMN {c.split()[0]}" for c in COLUMNS.replace("\n", " ").split(",") if c.strip())
    op.execute(f"ALTER TABLE institutional_people {drops}")
