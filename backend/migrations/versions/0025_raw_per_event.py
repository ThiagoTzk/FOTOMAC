"""Camera RAW formats are turned on PER EVENT, by whoever manages it — decision of 22/10/2026.

Until now one switch of the administrator (parameter "raw_formats_enabled") decided for every event,
and it sat hidden among the facial recognition parameters. Now the event form has "Aceitar arquivos
RAW", off by default, with the warnings (size, no editing, server load). The administrator keeps only
the maximum size of a RAW file ("raw_max_mb"). Events that exist start with RAW off.

Revision ID: 0025
Revises: 0024
Create Date: 2026-10-22
"""
from alembic import op

revision = "0025"
down_revision = "0024"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE events ADD COLUMN raw_enabled boolean NOT NULL DEFAULT false;
        DELETE FROM system_parameters WHERE key = 'raw_formats_enabled';
    """)


def downgrade() -> None:
    op.execute("ALTER TABLE events DROP COLUMN raw_enabled;")
