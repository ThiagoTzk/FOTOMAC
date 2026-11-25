"""End of the retention period (LGPD Art. 15 and 16): warn, then eliminate.

- At least 30 days before the expiry date, the responsible photographer and every photographer
  with published photos in the event receive an e-mail recommending the package download
 .
- On the expiry date the event becomes "Expirado" — automatic and irreversible — and
  its collection is eliminated CONSISTENTLY: original files, reduced copies, cover, packages,
  face vectors and image records. The event row stays, without any photo, as the
  proof of the elimination, together with the audit entry counting what was removed.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import audit
from app.db.models import (Account, Event, EventStatus, FaceEmbedding, Image, ImageReviewStatus, PackageJob,
                           PackageStatus, RemovalStatus, Video, VisitorSession)
from app.notifications.port import EmailMessage, EmailSender, notify
from app.parameters import NOTICE_DAYS
from app.storage.port import ObjectStorage


def _photographers(db: Session, event: Event) -> list[str]:
    uploaders = db.scalars(select(Account.email).join(Image, Image.uploaded_by == Account.id).where(
        Image.event_id == event.id, Image.review_status == ImageReviewStatus.PUBLISHED).distinct()).all()
    return sorted({event.owner.email, *uploaders})


def notify_expiring(db: Session, sender: EmailSender, today: date | None = None) -> int:
    today = today or date.today()
    due = db.scalars(select(Event).where(
        Event.status != EventStatus.EXPIRED, Event.expiry_notice_sent_at.is_(None),
        Event.expires_on <= today + timedelta(days=NOTICE_DAYS))).all()
    for event in due:
        when = event.expires_on.strftime("%d/%m/%Y")
        delivered = True
        for email in _photographers(db, event):
            delivered &= notify(sender, EmailMessage(
                to=email, subject=f"FOTOMAC: o evento “{event.name}” expira em {when}",
                body=(f"O evento “{event.name}” atinge o fim do prazo de retenção em {when}.\n\n"
                      "Nessa data, todas as fotos, os vídeos e os dados de reconhecimento facial do evento serão eliminados "
                      "automaticamente e de forma irreversível. O FOTOMAC não guarda cópia.\n\n"
                      "Recomendamos baixar o acervo antes disso, para guarda própria: no painel, abra o evento e use "
                      "“Baixar acervo”. Os vídeos não entram no pacote: baixe cada um na aba Vídeos.\n\nEquipe FOTOMAC\nCentro Universitário CESMAC")))
        if not delivered:
            continue   # the mail server failed: the worker tries the notice again on its next round (17/11/2026)
        event.expiry_notice_sent_at = datetime.now(timezone.utc)
        audit.record(db, "event.expiry_notice", None, "event", event.id, expires_on=event.expires_on.isoformat())
    db.commit()
    return len(due)


def expire_due(db: Session, storage: ObjectStorage, sender: EmailSender, today: date | None = None) -> int:
    today = today or date.today()
    due = db.scalars(select(Event).where(Event.status != EventStatus.EXPIRED, Event.expires_on < today)).all()
    for event in due:
        expire_event(db, storage, sender, event)
    return len(due)


def expire_event(db: Session, storage: ObjectStorage, sender: EmailSender, event: Event) -> None:
    counts = eliminate_collection(db, storage, sender, event)
    event.cover_object_key = None
    event.collaboration_open = False
    event.status = EventStatus.EXPIRED  # irreversible: nothing ever sets it back
    audit.record(db, "event.expired", None, "event", event.id, **counts)
    db.commit()


def eliminate_collection(db: Session, storage: ObjectStorage, sender: EmailSender, event: Event) -> dict:
    """Every photo, video, reduced copy, cover, package and face vector of the event — files first."""
    from app.public.service import conclude_removals

    images = db.scalars(select(Image).where(Image.event_id == event.id)).all()
    videos = db.scalars(select(Video).where(Video.event_id == event.id)).all()
    vectors = db.scalar(select(func.count()).select_from(FaceEmbedding).where(FaceEmbedding.event_id == event.id)) or 0
    files = 0
    # Files first, records last (same reason as delete_image): a storage failure leaves the
    # database untouched and the next run simply tries again — never an orphan file.
    keys = [event.cover_object_key]
    for image in images:
        keys += image.storage_keys
    for video in videos:
        keys += video.storage_keys
    packages = db.scalars(select(PackageJob).where(PackageJob.event_id == event.id)).all()
    keys += [p.object_key for p in packages]
    for key in filter(None, keys):
        storage.delete(key)
        files += 1
    for image in images:
        if image.removal_requested_at is not None:  # whoever asked is told it is gone
            conclude_removals(db, sender, image.id, RemovalStatus.DELETED_AUTOMATICALLY)
        db.delete(image)  # face vectors go with it (ON DELETE CASCADE)
    for video in videos:
        db.delete(video)
    for p in packages:
        p.status, p.object_key = PackageStatus.EXPIRED, None
    db.query(VisitorSession).filter(VisitorSession.event_id == event.id).delete()
    return {"images": len(images), "videos": len(videos), "vectors": vectors, "files": files}
