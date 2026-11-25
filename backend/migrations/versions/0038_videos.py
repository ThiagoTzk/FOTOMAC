"""Videos in the collection (RF034, 02/11/2026).

A table of their own, not more columns on images: a video has no faces to index today, no watermark and no
JPEG copies, and its conversion takes minutes, so it has its own queue.

- object_key: the original, without location metadata (it is cleaned BEFORE being stored).
- web_key: the copy every browser plays (H.264 in MP4). The same key as object_key when the original already is.
- processing_status: the conversion queue. Only a ready video can be published.

Who sees them: only logged-in accounts. RF034 note 5 keeps them away from visitors while RF035 does not exist.

Revision ID: 0038
Revises: 0037
Create Date: 2026-11-02
"""
from alembic import op

revision = "0038"
down_revision = "0037"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TYPE video_processing_status AS ENUM ('pending', 'processing', 'ready', 'failed');

        CREATE TABLE videos (
            id                 uuid PRIMARY KEY,
            event_id           uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
            uploaded_by        uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
            object_key         text NOT NULL UNIQUE,
            web_key            text,
            thumb_key          text,
            sha256             varchar(64) NOT NULL,
            size_bytes         bigint NOT NULL,
            web_bytes          bigint,
            duration_seconds   double precision NOT NULL,
            width              integer NOT NULL,
            height             integer NOT NULL,
            video_codec        varchar(20) NOT NULL,
            audio_codec        varchar(20),
            source_format      varchar(4) NOT NULL,
            captured_at        timestamptz,
            review_status      image_review_status NOT NULL DEFAULT 'in_review',
            processing_status  video_processing_status NOT NULL DEFAULT 'pending',
            processing_attempts smallint NOT NULL DEFAULT 0,
            processing_started_at timestamptz,
            next_attempt_at    timestamptz,
            last_error         varchar(200),
            approval           varchar(10),
            approved_by        uuid REFERENCES accounts(id) ON DELETE RESTRICT,
            approved_at        timestamptz,
            rejection_reason   varchar(300),
            rejected_by        uuid REFERENCES accounts(id) ON DELETE SET NULL,
            rejected_at        timestamptz,
            credit_signature   varchar(80) NOT NULL,
            uploaded_at        timestamptz NOT NULL DEFAULT now(),
            published_at       timestamptz,
            CONSTRAINT uq_video_event_checksum UNIQUE (event_id, sha256),
            -- The database refuses what the service must never do: publishing what is not ready.
            CONSTRAINT ck_video_published_ready CHECK (review_status <> 'published' OR processing_status = 'ready')
        );
        CREATE INDEX ix_videos_event ON videos (event_id);
        CREATE INDEX ix_videos_queue ON videos (processing_status, next_attempt_at);
    """)


def downgrade() -> None:
    op.execute("DROP TABLE videos; DROP TYPE video_processing_status;")
