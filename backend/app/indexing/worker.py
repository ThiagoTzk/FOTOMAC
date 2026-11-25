"""Background queue: facial indexing of PUBLISHED images and download packages.

The queue is the database itself (images.indexing_status = 'pending'). Each item is claimed
with SELECT ... FOR UPDATE SKIP LOCKED, so several workers can run at once without two of
them taking the same image — the same code scales from this prototype to a server farm.
"""
from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app import audit, parameters
from app.db.models import (Event, EventStatus, FaceEmbedding, Image, ImageIndexingStatus,
                           ImageReviewStatus)
from app.db.models import VisitorSession as VisitorSessionModel
from app.face.port import FaceEngine, FaceEngineUnavailable
from app.imaging import decode_image
from app.institutional import service as institutional
from app.storage.port import ObjectStorage

log = logging.getLogger("fotomac.worker")
MAX_ATTEMPTS = 3


def _now() -> datetime:
    return datetime.now(timezone.utc)


def index_next(db: Session, storage: ObjectStorage, engine: FaceEngine) -> bool:
    """Index one pending image. Returns False when the queue is empty."""
    image = db.scalar(
        select(Image).where(Image.indexing_status == ImageIndexingStatus.PENDING,
                            Image.review_status == ImageReviewStatus.PUBLISHED,  # published only, checked twice (the database checks it too)
                            (Image.next_attempt_at.is_(None)) | (Image.next_attempt_at <= _now()))
        .order_by(Image.published_at, Image.id).limit(1).with_for_update(skip_locked=True))
    if image is None:
        return False
    try:
        # Faces below the administrator's minimum confidence are not indexed.
        floor = parameters.get(db, "min_detection_score")
        faces = [f for f in engine.detect(decode_image(storage.get(image.object_key))) if f.detection_score >= floor]
        # Re-indexing replaces the vectors of this model only after the new ones exist.
        db.query(FaceEmbedding).filter(FaceEmbedding.image_id == image.id,
                                       FaceEmbedding.model_version == engine.model_version).delete()
        for face in faces:
            db.add(FaceEmbedding(image_id=image.id, event_id=image.event_id, model_version=engine.model_version,
                                 dim=engine.vector_dim, embedding=face.embedding, bbox_x=face.bbox.x,
                                 bbox_y=face.bbox.y, bbox_width=face.bbox.width, bbox_height=face.bbox.height,
                                 detection_score=face.detection_score))
        image.faces_count = len(faces)
        image.indexing_status = ImageIndexingStatus.PROCESSED if faces else ImageIndexingStatus.NO_FACES
        image.indexed_at, image.indexing_model_version, image.last_error = _now(), engine.model_version, None
        db.flush()
        institutional.mark_image(db, image, engine.model_version)   # every new photo
    except Exception as exc:  # one bad file never stops the queue
        db.rollback()
        image = db.get(Image, image.id)
        image.indexing_attempts += 1
        image.last_error = type(exc).__name__[:200]  # the class name only: no file content, no personal data
        if image.indexing_attempts >= MAX_ATTEMPTS:
            image.indexing_status = ImageIndexingStatus.FAILED
        else:  # progressive interval: 20 s, 40 s
            image.next_attempt_at = _now() + timedelta(seconds=10 * 2 ** image.indexing_attempts)
        log.warning("indexing failed for image %s: %s", image.id, image.last_error)
    db.commit()
    finish_events(db)
    return True


def finish_events(db: Session) -> None:
    """An event leaves "Em Processamento" for "Publicado" as soon as no published
    image of it is waiting in the queue."""
    waiting = select(Image.event_id).where(Image.indexing_status == ImageIndexingStatus.PENDING)
    for event in db.scalars(select(Event).where(Event.status == EventStatus.PROCESSING, Event.id.not_in(waiting))):
        event.status = EventStatus.PUBLISHED
        audit.record(db, "event.published", None, "event", event.id,
                     faces=db.scalar(select(func.count()).select_from(FaceEmbedding)
                                     .where(FaceEmbedding.event_id == event.id)))
    db.commit()


def delete_due_removals(db: Session, storage: ObjectStorage, sender=None) -> int:
    """72 h after a removal request the image is deleted by the system itself,
    whatever the photographer did — no answer never means the image stays."""
    from app.images.service import delete_image
    from app.public.service import due_removals
    images = due_removals(db)
    for image in images:
        delete_image(db, storage, None, image, sender=sender)
    from app.public.service import due_video_removals
    from app.videos.service import delete_video
    videos = due_video_removals(db)
    for video in videos:   # RF035: a video asked to go leaves in 72 hours too
        delete_video(db, storage, None, video, sender=sender)
    db.query(VisitorSessionModel).filter(VisitorSessionModel.expires_at < _now()).delete()  # housekeeping
    db.commit()
    return len(images) + len(videos)


