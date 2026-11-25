"""Institutional people and their photos across the collection — independent of HTTP.

The life of a registration:
1. the ADMINISTRATOR registers the person with 1 to 5 reference photos (stored, never processed) and the
   system e-mails a single-use link;
2. the person opens the link, reads the term, sees the photos and SIGNS on the screen (electronic
   signature) — or refuses, and everything is deleted;
3. signed: the photos become reference vectors and the whole published collection is searched; from then
   on every newly indexed photo is compared with the active people (the only comparison across events);
4. the person revokes whenever they want (or the administrator ends it, e.g. the person left the role):
   photos, vectors and marks are eliminated at once; the signed term stays as proof.
"""
from __future__ import annotations

import hashlib
import io
import json
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

import cv2
import numpy as np
from PIL import Image as PILImage
from sqlalchemy import and_, func, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app import audit, email_address, parameters
from app.accounts.service import is_institutional
from app.auth.tokens import new_token, token_hash
from app.config import get_settings
from app.db.models import (Account, Event, FaceEmbedding, Image, ImageIndexingStatus, ImageReviewStatus,
                           InstitutionalMark, InstitutionalPerson, InstitutionalPhoto, InstitutionalStatus,
                           InstitutionalVector)
from app.events import dates
from app.events.service import EventError, NotFound, PermissionDenied
from app.images import formats
from app.images.processing import with_metadata
from app.imaging import decode_image
from app.institutional import term
from app.notifications.port import EmailMessage, EmailSender, notify
from app.storage.port import ObjectStorage

LINK_DAYS = 7              # single use, limited validity
PENDING_DAYS = 30          # never signed: photos and data are eliminated (LGPD Art. 6, III and Art. 15)
MAX_PEOPLE = 50            # initial capacity, can grow
MAX_PHOTOS = 5
MAX_PHOTO_BYTES = 25 * 1024 * 1024
MAX_RAW_PHOTO_BYTES = 100 * 1024 * 1024   # a camera RAW is 3 to 5 times a JPEG
PHOTO_SIDE = 1600          # enough for the face; the rest of the camera file is not kept
MAX_SIGNATURE_BYTES = 300_000
MIN_INK_PIXELS = 150       # an empty (or almost empty) signature box is not a signature


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class PersonInput:
    full_name: str
    position: str
    unit: str | None
    email: str


# ------------------------------------------------------------------ registration (administrator)

def _clean(data: PersonInput) -> PersonInput:
    name = " ".join(data.full_name.split())
    if len(name.split()) < 2 or len(name) > 120:
        raise EventError("Informe o nome completo (nome e sobrenome, até 120 caracteres).")
    position = " ".join(data.position.split())
    if not 2 <= len(position) <= 100:
        raise EventError("Informe o cargo ou a função (até 100 caracteres).")
    unit = " ".join((data.unit or "").split()) or None
    if unit and len(unit) > 100:
        raise EventError("A unidade ou o curso pode ter até 100 caracteres.")
    email = data.email.strip().lower()
    if wrong := email_address.problem(email):
        raise EventError(wrong)
    # Only people in an institutional role — their e-mail is the institution's.
    if not is_institutional(email):
        raise EventError("Use o e-mail institucional da pessoa (@cesmac.edu.br).")
    return PersonInput(name, position, unit, email)


