"""Image rules — independent of HTTP."""
from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import cv2
from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app import audit, parameters
from app.db.models import (AUTHOR_ROLES, PRODUCER_ROLES, Account, AccountRole, AccountStatus, Event, EventStatus,
                           FaceEmbedding, Image, ImageIndexingStatus, ImageReviewStatus, InstitutionalMark, Video)
from app.events.service import EventError, NotFound, PermissionDenied, can_manage, has_uploaded, relation
from app.imaging import blur_regions, decode_image
from app.imaging_meta import captured_at
from app.images import formats
from app.images.processing import FileRejected, PreparedImage, prepare
from app.storage.port import ObjectStorage

MAX_PER_EVENT = 1000
MAX_PER_BATCH = 500           # files per sending operation (300 until 17/10/2026)
MAX_REPROCESS_PER_DAY = 3
REJECTED_KEEP_DAYS = 7        # a rejected photo stays visible to its sender, with the reason, then goes


@dataclass
class UploadResult:
    image: Image


class DuplicateImage(FileRejected):
    def __init__(self):
        super().__init__("duplicate", "Esta imagem já está no acervo do evento e não será enviada novamente.")


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ------------------------------------------------------------------ permissions

def can_upload(account: Account, event: Event) -> bool:
    """Responsible, administrator, any active photographer or marketing account when collaboration is
    open or after its request was accepted, and the hired photographer, only to the event it is bound to."""
    if event.status == EventStatus.EXPIRED or event.deletion_due_at or account.status != AccountStatus.ACTIVE:
        return False
    if event.blocks(account.id):  # access turned off in "Configuração do evento"
        return False
    if account.role == AccountRole.CONTRACTOR:  # independent of the collaboration
        return event.id == account.bound_event_id
    return can_manage(account, event) or (account.role in PRODUCER_ROLES
                                          and (event.collaboration_open or event.admits(account.id)))


def visible_images(db: Session, account: Account, event: Event):
    """Which images of the event the account sees in the panel (None = all of them):
    - a hired photographer, only its own;
    - the marketing team on someone else's event ("viewer"), only the published photos that are not
      on their way out — never the photos still under review."""
    if account.role == AccountRole.CONTRACTOR:
        return Image.uploaded_by == account.id
    if relation(account, event, bool(has_uploaded(db, account, [event.id]))) == "viewer":
        return and_(Image.review_status == ImageReviewStatus.PUBLISHED, Image.removal_requested_at.is_(None))
    return None


def can_manage_image(account: Account, image: Image) -> bool:
    """A collaborator manages only the images they sent, while their access to the event is on; responsible
    and admin manage all."""
    return can_manage(account, image.event) or (image.uploaded_by == account.id and not image.event.blocks(account.id))


def can_download(account: Account, image: Image) -> bool:
    """Individual download in the panel. Whoever manages the image (its author, the responsible, the
    administrator) and, for institutional publicity, the marketing team — published images only, and
    never one whose removal was asked. A collaborator does not download someone else's
    work (the same principle as the collection download)."""
    if can_manage_image(account, image) or image.uploaded_by == account.id:  # its own work, even with the access off
        return True
    return (account.role == AccountRole.MARKETING and image.review_status == ImageReviewStatus.PUBLISHED
            and image.removal_requested_at is None)


def record_download(db: Session, account: Account, image: Image) -> None:
    """Account, event, image and date — "publicity" when it is marketing on someone's work."""
    audit.record(db, "image.download", account.id, "image", image.id, event_id=str(image.event_id),
                 publicity=not (can_manage_image(account, image) or image.uploaded_by == account.id))
    db.commit()


def get_image(db: Session, image_id: uuid.UUID, account: Account) -> Image:
    from app.events.service import get_visible  # local: avoids a circular import
    image = db.get(Image, image_id)
    if image is None:
        raise NotFound("Imagem não encontrada.")
    event = get_visible(db, account, image.event_id)  # raises NotFound if the event is not visible
    scope = visible_images(db, account, event)
    if scope is not None and not db.scalar(select(Image.id).where(Image.id == image.id, scope)):
        raise NotFound("Imagem não encontrada.")
    return image


# ------------------------------------------------------------------ upload

def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def existing_checksums(db: Session, event: Event, checksums: list[str]) -> set[str]:
    """Lets the screen flag duplicates BEFORE sending."""
    rows = db.scalars(select(Image.sha256).where(Image.event_id == event.id, Image.sha256.in_(checksums[:MAX_PER_BATCH])))
    return set(rows)


