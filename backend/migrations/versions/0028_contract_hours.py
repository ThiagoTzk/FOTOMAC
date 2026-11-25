"""Hired photographer: the administrator chooses how long the account works, and renews it.

- accounts.contract_hours: hours the account works from the password definition (it was always 24). Only
  for the hired photographer, between 1 and 720 (30 days).
- An expired temporary account can now be renewed for a new coverage (same person, same e-mail, a new
  event, contract and period) instead of a new account each time. Nothing is deleted.

Revision ID: 0028
Revises: 0027
Create Date: 2026-10-24
"""
from alembic import op

revision = "0028"
down_revision = "0027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE accounts ADD COLUMN contract_hours smallint;
        UPDATE accounts SET contract_hours = 24 WHERE role = 'contractor';
        ALTER TABLE accounts ADD CONSTRAINT ck_contract_hours
            CHECK ((role = 'contractor' AND contract_hours BETWEEN 1 AND 720)
                   OR (role <> 'contractor' AND contract_hours IS NULL));
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE accounts DROP CONSTRAINT ck_contract_hours;
        ALTER TABLE accounts DROP COLUMN contract_hours;
    """)
