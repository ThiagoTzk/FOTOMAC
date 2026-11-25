"""Optional profile photo of a staff account (28/10/2026), shown instead of the initials.

Personal data, kept to the minimum: the file is decoded and saved again as a small square JPEG — no metadata, no
GPS, no camera serial — and it never enters the face index. The person removes it whenever they want; it also
goes when a temporary account ends.
"""
from __future__ import annotations

from datetime import datetime, timezone

import cv2
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import audit
from app.db.models import Account, AccountStatus
from app.images import formats
from app.storage.port import ObjectStorage

MAX_BYTES = 15 * 1024 * 1024
SIDE = 320   # pixels: the largest place it appears is the 96 px circle of "Meu perfil", at high density


class PhotoError(Exception):
    pass


def _key(account: Account) -> str:
    return f"accounts/{account.id}/photo.jpg"


def save(db: Session, storage: ObjectStorage, account: Account, data: bytes) -> Account:
    if len(data) > MAX_BYTES:
        raise PhotoError("A foto ultrapassa 15 MB. Escolha uma imagem menor.")
    found = formats.detect(data)
    if not found or found[0] == formats.RAW:
        raise PhotoError("Formato não aceito. Envie uma foto em JPEG, PNG, WebP ou HEIC.")
    try:
        image = formats.decode(data, found[0])
    except Exception:
        raise PhotoError("Não foi possível ler esta imagem. Tente outra foto.") from None
    h, w = image.shape[:2]
    side = min(h, w)   # the centre of the photo, square: it is shown in a circle
    top, left = (h - side) // 2, (w - side) // 2
    square = cv2.resize(image[top:top + side, left:left + side], (SIDE, SIDE), interpolation=cv2.INTER_AREA)
    storage.put(_key(account), cv2.imencode(".jpg", square, [cv2.IMWRITE_JPEG_QUALITY, 88])[1].tobytes(), "image/jpeg")
    account.photo_key = _key(account)
    account.photo_updated_at = datetime.now(timezone.utc)
    audit.record(db, "account.photo_set", account.id, "account", account.id)
    db.commit()
    return account


def remove(db: Session, storage: ObjectStorage, account: Account, actor: Account | None = None) -> Account:
    if account.photo_key:
        storage.delete(account.photo_key)
        account.photo_key = account.photo_updated_at = None
        audit.record(db, "account.photo_removed", actor.id if actor else None, "account", account.id)
        db.commit()
    return account


def remove_from_ended_accounts(db: Session, storage: ObjectStorage) -> int:
    """A temporary account that ended has no use for its photo (a renewal starts without it)."""
    ended = db.scalars(select(Account).where(Account.status == AccountStatus.EXPIRED, Account.photo_key.is_not(None))).all()
    for account in ended:
        remove(db, storage, account)
    return len(ended)