def _store_source(storage: ObjectStorage, base: str, prepared: PreparedImage) -> str | None:
    """The original in PNG, WebP, HEIC or RAW, beside its JPEG copy."""
    if prepared.source is None:
        return None
    key = f"{base}_original.{prepared.source_ext}"
    storage.put(key, prepared.source, formats.CONTENT_TYPES.get(prepared.source_ext, "application/octet-stream"))
    return key


def upload_image(db: Session, storage: ObjectStorage, account: Account, event: Event, data: bytes,
                 filename: str = "") -> Image:
    if not can_upload(account, event):
        raise PermissionDenied("Você não pode enviar imagens a este evento.")
    if not account.photographer_signature and account.role in AUTHOR_ROLES:
        raise EventError("Defina sua assinatura em Meu perfil antes de enviar imagens.")
    checksum = sha256(data)  # of the file AS SENT, so the same file is recognised again
    if db.scalar(select(Image.id).where(Image.event_id == event.id, Image.sha256 == checksum)):
        raise DuplicateImage()
    if media_count(db, event) >= MAX_PER_EVENT:
        raise FileRejected("event_limit", "O evento atingiu o limite de 1.000 mídias.")

    signature = account.photographer_signature or account.full_name
    prepared = prepare(data, signature, filename, parameters.raw_max_bytes(db, event))
    image_id = uuid.uuid4()  # random, not sequential: the collection cannot be enumerated
    base = f"events/{event.id}/{image_id}"
    keys = (f"{base}.jpg", f"{base}_thumb.jpg", f"{base}_preview.jpg")
    storage.put(keys[0], prepared.original, "image/jpeg")
    storage.put(keys[1], prepared.thumb, "image/jpeg")
    storage.put(keys[2], prepared.preview, "image/jpeg")
    source_key = _store_source(storage, base, prepared)
    image = Image(id=image_id, event_id=event.id, uploaded_by=account.id, object_key=keys[0], thumb_key=keys[1],
                  preview_key=keys[2], sha256=checksum, delivered_sha256=sha256(prepared.original), size_bytes=len(prepared.original), width=prepared.width,
                  height=prepared.height, captured_at=captured_at(prepared.original), credit_signature=signature,
                  source_key=source_key, source_format=prepared.source_ext if source_key else None,
                  source_bytes=len(prepared.source) if source_key else None,
                  review_status=ImageReviewStatus.IN_REVIEW,
                  # A hired photographer's photo waits for the administrator.
                  approval="pending" if account.role == AccountRole.CONTRACTOR else None)
    db.add(image)
    audit.record(db, "image.upload", account.id, "image", image.id, event_id=str(event.id),
                 collaborator=event.owner_id != account.id)
    db.commit()
    return image


def replace_file(db: Session, storage: ObjectStorage, account: Account, image: Image, data: bytes,
                 filename: str = "") -> Image:
    """An edited version replaces the original before publication — the old file is
    deleted, never kept."""
    if not can_manage_image(account, image):
        raise PermissionDenied("Você só pode substituir as imagens que enviou.")
    # 22/10/2026: the hired photographer does not replace files — a new version is a new image, which the
    # administrator reviews like any other. (It removes the case of an approved photo swapped afterwards.)
    if account.role == AccountRole.CONTRACTOR:
        raise PermissionDenied("O fotógrafo contratado não substitui arquivos: envie a nova versão como outra imagem.")
    if image.review_status != ImageReviewStatus.IN_REVIEW or image.approval == "rejected":
        raise EventError("Só é possível substituir imagens em conferência, antes da publicação.")
    checksum = sha256(data)
    if db.scalar(select(Image.id).where(Image.event_id == image.event_id, Image.sha256 == checksum, Image.id != image.id)):
        raise DuplicateImage()
    prepared = prepare(data, image.credit_signature, filename, parameters.raw_max_bytes(db, image.event))
    storage.put(image.object_key, prepared.original, "image/jpeg")
    storage.put(image.thumb_key, prepared.thumb, "image/jpeg")
    storage.put(image.preview_key, prepared.preview, "image/jpeg")
    image.sha256, image.size_bytes = checksum, len(prepared.original)
    image.delivered_sha256 = sha256(prepared.original)
    image.width, image.height, image.captured_at = prepared.width, prepared.height, captured_at(prepared.original)
    # The old original in another format goes (a JPEG edit has none); the new one, if any, takes its place.
    old_source = image.source_key
    image.source_key = _store_source(storage, image.object_key.removesuffix(".jpg"), prepared)
    if old_source and old_source != image.source_key:
        storage.delete(old_source)
    image.source_format = prepared.source_ext if image.source_key else None
    image.source_bytes = len(prepared.source) if image.source_key else None
    # An approval is about THIS file. A new file must be reviewed again — otherwise a photo
    # approved by the administrator could be swapped for anything and still say "approved by" them.
    reapproval = image.approval == "approved"
    if image.approval is not None:
        image.approval, image.approved_by, image.approved_at = "pending", None, None
    audit.record(db, "image.replace", account.id, "image", image.id, approval_reset=reapproval)
    db.commit()
    return image


