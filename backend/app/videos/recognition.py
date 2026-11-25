"""Facial recognition in the published videos (RF035, 04/11/2026).

Decision of the coordinator and the advisor: a person found in a video receives the WHOLE video, with the
institutional watermark, even with other people in it. CESMAC adapts the rule to the LGPD later.

How it works:
- one frame per second of the published video is analysed like a photo (same engine, same minimum confidence);
- each face becomes a vector in video_face_embeddings (sensitive data, its own table, the database refuses a
  vector of a video that is not published);
- a video is a match only when the person is found in at least MIN_SECONDS different seconds: a video has
  hundreds of frames, and each one is a new chance of a look-alike. One lucky frame is not enough.

The frames exist only in a temporary folder during the analysis and are deleted with it (LGPD Art. 6, III).
"""
from __future__ import annotations

import logging
import tempfile
from collections.abc import Sequence
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import audit, parameters
from app.db.models import ImageReviewStatus, Video, VideoFaceEmbedding, VideoProcessingStatus
from app.face.port import FaceEngine
from app.imaging import decode_image
from app.storage.port import ObjectStorage
from app.videos import media

log = logging.getLogger("fotomac.videos")
SAMPLE_FPS = 1.0
MIN_SECONDS = 2          # found in at least 2 different seconds (or in every second of a shorter video)
MAX_ATTEMPTS = 3
STALE_AFTER = timedelta(hours=3)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def queue(video: Video) -> None:
    """A published video enters the recognition queue (or enters again after a change)."""
    video.indexing_status, video.indexing_attempts, video.indexing_next_at = "pending", 0, None
    video.indexing_error = None


def forget(db: Session, video_ids: list[uuid.UUID] | None = None, event_id: uuid.UUID | None = None) -> int:
    """Erases the vectors of these videos (or of the whole event) now."""
    q = db.query(VideoFaceEmbedding)
    q = q.filter(VideoFaceEmbedding.event_id == event_id) if event_id else q.filter(VideoFaceEmbedding.video_id.in_(video_ids or []))
    return q.delete(synchronize_session=False)


def group_people(rows: Sequence[tuple[float, object]], threshold: float, duration: float) -> list[list[int]]:
    """The different people the faces of one video belong to (05/11/2026), as lists of row indexes. Two faces are the
    same person when they are alike above the search threshold, directly or through a chain of faces: a head that
    turns little by little changes the vector a lot from the first to the last second, but little from one second to
    the next. Two faces of the SAME frame are never joined. Like the search, a person counts only when seen in
    MIN_SECONDS different seconds: one lucky frame is not a person."""
    if not rows:
        return []
    seconds = [int(second) for second, _ in rows]
    vectors = np.stack([np.asarray(v, dtype=np.float32) for _, v in rows])
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True) + 1e-9
    alike = vectors @ vectors.T
    group = list(range(len(rows)))

    def root(i: int) -> int:
        while group[i] != i:
            group[i] = group[group[i]]
            i = group[i]
        return i

    members: dict[int, set[int]] = {i: {seconds[i]} for i in range(len(rows))}
    indexes: dict[int, list[int]] = {i: [i] for i in range(len(rows))}
    # The most alike pairs first, so a weak link never decides before a strong one. Picked by numpy: a 10-minute video
    # has thousands of faces, millions of pairs.
    secs = np.array(seconds)
    first, second = np.triu_indices(len(rows), 1)
    keep = (alike[first, second] >= threshold) & (secs[first] != secs[second])
    first, second = first[keep], second[keep]
    order = np.argsort(-alike[first, second], kind="stable")
    for i, j in zip(first[order].tolist(), second[order].tolist()):
        a, b = root(i), root(j)
        if a == b or members[a] & members[b]:   # already together, or both seen in one same frame
            continue
        group[b] = a
        members[a] |= members.pop(b)
        indexes[a] += indexes.pop(b)
    shortest = min(MIN_SECONDS, max(1, int(duration * SAMPLE_FPS)))   # the same rule as matches()
    return [sorted(indexes[r]) for r, secs in members.items() if len(secs) >= shortest]