def _reference_jpeg(data: bytes, filename: str) -> bytes:
    """A clean JPEG of the reference photo: reduced, upright, WITHOUT any metadata (no GPS, no camera
    data) — only what is needed to recognise the face (LGPD Art. 6, III)."""
    found = formats.detect(data, filename)
    # Camera RAW too (24/10/2026): only a reduced, clean JPEG of it is kept, like every other format.
    if found is None:
        raise EventError("Envie as fotografias de referência em JPEG, PNG, HEIC, WebP ou RAW de câmera.")
    limit = MAX_RAW_PHOTO_BYTES if found[0] == formats.RAW else MAX_PHOTO_BYTES
    if len(data) > limit:
        raise EventError(f"Cada fotografia de referência pode ter até {limit // (1024 * 1024)} MB"
                         f"{' (RAW)' if found[0] == formats.RAW else ''}.")
    try:
        pixels = decode_image(data) if found[0] == formats.JPEG else formats.decode(data, found[0])
    except (formats.UnreadableImage, Exception):
        raise EventError("Uma das fotografias de referência está corrompida e não pôde ser lida.") from None
    h, w = pixels.shape[:2]
    scale = PHOTO_SIDE / max(h, w)
    if scale < 1:
        pixels = cv2.resize(pixels, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", pixels, [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not ok:
        raise EventError("Uma das fotografias de referência não pôde ser lida.")
    return buf.tobytes()


def create(db: Session, storage: ObjectStorage, admin: Account, data: PersonInput,
           photos: list[tuple[bytes, str]], sender: EmailSender) -> InstitutionalPerson:
    data = _clean(data)
    if not 1 <= len(photos) <= MAX_PHOTOS:
        raise EventError("Envie de 1 a 5 fotografias de referência do rosto, em ângulos variados.")
    open_rows = db.scalar(select(func.count()).select_from(InstitutionalPerson)
                          .where(InstitutionalPerson.status != InstitutionalStatus.REVOKED)) or 0
    if open_rows >= MAX_PEOPLE:
        raise EventError(f"O cadastro chegou ao limite de {MAX_PEOPLE} pessoas.")
    if db.scalar(select(InstitutionalPerson.id).where(func.lower(InstitutionalPerson.email) == data.email,
                                                      InstitutionalPerson.status != InstitutionalStatus.REVOKED)):
        raise EventError("Já existe um cadastro em andamento ou ativo com este e-mail.")
    cleaned = [_reference_jpeg(content, name) for content, name in photos]   # everything checked first
    person = InstitutionalPerson(id=uuid.uuid4(), full_name=data.full_name, position=data.position, unit=data.unit,
                                 email=data.email, created_by=admin.id)
    db.add(person)
    for n, jpeg in enumerate(cleaned, start=1):
        key = f"institutional/{person.id}/referencia-{n}.jpg"
        storage.put(key, jpeg, "image/jpeg")
        db.add(InstitutionalPhoto(id=uuid.uuid4(), person_id=person.id, object_key=key,
                                  sha256=hashlib.sha256(jpeg).hexdigest(), position=n))
    token = _issue_link(person)
    audit.record(db, "institutional.created", admin.id, "institutional_person", person.id, photos=len(cleaned))
    db.commit()
    _send_link(person, token, sender)
    return person


def _issue_link(person: InstitutionalPerson) -> str:
    token = new_token()
    person.link_token_hash, person.link_sent_at = token_hash(token), _now()
    person.link_expires_at = _now() + timedelta(days=LINK_DAYS)   # the previous link stops working
    return token


def link_url(token: str) -> str:
    return f"{get_settings().frontend_url}/autorizacao?token={token}"


def revoke_url(token: str) -> str:
    return f"{get_settings().frontend_url}/autorizacao/revogar?token={token}"


def _send_link(person: InstitutionalPerson, token: str, sender: EmailSender) -> None:
    sender.send(EmailMessage(
        to=person.email, subject="FOTOMAC: autorização de uso de imagem (pessoa institucional)",
        body=(f"Olá, {person.full_name}.\n\nA administração do FOTOMAC, o sistema de fotografias de eventos do "
              "Centro Universitário CESMAC, cadastrou você como pessoa institucional. Com a sua autorização, o "
              "sistema localiza as fotos dos eventos em que você aparece, para a comunicação institucional.\n\n"
              f"Leia o termo e, se concordar, assine no link abaixo (válido por {LINK_DAYS} dias e de uso único). "
              f"Você também pode recusar; nesse caso, os seus dados são apagados.\n\n{link_url(token)}\n\n"
              "Se você não esperava esta mensagem, ignore-a.\n\nEquipe FOTOMAC\nCentro Universitário CESMAC")))


def resend_link(db: Session, admin: Account, person: InstitutionalPerson, sender: EmailSender) -> None:
    if person.status != InstitutionalStatus.AWAITING:
        raise EventError("Só cadastros aguardando autorização recebem o link.")
    token = _issue_link(person)
    audit.record(db, "institutional.link_resent", admin.id, "institutional_person", person.id)
    db.commit()
    _send_link(person, token, sender)


# TEMPORÁRIO — REMOVER ANTES DA IMPLANTAÇÃO (mesmo motivo de accounts.service.dev_activation_link): while
# e-mails are not really sent (email_sender == "outbox"), the administrator can see the link to test the
# flow. In production it would let an administrator sign in someone else's name, so it answers "not found".
def dev_link(db: Session, admin: Account, person: InstitutionalPerson) -> str:
    if get_settings().email_sender != "outbox":
        raise NotFound("Recurso indisponível.")
    if person.status != InstitutionalStatus.AWAITING:
        raise EventError("Só cadastros aguardando autorização têm link.")
    token = _issue_link(person)
    audit.record(db, "institutional.link_shown_dev", admin.id, "institutional_person", person.id)
    db.commit()
    return link_url(token)
# FIM DO TRECHO TEMPORÁRIO


def delete_awaiting(db: Session, storage: ObjectStorage, admin: Account, person: InstitutionalPerson) -> None:
    """A registration never signed can be withdrawn: nothing was processed, nothing needs to be kept."""
    if person.status != InstitutionalStatus.AWAITING:
        raise EventError("Cadastro já assinado: encerre a autorização em vez de excluir (o termo fica como prova).")
    _delete_photos(db, storage, person)
    audit.record(db, "institutional.deleted", admin.id, "institutional_person", person.id)
    db.delete(person)
    db.commit()


def expire_pending(db: Session, storage: ObjectStorage) -> int:
    """Registrations nobody signed in PENDING_DAYS since the last link: eliminated (LGPD Art. 15, I)."""
    due = db.scalars(select(InstitutionalPerson).where(
        InstitutionalPerson.status == InstitutionalStatus.AWAITING,
        InstitutionalPerson.link_sent_at < _now() - timedelta(days=PENDING_DAYS))).all()
    for person in due:
        _delete_photos(db, storage, person)
        audit.record(db, "institutional.expired", None, "institutional_person", person.id)
        db.delete(person)
    db.commit()
    return len(due)


def _delete_photos(db: Session, storage: ObjectStorage, person: InstitutionalPerson) -> None:
    for photo in list(person.photos):   # storage first: the database cascade does not reach it
        storage.delete(photo.object_key)
        db.delete(photo)                # its vectors go with it (ON DELETE CASCADE)
    db.flush()


# ------------------------------------------------------------------ the person: sign, refuse, revoke (public)

def by_link(db: Session, token: str | None) -> InstitutionalPerson:
    person = db.scalar(select(InstitutionalPerson).where(InstitutionalPerson.link_token_hash == token_hash(token or "")))
    if (person is None or person.status != InstitutionalStatus.AWAITING or not person.link_expires_at
            or person.link_expires_at < _now()):
        raise NotFound("Link inválido ou expirado. Peça à administração do FOTOMAC um novo link.")
    return person


# The handwriting fonts the signing page offers (frontend/src/components/signature/fonts.ts).
SIGNATURE_FONTS = {"GreatVibes_400Regular", "DancingScript_500Medium", "Allura_400Regular", "HomemadeApple_400Regular",
                   "Caveat_500Medium"}


@dataclass
class SignatureHow:
    """How the person signed (24/10/2026): the name typed in a handwriting font, drawn, or a rubrica (initials,
    typed or drawn). All are valid; which one, with the text and the font, is part of the proof."""
    kind: str = "drawn"
    text: str | None = None
    font: str | None = None


def signature_how(kind: str, text: str | None, font: str | None) -> SignatureHow:
    text = " ".join((text or "").split()) or None
    if kind not in ("typed", "drawn", "initials"):
        raise EventError("Assinatura inválida. Assine de novo.")
    if text is None:                      # drawn (the signature or the rubrica): nothing typed to record
        if kind == "typed":
            raise EventError("Digite o nome da assinatura.")
        return SignatureHow(kind, None, None)
    if font not in SIGNATURE_FONTS or len(text) > (80 if kind == "typed" else 6):
        raise EventError("Assinatura inválida. Assine de novo.")
    return SignatureHow(kind, text, font)


def _check_signature(png: bytes) -> None:
    if not png.startswith(b"\x89PNG\r\n\x1a\n") or len(png) > MAX_SIGNATURE_BYTES:
        raise EventError("Assinatura inválida. Assine de novo no quadro.")
    try:
        image = PILImage.open(io.BytesIO(png))
        image.load()
    except Exception:
        raise EventError("Assinatura inválida. Assine de novo no quadro.") from None
    if image.width > 2400 or image.height > 1200:
        raise EventError("Assinatura inválida. Assine de novo no quadro.")
    rgba = np.asarray(image.convert("RGBA"))
    ink = (rgba[:, :, 3] > 40) & (rgba[:, :, :3].min(axis=2) < 160)   # visible, dark strokes
    if int(ink.sum()) < MIN_INK_PIXELS:
        raise EventError("Faça a sua assinatura no quadro antes de confirmar.")


def signed_identity(person: InstitutionalPerson) -> dict:
    """Name, position, unit and e-mail as they were when the person signed (the current ones before signing)."""
    return person.signed_identity or {"full_name": person.full_name, "position": person.position,
                                      "unit": person.unit, "email": person.email}


def document_hash(person: InstitutionalPerson, signature_sha: str) -> str:
    """Verification code of the signed document: changes if any word, photo or stroke changes."""
    signed = signed_identity(person)
    record = {"term_version": person.term_version, "term": person.signed_term,
              "full_name": signed["full_name"], "position": signed["position"], "unit": signed["unit"],
              "email": signed["email"],
              "photos": person.signed_photos, "signature": signature_sha,
              # Always in UTC: the database may give the moment back in another time zone, and the code must
              # come out the same whenever it is recomputed (that is what makes it a proof).
              "authorized_at": person.authorized_at.astimezone(timezone.utc).isoformat(timespec="microseconds"),
              "ip": person.authorized_ip}
    if person.signature_kind:   # signatures since 25/10/2026 also record how they were made
        record["signature_kind"] = {"kind": person.signature_kind, "text": person.signature_text, "font": person.signature_font}
    return hashlib.sha256(json.dumps(record, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def authorize(db: Session, storage: ObjectStorage, sender: EmailSender, token: str | None, signature_png: bytes,
              ip: str | None, user_agent: str | None, how: SignatureHow | None = None) -> str:
    """The electronic signature. The revocation link goes only to the e-mail (24/10/2026: no longer on the screen)."""
    person = by_link(db, token)
    _check_signature(signature_png)
    key = f"institutional/{person.id}/assinatura.png"
    storage.put(key, signature_png, "image/png")
    person.term_version, person.authorized_at = term.TERM_VERSION, _now()
    person.signed_term = [term.TERM_TITLE, *term.paragraphs(person.full_name, person.position, person.unit)]
    person.signed_photos = [p.sha256 for p in person.photos]
    person.signed_identity = {"full_name": person.full_name, "position": person.position, "unit": person.unit,
                              "email": person.email}
    person.authorized_ip, person.authorized_user_agent = (ip or "")[:45] or None, (user_agent or "")[:300] or None
    person.signature_key = key
    how = how or SignatureHow()
    person.signature_kind, person.signature_text, person.signature_font = how.kind, how.text, how.font
    person.document_sha256 = document_hash(person, hashlib.sha256(signature_png).hexdigest())
    person.link_token_hash = person.link_expires_at = None          # single use
    revoke_token = new_token()
    person.revoke_token_hash = token_hash(revoke_token)
    person.status, person.scan_status = InstitutionalStatus.ACTIVE, "pending"   # the worker searches the collection
    audit.record(db, "institutional.authorized", None, "institutional_person", person.id,
                 term_version=term.TERM_VERSION, document_sha256=person.document_sha256)
    db.commit()
    notify(sender, EmailMessage(
        to=person.email, subject="FOTOMAC: autorização registrada",
        body=(f"Olá, {person.full_name}.\n\nA sua autorização foi registrada em "
              f"{person.authorized_at.astimezone().strftime('%d/%m/%Y às %H:%M')} (termo {term.TERM_VERSION}, código de "
              f"verificação {person.document_sha256[:16]}).\n\nVocê pode revogá-la a qualquer momento, sem "
              f"justificativa, neste link:\n\n{revoke_url(revoke_token)}\n\n"
              "Guarde esta mensagem.\n\nEquipe FOTOMAC\nCentro Universitário CESMAC")))
    return revoke_url(revoke_token)


def refuse(db: Session, storage: ObjectStorage, token: str | None) -> None:
    """The person does not authorize: the registration and the photos are deleted (free consent, Art. 5, XII)."""
    person = by_link(db, token)
    _delete_photos(db, storage, person)
    audit.record(db, "institutional.refused", None, "institutional_person", person.id)
    db.delete(person)
    db.commit()


def by_revoke_link(db: Session, token: str | None) -> InstitutionalPerson:
    """The person's own link (from the confirmation e-mail) or the one the administrator sent at their request."""
    digest = token_hash(token or "")
    person = db.scalar(select(InstitutionalPerson).where(or_(InstitutionalPerson.revoke_token_hash == digest,
                                                             InstitutionalPerson.revoke_request_hash == digest)))
    if person is None:
        raise NotFound("Link de revogação inválido.")
    return person


def _revoke(db: Session, storage: ObjectStorage, person: InstitutionalPerson, by: str, actor: uuid.UUID | None,
            via: str | None = None) -> None:
    """At once and irreversibly — reference photos, vectors and every mark."""
    if person.status != InstitutionalStatus.ACTIVE:
        raise EventError("Esta autorização não está ativa.")
    _delete_photos(db, storage, person)
    db.query(InstitutionalVector).filter(InstitutionalVector.person_id == person.id).delete()
    db.query(InstitutionalMark).filter(InstitutionalMark.person_id == person.id).delete()
    person.status, person.revoked_at, person.revoked_by = InstitutionalStatus.REVOKED, _now(), by
    person.scan_status, person.references_model_version = "idle", None
    audit.record(db, "institutional.revoked", actor, "institutional_person", person.id, by=by,
                 **({"via": via} if via else {}))
    db.commit()


def revoke_by_holder(db: Session, storage: ObjectStorage, token: str | None, signature_png: bytes,
                     ip: str | None = None, how: SignatureHow | None = None) -> InstitutionalPerson:
    """Signed like the authorization (24/10/2026): the drawn signature is kept as proof that the person asked."""
    person = by_revoke_link(db, token)
    if person.status != InstitutionalStatus.ACTIVE:
        raise EventError("Esta autorização não está ativa.")
    _check_signature(signature_png)
    key = f"institutional/{person.id}/revogacao.png"
    storage.put(key, signature_png, "image/png")
    person.revocation_signature_key, person.revocation_ip = key, (ip or "")[:45] or None
    person.revocation_signature_kind = (how or SignatureHow()).kind
    via_request = person.revoke_request_hash == token_hash(token or "")
    person.revoke_request_hash = None
    _revoke(db, storage, person, "holder", None, via="administração" if via_request else "link próprio")
    return person


def send_revocation_request(db: Session, admin: Account, person: InstitutionalPerson, sender: EmailSender) -> None:
    """The person asked the administration to revoke: the revocation term goes to their e-mail, to be signed
    there. Their own link from the confirmation e-mail keeps working (LGPD Art. 8, § 5: a facilitated way)."""
    if person.status != InstitutionalStatus.ACTIVE:
        raise EventError("Esta autorização não está ativa.")
    token = new_token()
    person.revoke_request_hash, person.revoke_requested_at = token_hash(token), _now()
    audit.record(db, "institutional.revocation_requested", admin.id, "institutional_person", person.id)
    db.commit()
    sender.send(EmailMessage(
        to=person.email, subject="FOTOMAC: termo de revogação da sua autorização",
        body=(f"Olá, {person.full_name}.\n\nA administração do FOTOMAC recebeu o seu pedido para revogar a autorização "
              "de uso de imagem e de reconhecimento facial. Para concluir, leia e assine o termo de revogação neste "
              f"link:\n\n{revoke_url(token)}\n\nAo assinar, as suas fotos de referência, os seus dados faciais e as "
              "marcações nas fotos dos eventos são apagados na hora. O que já foi publicado antes não é desfeito.\n\n"
              "Se você não pediu isso, ignore esta mensagem: nada muda.\n\nEquipe FOTOMAC\nCentro Universitário CESMAC")))


def end_by_admin(db: Session, storage: ObjectStorage, admin: Account, person: InstitutionalPerson) -> None:
    """The yearly review, or the person left the role."""
    _revoke(db, storage, person, "admin", admin.id)


# ------------------------------------------------------------------ corrections (administrator) — LGPD Art. 18, III

def update_person(db: Session, admin: Account, person: InstitutionalPerson, full_name: str, position: str,
                  unit: str | None) -> InstitutionalPerson:
    """Name (a social name, a typo), position (a promotion) and unit. Never the signed proof: that is kept in
    signed_identity. Each changed field gets its date, shown as "alterado"."""
    if person.status == InstitutionalStatus.REVOKED:
        raise EventError("Autorização revogada: os dados não são mais alterados.")
    data = _clean(PersonInput(full_name, position, unit, person.email))
    changes = {}
    for field, stamp in (("full_name", "name_changed_at"), ("position", "position_changed_at"), ("unit", "unit_changed_at")):
        old, new = getattr(person, field), getattr(data, field)
        if old != new:
            changes[field] = {"de": old, "para": new}
            setattr(person, field, new)
            setattr(person, stamp, _now())
    if changes:
        audit.record(db, "institutional.updated", admin.id, "institutional_person", person.id, changes=changes)
        db.commit()
    return person


EMAIL_CHANGE_DAYS = 7


def email_change_url(token: str) -> str:
    return f"{get_settings().frontend_url}/autorizacao/email?token={token}"


def request_email_change(db: Session, admin: Account, person: InstitutionalPerson, new_email: str,
                         sender: EmailSender) -> InstitutionalPerson:
    """A new institutional e-mail. Not signed yet: it simply replaces the old one and the signing link goes to
    the new address. Signed: it only replaces the old one after the person confirms it, signing at a link sent
    to the NEW address — the e-mail is where the revocation and every notice go."""
    if person.status == InstitutionalStatus.REVOKED:
        raise EventError("Autorização revogada: os dados não são mais alterados.")
    email = _clean(PersonInput(person.full_name, person.position, person.unit, new_email)).email
    if email == person.email.lower():
        raise EventError("Este já é o e-mail da pessoa.")
    taken = db.scalar(select(InstitutionalPerson.id).where(
        or_(func.lower(InstitutionalPerson.email) == email, func.lower(InstitutionalPerson.pending_email) == email),
        InstitutionalPerson.status != InstitutionalStatus.REVOKED, InstitutionalPerson.id != person.id))
    if taken:
        raise EventError("Já existe um cadastro em andamento ou ativo com este e-mail.")
    if person.status == InstitutionalStatus.AWAITING:
        audit.record(db, "institutional.email_changed", admin.id, "institutional_person", person.id, before_signing=True)
        person.email, person.email_changed_at = email, _now()
        token = _issue_link(person)   # the previous link, sent to the old address, stops working
        db.commit()
        _send_link(person, token, sender)
        return person
    token = new_token()
    person.pending_email, person.email_change_hash = email, token_hash(token)
    person.email_change_expires_at = _now() + timedelta(days=EMAIL_CHANGE_DAYS)
    audit.record(db, "institutional.email_change_requested", admin.id, "institutional_person", person.id)
    db.commit()
    sender.send(EmailMessage(
        to=email, subject="FOTOMAC: confirme o seu novo e-mail",
        body=(f"Olá, {person.full_name}.\n\nA administração do FOTOMAC vai trocar o e-mail da sua autorização de uso de "
              f"imagem para este endereço. Para confirmar, assine no link abaixo (válido por {EMAIL_CHANGE_DAYS} dias "
              f"e de uso único):\n\n{email_change_url(token)}\n\nA sua autorização continua valendo nos mesmos termos. "
              "Se você não pediu essa troca, ignore esta mensagem: nada muda.\n\nEquipe FOTOMAC\nCentro Universitário CESMAC")))
    notify(sender, EmailMessage(
        to=person.email, subject="FOTOMAC: pedido de troca do seu e-mail",
        body=(f"Olá, {person.full_name}.\n\nFoi pedida a troca do e-mail da sua autorização no FOTOMAC para {email}. "
              "A troca só acontece se for confirmada no novo endereço. Se você não reconhece este pedido, procure a "
              "administração do FOTOMAC.\n\nEquipe FOTOMAC\nCentro Universitário CESMAC")))
    return person


def by_email_change_link(db: Session, token: str | None) -> InstitutionalPerson:
    person = db.scalar(select(InstitutionalPerson).where(InstitutionalPerson.email_change_hash == token_hash(token or "")))
    if (person is None or person.status != InstitutionalStatus.ACTIVE or not person.pending_email
            or not person.email_change_expires_at or person.email_change_expires_at < _now()):
        raise NotFound("Link inválido ou expirado. Peça à administração do FOTOMAC um novo link.")
    return person


def confirm_email_change(db: Session, storage: ObjectStorage, sender: EmailSender, token: str | None,
                         signature_png: bytes, ip: str | None, how: SignatureHow | None = None) -> InstitutionalPerson:
    person = by_email_change_link(db, token)
    _check_signature(signature_png)
    key = f"institutional/{person.id}/troca-de-email.png"
    storage.put(key, signature_png, "image/png")
    old = person.email
    person.email, person.email_changed_at, person.email_change_signature_key = person.pending_email, _now(), key
    person.pending_email = person.email_change_hash = person.email_change_expires_at = None
    audit.record(db, "institutional.email_changed", None, "institutional_person", person.id, ip=(ip or "")[:45] or None,
                 signature_kind=(how or SignatureHow()).kind)
    db.commit()
    for to in (person.email, old):
        notify(sender, EmailMessage(
            to=to, subject="FOTOMAC: e-mail da autorização trocado",
            body=(f"Olá, {person.full_name}.\n\nO e-mail da sua autorização no FOTOMAC agora é {person.email}. A "
                  "autorização continua valendo nos mesmos termos, e o link de revogação que você recebeu continua "
                  "funcionando.\n\nEquipe FOTOMAC\nCentro Universitário CESMAC")))
    return person


# ------------------------------------------------------------------ finding the person

def schedule_rescan_all(db: Session) -> None:
    db.query(InstitutionalPerson).filter(InstitutionalPerson.status == InstitutionalStatus.ACTIVE).update(
        {InstitutionalPerson.scan_status: "pending"})


def schedule_rescan(db: Session, admin: Account, person: InstitutionalPerson) -> None:
    if person.status != InstitutionalStatus.ACTIVE:
        raise EventError("Só pessoas com autorização ativa são procuradas no acervo.")
    person.scan_status = "pending"
    audit.record(db, "institutional.rescan", admin.id, "institutional_person", person.id)
    db.commit()


def refresh_next(db: Session, storage: ObjectStorage, engine) -> bool:
    """One person per round: (re)builds the reference vectors when the model changed, then searches the
    whole published collection. Returns False when nobody is waiting."""
    person = db.scalar(select(InstitutionalPerson).where(
        InstitutionalPerson.status == InstitutionalStatus.ACTIVE,
        (InstitutionalPerson.scan_status == "pending")
        | InstitutionalPerson.references_model_version.is_distinct_from(engine.model_version))
        .order_by(InstitutionalPerson.authorized_at).limit(1).with_for_update(skip_locked=True))
    if person is None:
        return False
    if person.references_model_version != engine.model_version:
        db.query(InstitutionalVector).filter(InstitutionalVector.person_id == person.id).delete()
        floor = parameters.get(db, "min_detection_score")
        for photo in person.photos:
            faces = [f for f in engine.detect(decode_image(storage.get(photo.object_key))) if f.detection_score >= floor]
            photo.faces_found = len(faces)
            if faces:   # the reference photo shows the person: its largest face is theirs
                face = max(faces, key=lambda f: f.bbox.width * f.bbox.height)
                db.add(InstitutionalVector(person_id=person.id, photo_id=photo.id, model_version=engine.model_version,
                                           dim=engine.vector_dim, embedding=face.embedding))
        person.references_model_version = engine.model_version
        db.flush()
    _scan(db, person, engine.model_version)
    person.scan_status, person.scanned_at = "done", _now()
    db.commit()
    return True


def _visible_images():
    """Published, indexed, not on their way out."""
    return and_(Image.review_status == ImageReviewStatus.PUBLISHED, Image.indexing_status == ImageIndexingStatus.PROCESSED,
                Image.removal_requested_at.is_(None))


def _scan(db: Session, person: InstitutionalPerson, model_version: str) -> None:
    """The whole published collection, with NO cap of results: the visitor's limit of 200 is about what one
    public search exposes and does not apply here (decision of 17/10/2026)."""
    threshold = parameters.institutional_threshold(db)
    vectors = db.scalars(select(InstitutionalVector.embedding).where(
        InstitutionalVector.person_id == person.id, InstitutionalVector.model_version == model_version)).all()
    found: dict[uuid.UUID, tuple[uuid.UUID, float]] = {}
    for vector in vectors:
        best = func.max(1 - FaceEmbedding.embedding.cosine_distance(vector)).label("similarity")
        rows = db.execute(select(FaceEmbedding.image_id, FaceEmbedding.event_id, best)
                          .join(Image, Image.id == FaceEmbedding.image_id)
                          .where(FaceEmbedding.model_version == model_version, _visible_images())
                          .group_by(FaceEmbedding.image_id, FaceEmbedding.event_id)
                          .having(best >= threshold)).all()
        for r in rows:
            if r.image_id not in found or r.similarity > found[r.image_id][1]:
                found[r.image_id] = (r.event_id, float(r.similarity))
    marks = {m.image_id: m for m in db.scalars(select(InstitutionalMark).where(InstitutionalMark.person_id == person.id))}
    for image_id, mark in marks.items():   # a pending mark the new search no longer supports goes away
        if mark.status == "pending" and image_id not in found:
            db.delete(mark)
        elif image_id in found:
            mark.similarity = found[image_id][1]
    for image_id, (event_id, similarity) in found.items():
        if image_id not in marks:   # a decision already taken (confirmed or rejected) is never undone
            db.add(InstitutionalMark(person_id=person.id, image_id=image_id, event_id=event_id, similarity=similarity))
    audit.record(db, "institutional.scanned", None, "institutional_person", person.id, found=len(found))


def mark_image(db: Session, image: Image, model_version: str) -> None:
    """Called right after an image is (re)indexed: it is compared with every active person."""
    threshold = parameters.institutional_threshold(db)
    similarity = func.max(1 - InstitutionalVector.embedding.cosine_distance(FaceEmbedding.embedding)).label("similarity")
    rows = db.execute(
        select(InstitutionalVector.person_id, similarity)
        .join(FaceEmbedding, and_(FaceEmbedding.image_id == image.id, FaceEmbedding.model_version == InstitutionalVector.model_version))
        .join(InstitutionalPerson, InstitutionalPerson.id == InstitutionalVector.person_id)
        .where(InstitutionalVector.model_version == model_version, InstitutionalPerson.status == InstitutionalStatus.ACTIVE)
        .group_by(InstitutionalVector.person_id).having(similarity >= threshold)).all()
    for person_id, value in rows:
        db.execute(insert(InstitutionalMark).values(person_id=person_id, image_id=image.id, event_id=image.event_id,
                                                    similarity=float(value)).on_conflict_do_nothing())


# ------------------------------------------------------------------ consultation

def get_person(db: Session, person_id: uuid.UUID) -> InstitutionalPerson:
    person = db.get(InstitutionalPerson, person_id)
    if person is None:
        raise NotFound("Pessoa não encontrada.")
    return person


def active_person(db: Session, person_id: uuid.UUID) -> InstitutionalPerson:
    """Only people already registered and active can be consulted."""
    person = get_person(db, person_id)
    if person.status != InstitutionalStatus.ACTIVE:
        raise NotFound("Pessoa não encontrada.")
    return person


def active_people(db: Session) -> list[InstitutionalPerson]:
    return db.scalars(select(InstitutionalPerson).where(InstitutionalPerson.status == InstitutionalStatus.ACTIVE)
                      .order_by(InstitutionalPerson.full_name)).all()


def _shown_marks(person_id: uuid.UUID):
    return and_(InstitutionalMark.person_id == person_id, InstitutionalMark.status != "rejected",
                InstitutionalMark.image_id == Image.id, _visible_images())


def person_events(db: Session, account: Account, person: InstitutionalPerson, date_from: date | None,
                  date_to: date | None) -> list[dict]:
    """The events with the person, most recent first, with "N de M imagens".
    The consultation is recorded BEFORE anything is returned."""
    audit.record(db, "institutional.query", account.id, "institutional_person", person.id,
                 date_from=str(date_from) if date_from else None, date_to=str(date_to) if date_to else None)
    db.commit()
    q = (select(Event, func.count(InstitutionalMark.image_id).label("marked"))
         .join(InstitutionalMark, InstitutionalMark.event_id == Event.id).join(Image, Image.id == InstitutionalMark.image_id)
         .where(_shown_marks(person.id), Event.deletion_due_at.is_(None)).group_by(Event.id)
         .order_by(Event.date_start.desc()))
    if date_from:
        q = q.where(Event.date_end >= date_from)
    if date_to:
        q = q.where(Event.date_start <= date_to)
    rows = db.execute(q).all()
    totals = dict(db.execute(select(Image.event_id, func.count()).where(
        Image.event_id.in_([e.id for e, _ in rows]), Image.review_status == ImageReviewStatus.PUBLISHED,
        Image.removal_requested_at.is_(None)).group_by(Image.event_id)).all()) if rows else {}
    return [{"id": e.id, "name": e.name, "date_label": dates.label(e.date_precision, e.date_start, e.date_end),
             "location": e.location, "marked": marked, "total": totals.get(e.id, marked),
             # The cover beside the name tells the events apart at a glance (28/10/2026); the version busts the cache.
             "cover_version": e.updated_at.strftime("%Y%m%d%H%M%S") if e.cover_object_key else None}
            for e, marked in rows]


def person_profile(db: Session, account: Account, person: InstitutionalPerson, date_from: date | None,
                   date_to: date | None) -> list[tuple[dict, list[tuple[InstitutionalMark, Image]]]]:
    """The person's page (24/10/2026): every event with the person and, in each, the person's photos —
    one screen to find the person, check the photos and download them. Only events where the person
    appears; the consultation is recorded first, by person_events."""
    events = person_events(db, account, person, date_from, date_to)
    if not events:
        return []
    by_event: dict[uuid.UUID, list[tuple[InstitutionalMark, Image]]] = {e["id"]: [] for e in events}
    for mark, image in db.execute(select(InstitutionalMark, Image).join(Image, Image.id == InstitutionalMark.image_id)
                                  .where(_shown_marks(person.id), InstitutionalMark.event_id.in_(list(by_event)))
                                  .order_by(InstitutionalMark.similarity.desc())):
        by_event[mark.event_id].append((mark, image))
    return [(e, by_event[e["id"]]) for e in events]


def named_download(db: Session, storage: ObjectStorage, account: Account, person: InstitutionalPerson,
                   image_id: uuid.UUID) -> tuple[bytes, str]:
    """The photo for the press, named after the person: "Julia Silva - Colação de grau.jpg", with name and
    role in the caption and the keywords of the file. Only a CONFIRMED mark (a person of the team checked it) and only if the term the person signed
    allows the press use (term v2 or later). Every download is recorded, with who, which person, which photo."""
    mark, image = db.execute(select(InstitutionalMark, Image).join(Image, Image.id == InstitutionalMark.image_id)
                             .where(_shown_marks(person.id), Image.id == image_id)).first() or (None, None)
    if image is None:
        raise NotFound("Imagem não encontrada.")
    if mark.status != "confirmed":
        raise EventError(f"Confirme que é {person.full_name} nesta foto antes de baixá-la.")
    if not term.allows_press(person.term_version):
        raise PermissionDenied(f"{person.full_name} assinou um termo que não prevê o envio à imprensa com o nome. "
                               "Para isso, é preciso assinar a versão atual do termo.")
    event = image.event
    when = dates.label(event.date_precision, event.date_start, event.date_end)
    caption = (f"{person.full_name}, {person.position}{f' ({person.unit})' if person.unit else ''}. "
               f"{event.name}, {when}, {event.location}")
    data = with_metadata(storage.get(image.object_key), image.credit_signature, caption, (person.full_name, event.name))
    audit.record(db, "institutional.download", account.id, "institutional_person", person.id,
                 image_id=str(image.id), event_id=str(event.id))
    db.commit()
    return data, f"{person.full_name} - {event.name}.jpg"


def marked_image(db: Session, person: InstitutionalPerson, image_id: uuid.UUID) -> Image:
    image = db.scalar(select(Image).join(InstitutionalMark, InstitutionalMark.image_id == Image.id)
                      .where(_shown_marks(person.id), Image.id == image_id))
    if image is None:
        raise NotFound("Imagem não encontrada.")
    return image


def decide(db: Session, account: Account, person: InstitutionalPerson, image_ids: list[uuid.UUID], confirm: bool) -> int:
    """A person of the team confirms or rejects; a rejected mark leaves the list for good."""
    marks = db.scalars(select(InstitutionalMark).join(Image, Image.id == InstitutionalMark.image_id)
                       .where(_shown_marks(person.id), InstitutionalMark.image_id.in_(image_ids))).all()
    if not marks:
        raise EventError("Selecione ao menos uma imagem.")
    for mark in marks:
        mark.status, mark.decided_by, mark.decided_at = ("confirmed" if confirm else "rejected"), account.id, _now()
    audit.record(db, "institutional.marks_confirmed" if confirm else "institutional.marks_rejected", account.id,
                 "institutional_person", person.id, images=len(marks))
    db.commit()
    return len(marks)


def counts(db: Session, person_id: uuid.UUID) -> dict:
    rows = dict(db.execute(select(InstitutionalMark.status, func.count()).join(Image, Image.id == InstitutionalMark.image_id)
                           .where(InstitutionalMark.person_id == person_id, _visible_images())
                           .group_by(InstitutionalMark.status)).all())
    return {"pending": rows.get("pending", 0), "confirmed": rows.get("confirmed", 0), "rejected": rows.get("rejected", 0)}


def names_on_image(db: Session, image_id: uuid.UUID) -> list[str]:
    """"Pessoa institucional localizada" on the image, in the panel."""
    return list(db.scalars(select(InstitutionalPerson.full_name).join(
        InstitutionalMark, InstitutionalMark.person_id == InstitutionalPerson.id).where(
        InstitutionalMark.image_id == image_id, InstitutionalMark.status != "rejected",
        InstitutionalPerson.status == InstitutionalStatus.ACTIVE).order_by(InstitutionalPerson.full_name)))