class Worker:
    """Runs the queue in a daemon thread inside the API process (enough for the prototype).
    For production it can run as its own process: `python -m app.indexing.worker`.

    The engine is asked for on every round (`engine_for(db)` = the one chosen in the panel), so a
    swap made by the administrator is followed without restarting. If it cannot be loaded, the
    facial queues simply WAIT — no attempt is spent, no image is marked as failed — while
    packages, expiry and removals keep running (safe failure)."""

    def __init__(self, session_factory: sessionmaker, storage: ObjectStorage,
                 engine_for: Callable[[Session], FaceEngine], idle_seconds: float = 1.0):
        self._sessions, self._storage, self._engine_for = session_factory, storage, engine_for
        self._idle = idle_seconds
        self._engine_problem: str | None = None
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="fotomac-worker", daemon=True)
        # A thread of its own: a conversion takes minutes and must not hold back the photos of other events.
        self._video_thread = threading.Thread(target=self._run_videos, name="fotomac-video-worker", daemon=True)

    def start(self) -> None:
        self._thread.start()
        self._video_thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=10)
        self._video_thread.join(timeout=10)

    def _run_videos(self) -> None:
        from app.videos.recognition import index_next_video
        from app.videos.service import process_next
        while not self._stop.is_set():
            busy = False
            try:
                with self._sessions() as db:
                    busy = process_next(db, self._storage)
                if not busy:  # RF035: the published videos, after the conversions
                    engine = self._engine()
                    if engine:
                        with self._sessions() as db:
                            busy = index_next_video(db, self._storage, engine)
            except Exception:
                log.exception("video worker loop error")
            if not busy:
                self._stop.wait(self._idle)

    def _run(self) -> None:
        from app.accounts import photo as profile_photo
        from app.accounts import service as accounts
        from app.calibration import service as calibration
        from app.events import collaboration, deletion
        from app.events.expiry import expire_due, notify_expiring
        from app.images.service import eliminate_rejected
        from app.indexing.reindex import reindex_next
        from app.notifications.factory import get_email_sender
        from app.packages.service import build_next, expire_packages
        from app.support import service as support
        from app.videos.service import eliminate_rejected as eliminate_rejected_videos
        last_cleanup = 0.0
        while not self._stop.is_set():
            busy = False
            try:
                engine = self._engine()
                if engine:
                    with self._sessions() as db:
                        busy = index_next(db, self._storage, engine)
                with self._sessions() as db:
                    busy = build_next(db, self._storage) or busy
                if engine and not busy:  # re-indexing only when publication has nothing waiting
                    with self._sessions() as db:
                        busy = reindex_next(db, self._storage, engine)
                if engine and not busy:  # (re)search the collection for a person who authorized
                    with self._sessions() as db:
                        busy = institutional.refresh_next(db, self._storage, engine)
                if not busy:  # the panel's quality test: last in line, a few photos per round
                    with self._sessions() as db:
                        busy = calibration.run_next(db, self._storage)
                if time.monotonic() - last_cleanup > 60:
                    with self._sessions() as db:
                        expire_packages(db, self._storage)
                    with self._sessions() as db:
                        delete_due_removals(db, self._storage)
                    with self._sessions() as db:  # LGPD Art. 6, III: no forgotten test keeps a person's photo
                        calibration.close_stale(db, self._storage)
                    with self._sessions() as db:  # retention
                        notify_expiring(db, get_email_sender())
                    with self._sessions() as db:
                        expire_due(db, self._storage, get_email_sender())
                    with self._sessions() as db:  # "Excluir evento": eliminated when the grace period ends
                        deletion.delete_due(db, self._storage, get_email_sender())
                    with self._sessions() as db:  # temporary accounts end after 24 h (never deleted)
                        accounts.expire_contractors(db)
                    with self._sessions() as db:  # CPF and birth date only while needed
                        accounts.erase_contractor_identities(db)
                    with self._sessions() as db:  # an ended temporary account keeps no profile photo
                        profile_photo.remove_from_ended_accounts(db, self._storage)
                    with self._sessions() as db:  # solved support messages do not stay forever
                        support.delete_old(db)
                    with self._sessions() as db:  # nor answered collaboration requests
                        collaboration.delete_old(db)
                    with self._sessions() as db:  # a registration nobody signed does not stay
                        institutional.expire_pending(db, self._storage)
                    with self._sessions() as db:  # a rejected photo goes 7 days after the rejection
                        eliminate_rejected(db, self._storage)
                    with self._sessions() as db:
                        eliminate_rejected_videos(db, self._storage)
                    last_cleanup = time.monotonic()
            except Exception:
                log.exception("worker loop error")
            if not busy:
                self._stop.wait(self._idle)

    def _engine(self) -> FaceEngine | None:
        try:
            with self._sessions() as db:
                engine = self._engine_for(db)
        except FaceEngineUnavailable as exc:
            if str(exc) != self._engine_problem:  # logged once per problem, not every second
                log.error("face engine unavailable, facial queues waiting: %s", exc)
                self._engine_problem = str(exc)
            return None
        self._engine_problem = None
        return engine


if __name__ == "__main__":  # standalone process
    from app.db.session import get_engine
    from app.face.factory import active_engine
    from app.storage.factory import get_storage
    logging.basicConfig(level=logging.INFO)
    w = Worker(sessionmaker(bind=get_engine()), get_storage(), active_engine)
    w.start()
    w._thread.join()