# ------------------------------------------------------------------ blur faces in the file (04/11/2026)

MAX_BLUR_BOXES = 300


def _check_blur(account: Account, image: Image) -> None:
    if not can_manage_image(account, image):
        raise PermissionDenied("Você só pode tratar as imagens que enviou.")
    # Like replacing the file: the hired photographer's photos are changed only by a new upload.
    if account.role == AccountRole.CONTRACTOR:
        raise PermissionDenied("O fotógrafo contratado não altera arquivos: envie a nova versão como outra imagem.")
    if image.review_status == ImageReviewStatus.DISCARDED or image.approval == "rejected":
        raise EventError("Esta imagem não está mais no evento.")


def locate_faces(storage: ObjectStorage, account: Account, image: Image, engine) -> list:
    """Where the faces are, to choose the ones to blur: boxes only, NO vector (RNF13), so it works on a
    photo not yet published too."""
    _check_blur(account, image)
    return engine.locate(decode_image(storage.get(image.object_key)))


def blur_faces(db: Session, storage: ObjectStorage, account: Account, image: Image,
               boxes: list[tuple[int, int, int, int]]) -> Image:
    """Blurs the chosen faces IN THE FILE and replaces it: no copy with the faces is kept, the original in
    another format (RAW, HEIC...) included. A published photo leaves the search until it is indexed again:
    its vectors and institutional marks go, and the new file is indexed, so a blurred face gives no vector."""
    _check_blur(account, image)
    if not 1 <= len(boxes) <= MAX_BLUR_BOXES:
        raise EventError("Escolha ao menos um rosto para borrar.")
    pixels = decode_image(storage.get(image.object_key))
    h, w = pixels.shape[:2]
    if any(bw <= 0 or bh <= 0 or bx < 0 or by < 0 or bx + bw > w or by + bh > h for bx, by, bw, bh in boxes):
        raise EventError("A área escolhida está fora da foto.")
    blur_regions(pixels, boxes)
    prepared = prepare(cv2.imencode(".jpg", pixels, [cv2.IMWRITE_JPEG_QUALITY, 95])[1].tobytes(),
                       image.credit_signature, "borrada.jpg")
    del pixels
    storage.put(image.object_key, prepared.original, "image/jpeg")   # the file with the faces is gone
    storage.put(image.thumb_key, prepared.thumb, "image/jpeg")
    storage.put(image.preview_key, prepared.preview, "image/jpeg")
    if image.source_key:   # the RAW/HEIC/PNG original still shows the faces
        storage.delete(image.source_key)
        image.source_key = image.source_format = image.source_bytes = None
    # sha256 stays the one of the file AS SENT (05/11/2026): sending the unblurred original to the event again is
    # refused as a duplicate, and two copies of one photo blurred alike no longer clash in the unique checksum.
    image.delivered_sha256 = sha256(prepared.original)
    image.size_bytes, image.width, image.height = len(prepared.original), prepared.width, prepared.height
    image.faces_blurred += len(boxes)
    published = image.review_status == ImageReviewStatus.PUBLISHED
    if published:
        db.query(FaceEmbedding).filter(FaceEmbedding.image_id == image.id).delete()
        db.query(InstitutionalMark).filter(InstitutionalMark.image_id == image.id).delete()
        image.faces_count = None
        image.indexing_status, image.indexing_attempts, image.next_attempt_at = ImageIndexingStatus.PENDING, 0, None
    audit.record(db, "image.faces_blurred", account.id, "image", image.id, faces=len(boxes), published=published)
    db.commit()
    return image


# ------------------------------------------------------------------ review