def count_people(rows: Sequence[tuple[float, object]], threshold: float, duration: float) -> int:
    """How many different people (group_people). Only the number is kept in the video."""
    return len(group_people(rows, threshold, duration))


MAX_PEOPLE_SHOWN = 12


def people_faces(db: Session, video: Video, threshold: float) -> list[tuple[float, tuple[int, int, int, int]]]:
    """For the panel (05/11/2026): one face per person found in the video, the one the detector was surest of, as
    (second, box), in the order the people first appear. The picture is cut from the video by whoever calls this,
    at that moment; nothing here is stored."""
    rows = db.execute(select(VideoFaceEmbedding.second, VideoFaceEmbedding.embedding, VideoFaceEmbedding.detection_score,
                             VideoFaceEmbedding.box_x, VideoFaceEmbedding.box_y, VideoFaceEmbedding.box_w,
                             VideoFaceEmbedding.box_h)
                      .where(VideoFaceEmbedding.video_id == video.id, VideoFaceEmbedding.box_w.is_not(None))
                      .order_by(VideoFaceEmbedding.second)).all()
    groups = group_people([(r.second, r.embedding) for r in rows], threshold, video.duration_seconds)
    groups.sort(key=lambda g: rows[g[0]].second)
    out = []
    for members in groups[:MAX_PEOPLE_SHOWN]:
        best = rows[max(members, key=lambda i: rows[i].detection_score)]
        out.append((best.second, (best.box_x, best.box_y, best.box_w, best.box_h)))
    return out


def index_next_video(db: Session, storage: ObjectStorage, engine: FaceEngine) -> bool:
    """Analyse one published video. The row is marked and committed first: the analysis takes minutes and a
    transaction must not stay open that long. Returns False when the queue is empty."""
    db.query(Video).filter(Video.indexing_status == "indexing", Video.indexing_next_at < _now() - STALE_AFTER).update(
        {Video.indexing_status: "pending"}, synchronize_session=False)
    video = db.scalar(select(Video).where(
        Video.indexing_status == "pending", Video.review_status == ImageReviewStatus.PUBLISHED,
        Video.processing_status == VideoProcessingStatus.READY, Video.removal_requested_at.is_(None),
        (Video.indexing_next_at.is_(None)) | (Video.indexing_next_at <= _now()))
        .order_by(Video.published_at, Video.id).limit(1).with_for_update(skip_locked=True))
    if video is None:
        db.commit()
        return False
    video.indexing_status, video.indexing_next_at = "indexing", _now()   # indexing_next_at: when it started
    db.commit()
    video_id, event_id, key = video.id, video.event_id, video.web_key or video.object_key
    floor = parameters.get(db, "min_detection_score")
    rows: list[tuple[float, object, float, object]] = []
    try:
        with tempfile.TemporaryDirectory(prefix="fotomac-rf035-") as folder:
            source = Path(folder) / ("source" + Path(key).suffix)
            storage.get_file(key, str(source))
            frames = Path(folder) / "frames"
            frames.mkdir()
            for second, path in media.sample_frames(source, frames, SAMPLE_FPS):
                image = decode_image(path.read_bytes())
                path.unlink()   # each frame lives only while it is analysed
                for face in engine.detect(image):
                    if face.detection_score >= floor:
                        rows.append((second, face.embedding, face.detection_score, face.bbox))
    except Exception as exc:  # one bad file never stops the queue
        db.rollback()
        video = db.get(Video, video_id)
        if video is not None:
            video.indexing_attempts += 1
            video.indexing_error = type(exc).__name__[:200]   # the class name only: no personal data
            video.indexing_status = "failed" if video.indexing_attempts >= MAX_ATTEMPTS else "pending"
            video.indexing_next_at = None if video.indexing_status == "failed" else \
                _now() + timedelta(seconds=30 * 2 ** video.indexing_attempts)
            log.warning("recognition failed for video %s: %s", video_id, video.indexing_error)
            db.commit()
        return True
    db.expire_all()
    video = db.get(Video, video_id)
    # Eliminated, unpublished or asked to be removed during the analysis: no vector is written.
    if video is None or video.review_status != ImageReviewStatus.PUBLISHED or video.removal_requested_at \
            or video.indexing_status != "indexing":
        db.commit()
        return True
    forget(db, [video_id])
    for second, vector, score, box in rows:
        db.add(VideoFaceEmbedding(video_id=video_id, event_id=event_id, model_version=engine.model_version,
                                  dim=engine.vector_dim, embedding=vector, second=second, detection_score=score,
                                  box_x=box.x, box_y=box.y, box_w=box.width, box_h=box.height))
    seconds = len({int(second) for second, _, _, _ in rows})   # int, not round: round(2.5) == round(1.5) == 2
    people = count_people([(second, vector) for second, vector, _, _ in rows], parameters.get(db, "similarity_threshold"),
                          video.duration_seconds)
    video.indexing_status = "processed" if rows else "no_faces"
    video.indexed_at, video.indexing_model_version, video.face_seconds = _now(), engine.model_version, seconds
    video.face_people = people
    video.indexing_next_at, video.indexing_error = None, None
    audit.record(db, "video.indexed", None, "video", video.id, faces=len(rows), seconds=seconds, people=people)
    db.commit()
    return True


