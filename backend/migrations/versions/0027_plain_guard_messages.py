"""The two database guards of biometric data say what they refuse, without requirement codes.

Same rules as before (0001 and 0024): a facial vector only for a published photo of its own event, and an
institutional vector only for a person whose authorization is active. Only the messages change: they used
to start with codes of the project's requirements document, which mean nothing to whoever maintains the
system.

Revision ID: 0027
Revises: 0026
Create Date: 2026-10-24
"""
from alembic import op

revision = "0027"
down_revision = "0026"
branch_labels = None
depends_on = None


def _functions(published: str, authorized: str) -> str:
    return f"""
        CREATE OR REPLACE FUNCTION guard_face_embedding() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE img record;
        BEGIN
            SELECT event_id, review_status INTO img FROM images WHERE id = NEW.image_id;
            IF img.review_status IS DISTINCT FROM 'published' THEN
                RAISE EXCEPTION '{published}', NEW.image_id
                    USING ERRCODE = 'check_violation';
            END IF;
            IF img.event_id <> NEW.event_id THEN
                RAISE EXCEPTION 'face vector event does not match its image event'
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END $$;

        CREATE OR REPLACE FUNCTION guard_institutional_vector() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF (SELECT status FROM institutional_people WHERE id = NEW.person_id) <> 'active' THEN
                RAISE EXCEPTION '{authorized}', NEW.person_id
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END $$;
    """


def upgrade() -> None:
    op.execute(_functions("biometric vector refused: image % is not published",
                          "biometric vector refused: person % has not authorized"))


def downgrade() -> None:
    # Only the wording of two error messages changed: the rules are the same, nothing to undo.
    pass