def set_discarded(db: Session, account: Account, image: Image, discarded: bool) -> Image:
    if not can_manage_image(account, image):
        raise PermissionDenied("Você só pode descartar as imagens que enviou.")
    if image.review_status == ImageReviewStatus.PUBLISHED:
        raise EventError("Imagem já publicada: use a exclusão.")
    image.review_status = ImageReviewStatus.DISCARDED if discarded else ImageReviewStatus.IN_REVIEW
    audit.record(db, "image.discard" if discarded else "image.restore", account.id, "image", image.id)
    db.commit()
    return image


def _delete_objects(storage: ObjectStorage, image: Image) -> None:
    for key in image.storage_keys:
        if key:
            storage.delete(key)


def delete_image(db: Session, storage: ObjectStorage, account: Account | None, image: Image,
                 sender=None) -> None:
    """Consistent removal: file, reduced copies, metadata and every biometric
    vector (ON DELETE CASCADE in face_embeddings). account=None means the SYSTEM itself
    (automatic deletion at the end of the 72 h removal deadline)."""
    if account is not None and not can_manage_image(account, image):
        raise PermissionDenied("Você só pode excluir as imagens que enviou.")
    if image.removal_requested_at is not None:
        from app.db.models import RemovalStatus
        from app.notifications.factory import get_email_sender
        from app.public.service import conclude_removals
        conclude_removals(db, sender or get_email_sender(), image.id,
                          RemovalStatus.DELETED_AUTOMATICALLY if account is None else RemovalStatus.DELETED_BY_PHOTOGRAPHER)
    # Files first, record last: if the storage fails, nothing in the database changed and the
    # deletion can simply be retried. The reverse order could leave a photo in the storage
    # with no record pointing to it — a file nobody would ever find to delete.
    _delete_objects(storage, image)
    audit.record(db, "image.delete", account.id if account else None, "image", image.id, event_id=str(image.event_id),
                 was_published=image.review_status == ImageReviewStatus.PUBLISHED,
                 removal_requested=image.removal_requested_at is not None)
    db.delete(image)
    db.commit()


@dataclass
class PublishSummary:
    sent: int
    discarded: int
    published: int


def publish(db: Session, storage: ObjectStorage, account: Account, event: Event,
            ids: list[uuid.UUID] | None = None) -> PublishSummary:
    """Only the responsible photographer or the administrator publish. This is
    the act that allows biometric processing: only published images enter the queue.
    `ids` publishes only the selected images (17/10/2026); the others stay under review."""
    if not can_manage(account, event):
        raise PermissionDenied("Somente o fotógrafo responsável pelo evento pode publicar as imagens.")
    if event.status == EventStatus.EXPIRED:
        raise EventError("Este evento expirou.")
    if event.deletion_due_at:
        raise EventError("Este evento está com exclusão agendada. Desfaça a exclusão para publicar.")
    # Photos awaiting the administrator's approval stay out of the published set.
    ready = select(Image).where(Image.event_id == event.id, FILTERS["ready"])
    in_review = db.scalars(ready.where(Image.id.in_(ids)) if ids is not None else ready).all()
    waiting = db.scalar(select(func.count()).select_from(Image).where(
        Image.event_id == event.id, Image.review_status == ImageReviewStatus.IN_REVIEW, Image.approval == "pending"))
    discarded = db.scalars(select(Image).where(Image.event_id == event.id,
                                               Image.review_status == ImageReviewStatus.DISCARDED)).all()
    if ids is not None and not in_review:
        raise EventError("Nenhuma das imagens selecionadas está pronta para publicação.")
    if not in_review:
        raise EventError(f"Há {waiting} imagem(ns) aguardando a aprovação do administrador; nenhuma outra para publicar."
                         if waiting else "Não há imagens em conferência para publicar.")
    now = _now()
    for image in in_review:
        image.review_status = ImageReviewStatus.PUBLISHED
        image.indexing_status = ImageIndexingStatus.PENDING
        image.published_at = now
    # Discarding becomes definitive with the publication.
    for image in discarded:
        _delete_objects(storage, image)
        db.delete(image)
    # "Em Processamento" until indexing ends, so the public never sees a
    # half-indexed event. An already published event stays public while new images index.
    if event.status == EventStatus.EDITING:
        event.status = EventStatus.PROCESSING
    summary = PublishSummary(sent=len(in_review) + len(discarded), discarded=len(discarded), published=len(in_review))
    audit.record(db, "event.publish", account.id, "event", event.id, enviadas=summary.sent,
                 descartadas=summary.discarded, publicadas=summary.published)
    db.commit()
    return summary


