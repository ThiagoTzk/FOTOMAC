"""Facial recognition in videos (RF035, 04/11/2026: answer of the coordinator and the advisor). A person found in
a video receives the WHOLE video, with the institutional watermark, even with other people in it; CESMAC adapts
the rule later.

- video_face_embeddings: SENSITIVE biometric data (LGPD Art. 5, II), in its own table like the photos'. One row
  per face per sampled second. The database refuses a vector of a video that is not published, or of another
  event, and the rows go with the video or the event (ON DELETE CASCADE).
- videos.indexing_*: the recognition queue of the published videos.
- videos.removal_requested_at: "Solicitar remoção" on a video takes it out of every search at once and the video
  is deleted in 72 hours, as with a photo.
- visitor_sessions.result_video_ids: the videos found by the search, bound to the session.
- removal_requests.video_id: a request is about a photo OR a video.

Revision ID: 0040
Revises: 0039
Create Date: 2026-11-04
"""
from alembic import op

revision = "0040"
down_revision = "0039"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE videos
            ADD COLUMN indexing_status varchar(12) NOT NULL DEFAULT 'not_queued',
            ADD COLUMN indexing_attempts smallint NOT NULL DEFAULT 0,
            ADD COLUMN indexing_next_at timestamptz,
            ADD COLUMN indexed_at timestamptz,
            ADD COLUMN indexing_model_version varchar(80),
            ADD COLUMN indexing_error varchar(200),
            ADD COLUMN face_seconds integer,
            ADD COLUMN removal_requested_at timestamptz,
            ADD CONSTRAINT ck_video_index_only_published
                CHECK (review_status = 'published' OR indexing_status = 'not_queued')
    """)
    op.execute("""
        CREATE TABLE video_face_embeddings (
            id bigserial PRIMARY KEY,
            video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
            event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
            model_version varchar(80) NOT NULL,
            dim smallint NOT NULL,
            embedding vector NOT NULL,
            second real NOT NULL,
            detection_score real NOT NULL,
            CONSTRAINT ck_video_embedding_dim CHECK (vector_dims(embedding) = dim)
        );
        CREATE INDEX ix_video_face_embeddings_event ON video_face_embeddings (event_id, model_version);
        CREATE INDEX ix_video_face_embeddings_video ON video_face_embeddings (video_id);

        CREATE FUNCTION guard_video_face_embedding() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE vid record;
        BEGIN
            SELECT review_status, event_id INTO vid FROM videos WHERE id = NEW.video_id;
            IF vid.review_status IS DISTINCT FROM 'published' THEN
                RAISE EXCEPTION 'biometric vector refused: video % is not published', NEW.video_id;
            END IF;
            IF vid.event_id IS DISTINCT FROM NEW.event_id THEN
                RAISE EXCEPTION 'face vector event does not match its video event';
            END IF;
            RETURN NEW;
        END $$;
        CREATE TRIGGER trg_guard_video_face_embedding BEFORE INSERT OR UPDATE ON video_face_embeddings
            FOR EACH ROW EXECUTE FUNCTION guard_video_face_embedding();
    """)
    # The videos already published enter the recognition queue.
    op.execute("UPDATE videos SET indexing_status = 'pending' WHERE review_status = 'published'")
    op.execute("ALTER TABLE visitor_sessions ADD COLUMN result_video_ids uuid[] NOT NULL DEFAULT '{}'")
    op.execute("ALTER TABLE removal_requests ADD COLUMN video_id uuid REFERENCES videos(id) ON DELETE SET NULL")


def downgrade() -> None:
    op.execute("ALTER TABLE removal_requests DROP COLUMN video_id")
    op.execute("ALTER TABLE visitor_sessions DROP COLUMN result_video_ids")
    op.execute("DROP TABLE video_face_embeddings")
    op.execute("DROP FUNCTION guard_video_face_embedding")
    op.execute("""
        ALTER TABLE videos
            DROP CONSTRAINT ck_video_index_only_published,
            DROP COLUMN removal_requested_at, DROP COLUMN face_seconds, DROP COLUMN indexing_error,
            DROP COLUMN indexing_model_version, DROP COLUMN indexed_at, DROP COLUMN indexing_next_at,
            DROP COLUMN indexing_attempts, DROP COLUMN indexing_status
    """)
