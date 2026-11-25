"""Where the event is, on a map (01/11/2026: "se eu escrever um CEP aparecer no mapa... eu botar um pin no
mapa, é nesse local, e dar uma descrição"). All optional: the written place stays as it is.

- postal_code: the CEP used, digits only.
- latitude, longitude: the pin. Both or neither.
- location_note: how to find the place ("entrada vermelha com a logo do ginásio").

The place of an event is not personal data.

Revision ID: 0037
Revises: 0036
Create Date: 2026-11-01
"""
from alembic import op

revision = "0037"
down_revision = "0036"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE events
            ADD COLUMN postal_code varchar(8),
            ADD COLUMN latitude double precision,
            ADD COLUMN longitude double precision,
            ADD COLUMN location_note varchar(300),
            ADD CONSTRAINT ck_event_pin_whole CHECK ((latitude IS NULL) = (longitude IS NULL))
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE events
            DROP CONSTRAINT ck_event_pin_whole,
            DROP COLUMN location_note,
            DROP COLUMN longitude,
            DROP COLUMN latitude,
            DROP COLUMN postal_code
    """)