def request_reprocess(db: Session, account: Account, image: Image) -> Image:
    """At most 3 manual requests per image in 24 h."""
    if not can_manage_image(account, image):
        raise PermissionDenied("Você só pode reprocessar as imagens que enviou.")
    if image.review_status != ImageReviewStatus.PUBLISHED:
        raise EventError("Só imagens publicadas passam pela indexação facial.")
    now = _now()
    if image.reprocess_window_start is None or now - image.reprocess_window_start > timedelta(hours=24):
        image.reprocess_window_start, image.reprocess_requests = now, 0
    if image.reprocess_requests >= MAX_REPROCESS_PER_DAY:
        raise EventError("Limite de 3 reprocessamentos em 24 horas atingido para esta imagem.")
    image.reprocess_requests += 1
    image.indexing_status = ImageIndexingStatus.PENDING
    image.indexing_attempts, image.next_attempt_at, image.last_error = 0, None, None
    audit.record(db, "image.reprocess", account.id, "image", image.id)
    db.commit()
    return image


# ------------------------------------------------------------------ queries

FILTERS = {
    "in_review": and_(Image.review_status == ImageReviewStatus.IN_REVIEW, Image.approval.is_distinct_from("rejected")),
    "discarded": Image.review_status == ImageReviewStatus.DISCARDED,
    "published": Image.review_status == ImageReviewStatus.PUBLISHED,
    "no_faces": Image.indexing_status == ImageIndexingStatus.NO_FACES,
    "failed": Image.indexing_status == ImageIndexingStatus.FAILED,
    "removal": Image.removal_requested_at.is_not(None),
    "pending_approval": Image.approval == "pending",
    "rejected": Image.approval == "rejected",
    # Under review and neither waiting for the administrator nor rejected: what "Publicar" would publish now.
    "ready": and_(Image.review_status == ImageReviewStatus.IN_REVIEW,
                  Image.approval.is_(None) | (Image.approval == "approved")),
}


def list_images(db: Session, account: Account, event: Event, filter_: str = "all", mine: bool = False) -> list[Image]:
    q = select(Image).where(Image.event_id == event.id)
    scope = visible_images(db, account, event)
    if scope is not None:
        q = q.where(scope)
    if filter_ in FILTERS:
        q = q.where(FILTERS[filter_])
    elif filter_ == "last_batch":
        q = q.where(_last_batch(event))
    if mine:
        q = q.where(Image.uploaded_by == account.id)
    return list(db.scalars(q.order_by(Image.uploaded_at, Image.id)))


def counts(db: Session, event: Event, account: Account) -> dict:
    """Counts of what the account may see (visible_images)."""
    scope = visible_images(db, account, event)
    base = [Image.event_id == event.id] + ([scope] if scope is not None else [])
    out = {key: db.scalar(select(func.count()).select_from(Image).where(*base, cond)) or 0
           for key, cond in FILTERS.items()}
    out["all"] = db.scalar(select(func.count()).select_from(Image).where(*base)) or 0
    out["mine"] = db.scalar(select(func.count()).select_from(Image).where(
        Image.event_id == event.id, Image.uploaded_by == account.id)) or 0
    return out


def media_count(db: Session, event: Event) -> int:
    """At most 1,000 media per event: photos and videos together (RF007), whoever can see them."""
    photos = db.scalar(select(func.count()).select_from(Image).where(
        Image.event_id == event.id, Image.review_status != ImageReviewStatus.DISCARDED)) or 0
    videos = db.scalar(select(func.count()).select_from(Video).where(
        Video.event_id == event.id, Video.review_status != ImageReviewStatus.DISCARDED)) or 0
    return photos + videos


def capacity_left(db: Session, event: Event) -> int:
    return max(0, MAX_PER_EVENT - media_count(db, event))


# ------------------------------------------------------------------ approval of a hired photographer's photos

def _reason(reason: str | None) -> str:
    text = " ".join((reason or "").split())
    if not 5 <= len(text) <= 300:
        raise EventError("Escreva o motivo da recusa (de 5 a 300 caracteres): o fotógrafo contratado vai lê-lo.")
    return text


def _decide(db: Session, admin: Account, image: Image, approve: bool, reason: str | None) -> Image:
    if image.approval != "pending":
        raise EventError("Esta imagem não está aguardando aprovação.")
    if approve:  # the photo itself keeps who reviewed and approved it, and when
        image.approval, image.approved_by, image.approved_at = "approved", admin.id, _now()
        audit.record(db, "image.approved", admin.id, "image", image.id, event_id=str(image.event_id),
                     uploaded_by=str(image.uploaded_by))
        return image
    # 22/10/2026: rejected WITH a reason the sender sees. Never published, never a vector (the database
    # refuses it too); eliminated after REJECTED_KEEP_DAYS by the worker (eliminate_rejected).
    image.approval, image.rejection_reason, image.rejected_by, image.rejected_at = "rejected", _reason(reason), admin.id, _now()
    audit.record(db, "image.rejected", admin.id, "image", image.id, event_id=str(image.event_id),
                 uploaded_by=str(image.uploaded_by), reason=image.rejection_reason)
    return image