def matches(db: Session, event_id: uuid.UUID, model_version: str, vectors: list, threshold: float) -> list[tuple[uuid.UUID, float]]:
    """The videos of ONE event where the person of the query vectors appears: at least MIN_SECONDS different
    seconds above the threshold (all of them, in a video with fewer analysed seconds). Best similarity first."""
    seconds: dict[uuid.UUID, set[int]] = {}
    best: dict[uuid.UUID, float] = {}
    for vector in vectors:
        similarity = (1 - VideoFaceEmbedding.embedding.cosine_distance(vector)).label("similarity")
        rows = db.execute(
            select(VideoFaceEmbedding.video_id, VideoFaceEmbedding.second, similarity)
            .join(Video, Video.id == VideoFaceEmbedding.video_id)
            .where(VideoFaceEmbedding.event_id == event_id,                 # ONE event, always
                   VideoFaceEmbedding.model_version == model_version,       # comparable vectors only
                   Video.review_status == ImageReviewStatus.PUBLISHED,
                   Video.indexing_status == "processed",
                   Video.removal_requested_at.is_(None))
            .where(similarity >= threshold)).all()
        for r in rows:
            seconds.setdefault(r.video_id, set()).add(int(r.second))
            best[r.video_id] = max(best.get(r.video_id, 0.0), float(r.similarity))
    if not seconds:
        return []
    analysed = dict(db.execute(select(Video.id, Video.duration_seconds).where(Video.id.in_(seconds))).all())
    found = [(vid, best[vid]) for vid, secs in seconds.items()
             if len(secs) >= min(MIN_SECONDS, max(1, int(analysed.get(vid, 0) * SAMPLE_FPS)))]
    return sorted(found, key=lambda m: -m[1])


def requeue_for_model(db: Session, model_version: str) -> int:
    """After the administrator swaps the engine: the published videos analysed by another model go back to the
    queue (the old vectors stay usable for nothing and are replaced when the new ones exist)."""
    n = db.query(Video).filter(Video.review_status == ImageReviewStatus.PUBLISHED,
                               Video.indexing_status.in_(["processed", "no_faces", "failed"]),
                               func.coalesce(Video.indexing_model_version, "") != model_version).update(
        {Video.indexing_status: "pending", Video.indexing_attempts: 0, Video.indexing_next_at: None},
        synchronize_session=False)
    db.commit()
    return n
