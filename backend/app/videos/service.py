"""Videos of the collection (RF034): the same review, publication, retention and removal as the photos, with the
processing a video needs. Since 04/11/2026 the published ones are recognised (RF035, app/videos/recognition.py), and a
visitor found in a video receives it.
"""
from __future__ import annotations

import hashlib
import logging
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app import audit, parameters
from app.db.models import (AUTHOR_ROLES, Account, AccountRole, Event, EventStatus, ImageReviewStatus, Video,
                           VideoProcessingStatus)
from app.events.service import EventError, NotFound, PermissionDenied, can_manage, has_uploaded, relation
from app.images.processing import FileRejected, ownership_notice
from app.images.service import MAX_PER_EVENT, REJECTED_KEEP_DAYS, can_upload, media_count
from app.storage.port import ObjectStorage
from app.videos import media, recognition

log = logging.getLogger("fotomac.videos")
MAX_ATTEMPTS = 3
STALE_AFTER = timedelta(hours=5)   # longer than the longest conversion: the server stopped in the middle of it
CONTENT_TYPES = {"mp4": "video/mp4", "mov": "video/quicktime", "mkv": "video/x-matroska"}

FILTERS = {
    "in_review": and_(Video.review_status == ImageReviewStatus.IN_REVIEW, Video.approval.is_distinct_from("rejected")),
    "discarded": Video.review_status == ImageReviewStatus.DISCARDED,
    "published": Video.review_status == ImageReviewStatus.PUBLISHED,
    "processing": Video.processing_status.in_([VideoProcessingStatus.PENDING, VideoProcessingStatus.PROCESSING]),
    "failed": Video.processing_status == VideoProcessingStatus.FAILED,
    "pending_approval": Video.approval == "pending",
    "rejected": Video.approval == "rejected",
    # What "Publicar" would publish now: converted, and neither waiting for the administrator nor rejected.
    "ready": and_(Video.review_status == ImageReviewStatus.IN_REVIEW, Video.processing_status == VideoProcessingStatus.READY,
                  Video.approval.is_(None) | (Video.approval == "approved")),
}


class DuplicateVideo(FileRejected):
    def __init__(self):
        super().__init__("duplicate", "Este vídeo já está neste evento (o mesmo arquivo foi escolhido de novo). Em outro evento ele pode entrar.")


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ------------------------------------------------------------------ permissions

def visible(db: Session, account: Account, event: Event):
    """The same rule of the photos: a hired photographer sees only its own; marketing on someone else's
    event, only what is published."""
    if account.role == AccountRole.CONTRACTOR:
        return Video.uploaded_by == account.id
    if relation(account, event, bool(has_uploaded(db, account, [event.id]))) == "viewer":
        return Video.review_status == ImageReviewStatus.PUBLISHED
    return None


def can_manage_video(account: Account, video: Video) -> bool:
    return can_manage(account, video.event) or (video.uploaded_by == account.id and not video.event.blocks(account.id))


def can_download(account: Account, video: Video) -> bool:
    if can_manage_video(account, video) or video.uploaded_by == account.id:
        return True
    return account.role == AccountRole.MARKETING and video.review_status == ImageReviewStatus.PUBLISHED


def get_video(db: Session, video_id: uuid.UUID, account: Account) -> Video:
    from app.events.service import get_visible
    video = db.get(Video, video_id)
    if video is None:
        raise NotFound("Vídeo não encontrado.")
    event = get_visible(db, account, video.event_id)
    scope = visible(db, account, event)
    if scope is not None and not db.scalar(select(Video.id).where(Video.id == video.id, scope)):
        raise NotFound("Vídeo não encontrado.")
    return video


# ------------------------------------------------------------------ upload