def decide_approval(db: Session, storage: ObjectStorage, admin: Account, image: Image, approve: bool,
                    reason: str | None = None) -> Image:
    """The administrator approves the photo (it then follows the normal publication) or rejects
    it with a reason."""
    if admin.role != AccountRole.ADMIN:
        raise PermissionDenied("Somente o administrador aprova as imagens do fotógrafo contratado.")
    kept = _decide(db, admin, image, approve, reason)
    db.commit()
    return kept


def eliminate_rejected(db: Session, storage: ObjectStorage) -> int:
    """Rejected photos leave the storage and the database REJECTED_KEEP_DAYS after the rejection."""
    due = db.scalars(select(Image).where(Image.approval == "rejected",
                                         Image.rejected_at < _now() - timedelta(days=REJECTED_KEEP_DAYS))).all()
    for image in due:
        _delete_objects(storage, image)
        audit.record(db, "image.rejected_eliminated", None, "image", image.id, event_id=str(image.event_id))
        db.delete(image)
    db.commit()
    return len(due)


def decide_approvals(db: Session, storage: ObjectStorage, admin: Account, event: Event,
                     image_ids: list[uuid.UUID], approve: bool, reason: str | None = None) -> int:
    """Batch decision over the selected photos of ONE event (17/10/2026: one by one is not a safety
    requirement — the record of who approved each photo is). Only photos still pending are touched."""
    if admin.role != AccountRole.ADMIN:
        raise PermissionDenied("Somente o administrador aprova as imagens do fotógrafo contratado.")
    images = db.scalars(select(Image).where(Image.event_id == event.id, Image.id.in_(image_ids),
                                            Image.approval == "pending")).all()
    if not images:
        raise EventError("Nenhuma das imagens selecionadas está aguardando aprovação.")
    for image in images:
        _decide(db, admin, image, approve, reason)
    db.commit()
    return len(images)


def _last_batch(event: Event):
    """The images of the last "Publicar": one publication stamps all of them with the same instant."""
    last = select(func.max(Image.published_at)).where(Image.event_id == event.id).scalar_subquery()
    return and_(Image.review_status == ImageReviewStatus.PUBLISHED, Image.published_at == last)


def processing_status(db: Session, event: Event) -> dict:
    """Progress of the indexing of the published images, and of the last
    publication alone: right after "Publicar" the screen shows THOSE photos, not
    the first ones of the event."""
    rows = dict(db.execute(select(Image.indexing_status, func.count()).where(
        Image.event_id == event.id, Image.review_status == ImageReviewStatus.PUBLISHED)
        .group_by(Image.indexing_status)).all())
    total = sum(rows.values())
    pending = rows.get(ImageIndexingStatus.PENDING, 0)
    from app.db.models import FaceEmbedding
    faces = db.scalar(select(func.count()).select_from(FaceEmbedding).where(FaceEmbedding.event_id == event.id)) or 0
    done = total - pending
    return {"total": total, "processed": rows.get(ImageIndexingStatus.PROCESSED, 0), "pending": pending,
            "no_faces": rows.get(ImageIndexingStatus.NO_FACES, 0), "failed": rows.get(ImageIndexingStatus.FAILED, 0),
            "faces": faces, "percent": round(100 * done / total) if total else 100, "event_status": event.status.value,
            "batch": _batch_status(db, event)}


def _batch_status(db: Session, event: Event) -> dict | None:
    rows = dict(db.execute(select(Image.indexing_status, func.count()).where(Image.event_id == event.id, _last_batch(event))
                           .group_by(Image.indexing_status)).all())
    total = sum(rows.values())
    if not total:
        return None
    pending = rows.get(ImageIndexingStatus.PENDING, 0)
    return {"total": total, "pending": pending, "processed": rows.get(ImageIndexingStatus.PROCESSED, 0),
            "no_faces": rows.get(ImageIndexingStatus.NO_FACES, 0), "failed": rows.get(ImageIndexingStatus.FAILED, 0),
            "percent": round(100 * (total - pending) / total)}

