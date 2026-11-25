"""System parameters and the initial list of event themes.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-03
"""
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
    -- Parameters the administrator changes without touching the code. Every change
    -- will also go to the audit trail when the admin screen exists (Etapa 4).
    CREATE TABLE system_parameters (
        key         varchar(60) PRIMARY KEY,
        value       jsonb NOT NULL,
        updated_at  timestamptz NOT NULL DEFAULT now(),
        updated_by  uuid REFERENCES accounts(id) ON DELETE RESTRICT
    );
    -- Images and vectors are eliminated 6 months after the event date.
    INSERT INTO system_parameters (key, value) VALUES ('retention_months', '6');

    -- Initial themes. The final list is an open institutional decision: these are the
    -- examples of the specification plus the ones the design screens use.
    INSERT INTO themes (name) VALUES
        ('Ciência'), ('Confraternização'), ('Cultura'), ('Educação'),
        ('Esporte'), ('Inovação'), ('Saúde'), ('Tecnologia');
    """)


def downgrade() -> None:
    op.execute("""
    DELETE FROM themes WHERE name IN ('Ciência', 'Confraternização', 'Cultura', 'Educação',
                                      'Esporte', 'Inovação', 'Saúde', 'Tecnologia');
    DROP TABLE IF EXISTS system_parameters;
    """)