def _checksum(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def upload_video(db: Session, storage: ObjectStorage, account: Account, event: Event, path: Path) -> Video:
    """`path` is a temporary file, never read whole into memory. The location goes BEFORE anything is stored."""
    if not can_upload(account, event):
        raise PermissionDenied("Você não pode enviar vídeos a este evento.")
    if not account.photographer_signature and account.role in AUTHOR_ROLES:
        raise EventError("Defina sua assinatura em Meu perfil antes de enviar vídeos.")
    if not media.available():
        log.error("ffmpeg not found: video upload refused")
        raise EventError("O envio de vídeos está indisponível no momento. Avise o administrador.")
    stored_as = media.format_of(path)
    size = path.stat().st_size
    if size > parameters.video_max_bytes(db):
        raise FileRejected("too_large", f"O vídeo ultrapassa o limite de {int(parameters.get(db, 'max_video_mb'))} MB.")
    checksum = _checksum(path)
    if db.scalar(select(Video.id).where(Video.event_id == event.id, Video.sha256 == checksum)):
        raise DuplicateVideo()
    if media_count(db, event) >= MAX_PER_EVENT:
        raise FileRejected("event_limit", "O evento atingiu o limite de 1.000 mídias.")
    info = media.probe(path)
    if info.duration > parameters.video_max_seconds(db):
        raise FileRejected("too_long", f"O vídeo ultrapassa o limite de {int(parameters.get(db, 'max_video_minutes'))} minutos.")

    signature = account.photographer_signature or account.full_name
    video_id = uuid.uuid4()  # random, not sequential: the collection cannot be enumerated
    with tempfile.TemporaryDirectory(prefix="fotomac-video-") as folder:
        try:
            cleaned, source_format = media.clean(path, Path(folder), info, signature, ownership_notice(signature), stored_as)
            found = media.has_location(cleaned)
        except Exception:
            log.exception("video could not be cleaned")
            raise FileRejected("corrupted", "O vídeo está corrompido e não pôde ser lido.") from None
        if found:  # safe failure: without certainty that the location left, the file is not kept
            log.error("location survived the cleaning of a video: refused")
            raise FileRejected("location", "Não foi possível remover a localização deste vídeo, e ele não foi guardado.")
        size_clean = cleaned.stat().st_size
        key = f"events/{event.id}/videos/{video_id}.{source_format}"
        storage.put_file(key, str(cleaned), CONTENT_TYPES[source_format])
    video = Video(id=video_id, event_id=event.id, uploaded_by=account.id, object_key=key, sha256=checksum, size_bytes=size_clean,
                  duration_seconds=info.duration, width=info.width, height=info.height, video_codec=info.video_codec,
                  audio_codec=info.audio_codec, source_format=source_format, captured_at=media.captured_at(info),
                  credit_signature=signature, approval="pending" if account.role == AccountRole.CONTRACTOR else None)
    db.add(video)
    audit.record(db, "video.upload", account.id, "video", video.id, event_id=str(event.id),
                 collaborator=event.owner_id != account.id)
    db.commit()
    return video


# ------------------------------------------------------------------ the conversion queue

def process_next(db: Session, storage: ObjectStorage) -> bool:
    """One video of the queue. The row is marked and committed first, because a conversion takes minutes and a
    transaction must not stay open that long. Returns False when the queue is empty."""
    db.query(Video).filter(Video.processing_status == VideoProcessingStatus.PROCESSING,
                           Video.processing_started_at < _now() - STALE_AFTER).update(
        {Video.processing_status: VideoProcessingStatus.PENDING}, synchronize_session=False)
    video = db.scalar(select(Video).where(Video.processing_status == VideoProcessingStatus.PENDING,
                                          (Video.next_attempt_at.is_(None)) | (Video.next_attempt_at <= _now()))
                      .order_by(Video.uploaded_at, Video.id).limit(1).with_for_update(skip_locked=True))
    if video is None:
        db.commit()
        return False
    video.processing_status, video.processing_started_at = VideoProcessingStatus.PROCESSING, _now()
    db.commit()
    video_id, source_key, source_format = video.id, video.object_key, video.source_format
    base = source_key.rsplit(".", 1)[0]
    try:
        with tempfile.TemporaryDirectory(prefix="fotomac-video-") as folder:
            source, web, thumb = Path(folder) / f"source.{source_format}", Path(folder) / "web.mp4", Path(folder) / "thumb.jpg"
            storage.get_file(source_key, str(source))
            info = media.probe(source)
            media.thumbnail(source, thumb, info)
            convert = not media.plays_everywhere(info, source_format)
            if convert:
                media.to_web(source, web, info)
            web_key = f"{base}_web.mp4" if convert else source_key
            web_bytes = web.stat().st_size if convert else source.stat().st_size
            thumb_key = f"{base}_thumb.jpg"
            if convert:
                storage.put_file(web_key, str(web), "video/mp4")
            storage.put_file(thumb_key, str(thumb), "image/jpeg")
    except Exception as exc:  # one bad file never stops the queue
        db.rollback()
        video = db.get(Video, video_id)
        if video is not None:
            video.processing_attempts += 1
            video.last_error = type(exc).__name__[:200]  # the class name only: no file content, no personal data
            if video.processing_attempts >= MAX_ATTEMPTS:
                video.processing_status = VideoProcessingStatus.FAILED
            else:
                video.processing_status = VideoProcessingStatus.PENDING
                video.next_attempt_at = _now() + timedelta(seconds=30 * 2 ** video.processing_attempts)
            log.warning("conversion failed for video %s: %s", video_id, video.last_error)
            db.commit()
        return True
    db.expire_all()
    video = db.get(Video, video_id)
    if video is None:  # eliminated with its event during the conversion: the new files go too
        for key in {web_key, thumb_key} - {source_key}:
            storage.delete(key)
        return True
    video.web_key, video.web_bytes, video.thumb_key = web_key, web_bytes, thumb_key
    video.processing_status, video.last_error, video.next_attempt_at = VideoProcessingStatus.READY, None, None
    audit.record(db, "video.ready", None, "video", video.id, converted=web_key != source_key)
    db.commit()
    return True


def retry(db: Session, account: Account, video: Video) -> Video:
    if not can_manage_video(account, video):
        raise PermissionDenied("Você só pode reprocessar os vídeos que enviou.")
    if video.processing_status != VideoProcessingStatus.FAILED:
        raise EventError("Só vídeos com falha na conversão podem ser reprocessados.")
    video.processing_status, video.processing_attempts = VideoProcessingStatus.PENDING, 0
    video.next_attempt_at, video.last_error = None, None
    audit.record(db, "video.retry", account.id, "video", video.id)
    db.commit()
    return video


# ------------------------------------------------------------------ review and publication

def set_discarded(db: Session, account: Account, video: Video, discarded: bool) -> Video:
    if not can_manage_video(account, video):
        raise PermissionDenied("Você só pode descartar os vídeos que enviou.")
    if video.review_status == ImageReviewStatus.PUBLISHED:
        raise EventError("Vídeo já publicado: use a exclusão.")
    video.review_status = ImageReviewStatus.DISCARDED if discarded else ImageReviewStatus.IN_REVIEW
    audit.record(db, "video.discard" if discarded else "video.restore", account.id, "video", video.id)
    db.commit()
    return video


def _delete_files(storage: ObjectStorage, video: Video) -> None:
    for key in video.storage_keys:
        storage.delete(key)


def delete_video(db: Session, storage: ObjectStorage, account: Account | None, video: Video, sender=None) -> None:
    """Files first, record last, as with the photos: a storage failure leaves everything to be tried again.
    account None: the system itself, 72 hours after a removal request (RF035)."""
    if account is not None and not can_manage_video(account, video):
        raise PermissionDenied("Você só pode excluir os vídeos que enviou.")
    if account is not None and video.processing_status == VideoProcessingStatus.PROCESSING:
        raise EventError("Este vídeo está sendo convertido. Aguarde terminar para excluir.")
    _delete_files(storage, video)
    audit.record(db, "video.delete", account.id if account else None, "video", video.id, event_id=str(video.event_id),
                 was_published=video.review_status == ImageReviewStatus.PUBLISHED,
                 removal=video.removal_requested_at is not None)
    if video.removal_requested_at is not None:
        from app.db.models import RemovalStatus
        from app.notifications.factory import get_email_sender
        from app.public.service import conclude_video_removals
        conclude_video_removals(db, sender or get_email_sender(), video.id,
                                RemovalStatus.DELETED_AUTOMATICALLY if account is None else RemovalStatus.DELETED_BY_PHOTOGRAPHER)
    db.delete(video)
    db.commit()


def publish(db: Session, storage: ObjectStorage, account: Account, event: Event, ids: list[uuid.UUID] | None = None) -> dict:
    """Publishing a video does not put it on the public site: it opens it to the teams that use the published
    collection, and so it does not change the status of the event. Only ready videos are published."""
    if not can_manage(account, event):
        raise PermissionDenied("Somente o fotógrafo responsável pelo evento pode publicar os vídeos.")
    if event.status == EventStatus.EXPIRED:
        raise EventError("Este evento expirou.")
    if event.deletion_due_at:
        raise EventError("Este evento está com exclusão agendada. Desfaça a exclusão para publicar.")
    ready = select(Video).where(Video.event_id == event.id, FILTERS["ready"])
    videos = db.scalars(ready.where(Video.id.in_(ids)) if ids is not None else ready).all()
    if not videos:
        raise EventError("Não há vídeos prontos para publicar.")
    discarded = db.scalars(select(Video).where(Video.event_id == event.id, FILTERS["discarded"])).all()
    now = _now()
    for video in videos:
        video.review_status, video.published_at = ImageReviewStatus.PUBLISHED, now
        recognition.queue(video)   # RF035: the published video is analysed for faces
    for video in discarded:  # discarding becomes definitive with the publication, as with the photos
        _delete_files(storage, video)
        db.delete(video)
    audit.record(db, "video.publish", account.id, "event", event.id, publicados=len(videos), descartados=len(discarded))
    db.commit()
    return {"published": len(videos), "discarded": len(discarded)}


def decide_approval(db: Session, admin: Account, video: Video, approve: bool, reason: str | None) -> Video:
    if admin.role != AccountRole.ADMIN:
        raise PermissionDenied("Somente o administrador aprova os vídeos do fotógrafo contratado.")
    if video.approval != "pending":
        raise EventError("Este vídeo não está aguardando aprovação.")
    if approve:
        video.approval, video.approved_by, video.approved_at = "approved", admin.id, _now()
        audit.record(db, "video.approved", admin.id, "video", video.id, uploaded_by=str(video.uploaded_by))
    else:
        text = " ".join((reason or "").split())
        if not 5 <= len(text) <= 300:
            raise EventError("Escreva o motivo da recusa (de 5 a 300 caracteres): o fotógrafo contratado vai lê-lo.")
        video.approval, video.rejection_reason, video.rejected_by, video.rejected_at = "rejected", text, admin.id, _now()
        audit.record(db, "video.rejected", admin.id, "video", video.id, uploaded_by=str(video.uploaded_by), reason=text)
    db.commit()
    return video


def eliminate_rejected(db: Session, storage: ObjectStorage) -> int:
    due = db.scalars(select(Video).where(Video.approval == "rejected",
                                         Video.rejected_at < _now() - timedelta(days=REJECTED_KEEP_DAYS))).all()
    for video in due:
        _delete_files(storage, video)
        audit.record(db, "video.rejected_eliminated", None, "video", video.id, event_id=str(video.event_id))
        db.delete(video)
    db.commit()
    return len(due)


# ------------------------------------------------------------------ queries

def list_videos(db: Session, account: Account, event: Event, filter_: str = "all") -> list[Video]:
    q = select(Video).where(Video.event_id == event.id)
    scope = visible(db, account, event)
    if scope is not None:
        q = q.where(scope)
    if filter_ in FILTERS:
        q = q.where(FILTERS[filter_])
    return list(db.scalars(q.order_by(Video.uploaded_at, Video.id)))


def counts(db: Session, event: Event, account: Account) -> dict:
    scope = visible(db, account, event)
    base = [Video.event_id == event.id] + ([scope] if scope is not None else [])
    out = {key: db.scalar(select(func.count()).select_from(Video).where(*base, cond)) or 0 for key, cond in FILTERS.items()}
    out["all"] = db.scalar(select(func.count()).select_from(Video).where(*base)) or 0
    return out


def storage_used(db: Session, event: Event) -> int:
    """Original plus the converted copy, when there is one (RF034, note 3)."""
    rows = db.execute(select(Video.size_bytes, Video.web_bytes, Video.web_key, Video.object_key).where(Video.event_id == event.id)).all()
    return sum(r.size_bytes + (r.web_bytes or 0 if r.web_key != r.object_key else 0) for r in rows)


def tool_ready() -> bool:
    return media.available()
