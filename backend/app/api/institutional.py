"""Institutional people: the administrator's registration, the public page where the person
signs (or refuses, or revokes), and the consultation by photographers, marketing and the administrator."""
from __future__ import annotations

import base64
import binascii
import logging
import uuid
from datetime import date, datetime
from urllib.parse import quote

import cv2
import numpy as np
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import audit
from app.api.deps import session_token, require_role
from app.auth.tokens import token_hash
from app.config import get_settings
from app.db.models import Account, AccountRole, Image, InstitutionalPerson, InstitutionalStatus
from app.db.session import get_session
from app.events.service import EventError, NotFound, PermissionDenied, get_visible
from app.images.processing import credit_line
from app.institutional import form, service, term
from app.institutional.service import MAX_RAW_PHOTO_BYTES
from app.notifications.factory import get_email_sender
from app.notifications.port import EmailDeliveryError, EmailSender
from app.security import signed_links
from app.security.rate_limit import RateLimiter
from app.storage.factory import get_storage
from app.storage.port import ObjectStorage

admin_only = require_role(AccountRole.ADMIN)
# Never public, and not for the temporary account.
consulting = require_role(AccountRole.PHOTOGRAPHER, AccountRole.MARKETING, AccountRole.ADMIN)
link_limiter = RateLimiter(max_requests=30, window_seconds=600)   # the public page: guessing tokens is pointless, but cheap to limit

admin_router = APIRouter(prefix="/admin/institutional", tags=["admin: pessoas institucionais"])
public_router = APIRouter(prefix="/public/institutional", tags=["público: autorização institucional"])
router = APIRouter(prefix="/institutional", tags=["pessoas institucionais"])


def _http(exc: EventError) -> HTTPException:
    code = (status.HTTP_404_NOT_FOUND if isinstance(exc, NotFound)
            else status.HTTP_403_FORBIDDEN if isinstance(exc, PermissionDenied) else status.HTTP_400_BAD_REQUEST)
    return HTTPException(code, str(exc))


def _jpeg(data: bytes) -> Response:
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


STATUS_LABEL = {InstitutionalStatus.AWAITING: "Aguardando autorização", InstitutionalStatus.ACTIVE: "Ativo",
                InstitutionalStatus.REVOKED: "Revogado"}


# ------------------------------------------------------------------ administrator

class PersonRow(BaseModel):
    id: uuid.UUID
    full_name: str
    position: str
    unit: str | None
    email: str
    status: str
    status_label: str
    created_at: datetime
    link_expires_at: datetime | None
    authorized_at: datetime | None
    revoked_at: datetime | None
    marks: dict
    # When each field was corrected after the registration ("alterado", with the date on hover).
    name_changed_at: datetime | None = None
    position_changed_at: datetime | None = None
    unit_changed_at: datetime | None = None
    email_changed_at: datetime | None = None


class PersonDetail(PersonRow):
    photos: list[dict]
    term_version: str | None
    document_sha256: str | None
    authorized_ip: str | None
    revoked_by: str | None
    scan_status: str
    scanned_at: datetime | None
    signed: bool
    pending_email: str | None            # new e-mail waiting for the person's confirmation
    signature_kind: str | None           # typed | drawn | initials (rubrica)
    signature_font: str | None
    revoke_requested_at: datetime | None  # revocation term sent at the person's request, not signed yet
    dev_link_available: bool   # TEMPORÁRIO — remover antes da implantação (service.dev_link)
    link_sent: bool = True     # False: the person was registered but the mail server did not take the link


def _row(db: Session, p: InstitutionalPerson) -> dict:
    return dict(id=p.id, full_name=p.full_name, position=p.position, unit=p.unit, email=p.email, status=p.status.value,
                status_label=STATUS_LABEL[p.status], created_at=p.created_at, link_expires_at=p.link_expires_at,
                authorized_at=p.authorized_at, revoked_at=p.revoked_at, marks=service.counts(db, p.id),
                name_changed_at=p.name_changed_at, position_changed_at=p.position_changed_at,
                unit_changed_at=p.unit_changed_at, email_changed_at=p.email_changed_at)


def _detail(db: Session, p: InstitutionalPerson) -> PersonDetail:
    return PersonDetail(**_row(db, p), photos=[{"id": ph.id, "position": ph.position, "faces_found": ph.faces_found}
                                               for ph in p.photos],
                        term_version=p.term_version, document_sha256=p.document_sha256, authorized_ip=p.authorized_ip,
                        revoked_by=p.revoked_by, scan_status=p.scan_status, scanned_at=p.scanned_at,
                        signed=p.signature_key is not None, pending_email=p.pending_email,
                        signature_kind=p.signature_kind, signature_font=p.signature_font,
                        revoke_requested_at=p.revoke_requested_at if p.revoke_request_hash else None,
                        dev_link_available=get_settings().email_sender == "outbox" and p.status == InstitutionalStatus.AWAITING)


@admin_router.get("", response_model=list[PersonRow])
def list_people(_: Account = Depends(admin_only), db: Session = Depends(get_session)):
    people = db.scalars(select(InstitutionalPerson).order_by(InstitutionalPerson.full_name)).all()
    return [PersonRow(**_row(db, p)) for p in people]


@admin_router.post("", response_model=PersonDetail, status_code=status.HTTP_201_CREATED)
async def create_person(full_name: str = Form(...), position: str = Form(...), unit: str | None = Form(None),
                        email: str = Form(...), photos: list[UploadFile] = File(...),
                        admin: Account = Depends(admin_only), db: Session = Depends(get_session),
                        storage: ObjectStorage = Depends(get_storage), sender: EmailSender = Depends(get_email_sender)):
    files = [(await f.read(MAX_RAW_PHOTO_BYTES + 1), f.filename or "") for f in photos[:service.MAX_PHOTOS + 1]]
    # The record is saved BEFORE the e-mail leaves. If the mail server fails, the creation is still a success: the
    # screen opens the new record and says the link did not leave, next to "Reenviar link" (17/11/2026). A 503 here
    # would leave the form open, and sending it again would only answer "e-mail já cadastrado".
    try:
        person = service.create(db, storage, admin, service.PersonInput(full_name, position, unit, email), files, sender)
    except EventError as exc:
        raise _http(exc) from None
    except EmailDeliveryError as exc:
        logging.getLogger("fotomac.email").error("authorization e-mail not sent: %s", exc)
        person = db.scalar(select(InstitutionalPerson).where(
            func.lower(InstitutionalPerson.email) == email.strip().lower(),
            InstitutionalPerson.status == InstitutionalStatus.AWAITING))
        return _detail(db, person).model_copy(update={"link_sent": False})
    return _detail(db, person)


@admin_router.get("/{person_id}", response_model=PersonDetail)
def get_person(person_id: uuid.UUID, _: Account = Depends(admin_only), db: Session = Depends(get_session)):
    try:
        return _detail(db, service.get_person(db, person_id))
    except EventError as exc:
        raise _http(exc) from None


@admin_router.get("/{person_id}/photos/{photo_id}")
def person_photo(person_id: uuid.UUID, photo_id: uuid.UUID, small: bool = False, _: Account = Depends(admin_only),
                 db: Session = Depends(get_session), storage: ObjectStorage = Depends(get_storage)):
    """small=true: a 160 px copy, for the photo beside the name in the list."""
    photo = next((ph for ph in service.get_person(db, person_id).photos if ph.id == photo_id), None)
    if photo is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Foto não encontrada.")
    data = storage.get(photo.object_key)
    return _jpeg(_small(data) if small else data)


def _small(data: bytes, side: int = 160) -> bytes:
    image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        return data
    h, w = image.shape[:2]
    k = side / min(h, w)
    if k < 1:
        image = cv2.resize(image, (round(w * k), round(h * k)), interpolation=cv2.INTER_AREA)
    return cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes()


@admin_router.get("/{person_id}/signature")
def person_signature(person_id: uuid.UUID, _: Account = Depends(admin_only), db: Session = Depends(get_session),
                     storage: ObjectStorage = Depends(get_storage)):
    """The signature is shown on the site, in the registration (decision of 21/10/2026)."""
    person = service.get_person(db, person_id)
    if not person.signature_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ainda não assinado.")
    return Response(storage.get(person.signature_key), media_type="image/png", headers={"Cache-Control": "no-store"})


@admin_router.get("/{person_id}/form.pdf")
def person_form(person_id: uuid.UUID, admin: Account = Depends(admin_only), db: Session = Depends(get_session),
                storage: ObjectStorage = Depends(get_storage)):
    """The official copy of the signed authorization (photo, data, term, signature, proof)."""
    person = service.get_person(db, person_id)
    if not person.signature_key:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "O formulário existe depois da assinatura.")
    pdf = form.build(person, storage)
    audit.record(db, "institutional.form_downloaded", admin.id, "institutional_person", person.id)
    db.commit()
    name = f"Autorização FOTOMAC - {person.full_name}.pdf"
    return Response(pdf, media_type="application/pdf", headers={
        "Cache-Control": "no-store", "Content-Disposition": f"attachment; filename=\"autorizacao.pdf\"; filename*=UTF-8''{quote(name)}"})


@admin_router.post("/{person_id}/link", status_code=status.HTTP_204_NO_CONTENT)
def resend_link(person_id: uuid.UUID, admin: Account = Depends(admin_only), db: Session = Depends(get_session),
                sender: EmailSender = Depends(get_email_sender)):
    try:
        service.resend_link(db, admin, service.get_person(db, person_id), sender)
    except EventError as exc:
        raise _http(exc) from None


# TEMPORÁRIO — REMOVER ANTES DA IMPLANTAÇÃO: development-only link display (service.dev_link).
@admin_router.post("/{person_id}/link/dev")
def dev_link(person_id: uuid.UUID, admin: Account = Depends(admin_only), db: Session = Depends(get_session)):
    try:
        return {"url": service.dev_link(db, admin, service.get_person(db, person_id))}
    except EventError as exc:
        raise _http(exc) from None
# FIM DO TRECHO TEMPORÁRIO


@admin_router.post("/{person_id}/end", response_model=PersonDetail)
def end_authorization(person_id: uuid.UUID, admin: Account = Depends(admin_only), db: Session = Depends(get_session),
                      storage: ObjectStorage = Depends(get_storage)):
    try:
        person = service.get_person(db, person_id)
        service.end_by_admin(db, storage, admin, person)
    except EventError as exc:
        raise _http(exc) from None
    return _detail(db, person)


class PersonUpdate(BaseModel):
    full_name: str = Field(max_length=200)
    position: str = Field(max_length=200)
    unit: str | None = Field(None, max_length=200)


@admin_router.put("/{person_id}", response_model=PersonDetail)
def update_person(person_id: uuid.UUID, body: PersonUpdate, admin: Account = Depends(admin_only),
                  db: Session = Depends(get_session)):
    """Correction of name, position and unit (LGPD Art. 18, III). The signed proof is not touched."""
    try:
        person = service.update_person(db, admin, service.get_person(db, person_id), body.full_name, body.position, body.unit)
    except EventError as exc:
        raise _http(exc) from None
    return _detail(db, person)


class EmailIn(BaseModel):
    email: str = Field(max_length=300)


@admin_router.post("/{person_id}/email", response_model=PersonDetail)
def change_email(person_id: uuid.UUID, body: EmailIn, admin: Account = Depends(admin_only),
                 db: Session = Depends(get_session), sender: EmailSender = Depends(get_email_sender)):
    try:
        person = service.request_email_change(db, admin, service.get_person(db, person_id), body.email, sender)
    except EventError as exc:
        raise _http(exc) from None
    return _detail(db, person)


@admin_router.post("/{person_id}/revocation-request", response_model=PersonDetail)
def revocation_request(person_id: uuid.UUID, admin: Account = Depends(admin_only), db: Session = Depends(get_session),
                       sender: EmailSender = Depends(get_email_sender)):
    """The person asked to revoke: the revocation term goes to their e-mail, to be signed there."""
    try:
        person = service.get_person(db, person_id)
        service.send_revocation_request(db, admin, person, sender)
    except EventError as exc:
        raise _http(exc) from None
    return _detail(db, person)


@admin_router.post("/{person_id}/rescan", status_code=status.HTTP_204_NO_CONTENT)
def rescan(person_id: uuid.UUID, admin: Account = Depends(admin_only), db: Session = Depends(get_session)):
    try:
        service.schedule_rescan(db, admin, service.get_person(db, person_id))
    except EventError as exc:
        raise _http(exc) from None


@admin_router.delete("/{person_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_person(person_id: uuid.UUID, admin: Account = Depends(admin_only), db: Session = Depends(get_session),
                  storage: ObjectStorage = Depends(get_storage)):
    try:
        service.delete_awaiting(db, storage, admin, service.get_person(db, person_id))
    except EventError as exc:
        raise _http(exc) from None


# ------------------------------------------------------------------ the person (public, by link)

@public_router.get("/authorization", dependencies=[Depends(link_limiter)])
def authorization_page(token: str = Query(...), db: Session = Depends(get_session)):
    try:
        person = service.by_link(db, token)
    except EventError as exc:
        raise _http(exc) from None
    return {"full_name": person.full_name, "position": person.position, "unit": person.unit,
            "photos": [str(ph.id) for ph in person.photos], "expires_at": person.link_expires_at,
            "term": {"version": term.TERM_VERSION, "title": term.TERM_TITLE,
                     "paragraphs": term.paragraphs(person.full_name, person.position, person.unit)}}


@public_router.get("/authorization/photos/{photo_id}", dependencies=[Depends(link_limiter)])
def authorization_photo(photo_id: uuid.UUID, token: str = Query(...), db: Session = Depends(get_session),
                        storage: ObjectStorage = Depends(get_storage)):
    """The person sees exactly which photos of them will be used — only with their own link."""
    try:
        person = service.by_link(db, token)
    except EventError as exc:
        raise _http(exc) from None
    photo = next((ph for ph in person.photos if ph.id == photo_id), None)
    if photo is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Foto não encontrada.")
    return _jpeg(storage.get(photo.object_key))


class SignatureIn(BaseModel):
    token: str = Field(max_length=200)
    signature: str = Field(max_length=500_000)   # PNG made on the screen (typed, drawn or rubrica), as a data URL
    kind: str = Field("drawn", max_length=10)    # typed | drawn | initials
    text: str | None = Field(None, max_length=200)
    font: str | None = Field(None, max_length=60)


def _how(body: SignatureIn) -> service.SignatureHow:
    try:
        return service.signature_how(body.kind, body.text, body.font)
    except EventError as exc:
        raise _http(exc) from None


def _png(data_url: str) -> bytes:
    try:
        return base64.b64decode(data_url.split(",", 1)[-1], validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Assinatura inválida. Assine de novo no quadro.") from None


@public_router.post("/authorization", dependencies=[Depends(link_limiter)])
def sign(body: SignatureIn, request: Request, db: Session = Depends(get_session),
         storage: ObjectStorage = Depends(get_storage), sender: EmailSender = Depends(get_email_sender)):
    try:
        png = base64.b64decode(body.signature.split(",", 1)[-1], validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Assinatura inválida. Assine de novo no quadro.") from None
    try:
        service.authorize(db, storage, sender, body.token, png, request.client.host if request.client else None,
                          request.headers.get("user-agent"), _how(body))
    except EventError as exc:
        raise _http(exc) from None
    # The revocation link goes only to the e-mail (24/10/2026), not to the screen.
    return {"signed": True}


class TokenIn(BaseModel):
    token: str = Field(max_length=200)


@public_router.post("/refusal", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(link_limiter)])
def refuse(body: TokenIn, db: Session = Depends(get_session), storage: ObjectStorage = Depends(get_storage)):
    try:
        service.refuse(db, storage, body.token)
    except EventError as exc:
        raise _http(exc) from None


@public_router.get("/revocation", dependencies=[Depends(link_limiter)])
def revocation_page(token: str = Query(...), db: Session = Depends(get_session)):
    try:
        person = service.by_revoke_link(db, token)
    except EventError as exc:
        raise _http(exc) from None
    return {"full_name": person.full_name, "status": person.status.value, "authorized_at": person.authorized_at,
            "revoked_at": person.revoked_at}


@public_router.post("/revocation", dependencies=[Depends(link_limiter)])
def revoke(body: SignatureIn, request: Request, db: Session = Depends(get_session),
           storage: ObjectStorage = Depends(get_storage)):
    """Signed on the screen, like the authorization (24/10/2026)."""
    try:
        person = service.revoke_by_holder(db, storage, body.token, _png(body.signature),
                                          request.client.host if request.client else None, _how(body))
    except EventError as exc:
        raise _http(exc) from None
    return {"revoked_at": person.revoked_at}


@public_router.get("/email-change", dependencies=[Depends(link_limiter)])
def email_change_page(token: str = Query(...), db: Session = Depends(get_session)):
    try:
        person = service.by_email_change_link(db, token)
    except EventError as exc:
        raise _http(exc) from None
    return {"full_name": person.full_name, "old_email": person.email, "new_email": person.pending_email,
            "authorized_at": person.authorized_at, "expires_at": person.email_change_expires_at}


@public_router.post("/email-change", dependencies=[Depends(link_limiter)])
def confirm_email_change(body: SignatureIn, request: Request, db: Session = Depends(get_session),
                         storage: ObjectStorage = Depends(get_storage), sender: EmailSender = Depends(get_email_sender)):
    try:
        person = service.confirm_email_change(db, storage, sender, body.token, _png(body.signature),
                                              request.client.host if request.client else None, _how(body))
    except EventError as exc:
        raise _http(exc) from None
    return {"email": person.email}


# ------------------------------------------------------------------ consultation

@router.get("/people")
def people(_: Account = Depends(consulting), db: Session = Depends(get_session)):
    """Only the name and the role of the active people, never e-mail or proof, and the first reference photo, to
    recognize the person in the list. Since 31/10/2026 the whole consulting team sees it, not only the
    administrator: the team confirms "se sou eu de fato" (term, section 2), and the reference photos are what it
    compares against; the term says so from version 4 on."""
    return [{"id": p.id, "full_name": p.full_name, "position": p.position, "unit": p.unit,
             "photo_id": p.photos[0].id if p.photos else None} for p in service.active_people(db)]


def _person_out(person: InstitutionalPerson) -> dict:
    return {"id": person.id, "full_name": person.full_name, "position": person.position, "unit": person.unit,
            "name_changed_at": person.name_changed_at, "position_changed_at": person.position_changed_at,
            "unit_changed_at": person.unit_changed_at,
            # The reference photos of the signed term: the person's card and the side-by-side comparison.
            "photo_ids": [ph.id for ph in person.photos]}


@router.get("/people/{person_id}/reference/{photo_id}")
def reference_photo(person_id: uuid.UUID, photo_id: uuid.UUID, small: bool = False, _: Account = Depends(consulting),
                    db: Session = Depends(get_session), storage: ObjectStorage = Depends(get_storage)):
    """A reference photo of an ACTIVE person, for the team that confirms the marks (never public; a revoked or
    ended authorization has no photos left, and an awaiting one is not consultable). small=true: 160 px."""
    try:
        person = service.active_person(db, person_id)
    except EventError as exc:
        raise _http(exc) from None
    photo = next((ph for ph in person.photos if ph.id == photo_id), None)
    if photo is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Foto não encontrada.")
    data = storage.get(photo.object_key)
    return Response(_small(data) if small else data, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=600"})


def _marked(mark, image: Image) -> dict:
    return {"image_id": image.id, "status": mark.status, "similarity": round(mark.similarity, 4),
            "credit": credit_line(image.credit_signature), "signature": image.credit_signature,
            "captured_at": image.captured_at, "version": image.sha256[:12]}


@router.get("/people/{person_id}/profile")
def person_profile(person_id: uuid.UUID, date_from: date | None = None, date_to: date | None = None,
                   account: Account = Depends(consulting), db: Session = Depends(get_session)):
    """The person's page: who it is and, event by event, the photos where the person was found."""
    try:
        person = service.active_person(db, person_id)
    except EventError as exc:
        raise _http(exc) from None
    return {"person": _person_out(person),
            # term v2: whether the photos may go to the press named after the person (shown on the screen
            # BEFORE the click, instead of a refusal after it).
            "press_allowed": term.allows_press(person.term_version),
            "events": [{**event, "can_open": _can_open(db, account, event["id"]),
                        "images": [_marked(mark, image) for mark, image in rows]}
                       for event, rows in service.person_profile(db, account, person, date_from, date_to)]}


def _can_open(db: Session, account: Account, event_id: uuid.UUID) -> bool:
    """"Abrir evento" only where the account already sees the event in the panel: the consultation shows the
    person's photos in any event (the person authorized it), never the rest of someone else's event."""
    try:
        get_visible(db, account, event_id)
        return True
    except NotFound:
        return False


DOWNLOAD_LINK_MINUTES = 15


@router.post("/people/{person_id}/images/{image_id}/download-link")
def named_download_link(person_id: uuid.UUID, image_id: uuid.UUID, request: Request,
                        _: Account = Depends(consulting), db: Session = Depends(get_session)):
    """Signed for this login session for 15 minutes, like the other downloads of the panel: the address
    alone, copied or leaked, downloads nothing."""
    try:
        service.marked_image(db, service.active_person(db, person_id), image_id)
    except EventError as exc:
        raise _http(exc) from None
    token = signed_links.sign(token_hash(session_token(request) or ""), f"institutional:{person_id}:{image_id}",
                              DOWNLOAD_LINK_MINUTES * 60)
    return {"url": f"/api/v1/institutional/people/{person_id}/images/{image_id}/download?t={token}"}


@router.get("/people/{person_id}/images/{image_id}/download")
def named_download(person_id: uuid.UUID, image_id: uuid.UUID, request: Request, t: str | None = None,
                   account: Account = Depends(consulting), db: Session = Depends(get_session),
                   storage: ObjectStorage = Depends(get_storage)):
    if not signed_links.verify(token_hash(session_token(request) or ""), f"institutional:{person_id}:{image_id}", t):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Link de download expirado. Abra a foto e baixe de novo.")
    try:
        data, name = service.named_download(db, storage, account, service.active_person(db, person_id), image_id)
    except EventError as exc:
        raise _http(exc) from None
    name = name.replace("/", "-").replace('"', "")
    return Response(data, media_type="image/jpeg", headers={
        "Cache-Control": "no-store", "Content-Disposition": f"attachment; filename=\"FOTOMAC.jpg\"; filename*=UTF-8''{quote(name)}"})


@router.get("/people/{person_id}/images/{image_id}/details")
def marked_image_details(person_id: uuid.UUID, image_id: uuid.UUID, _: Account = Depends(consulting),
                         db: Session = Depends(get_session), storage: ObjectStorage = Depends(get_storage)):
    """'Detalhes' of a photo of the person — the same photos the consultation already shows, nothing else.
    Registered before the "{variant}" route, which would take "details" for a variant."""
    from app.images import details
    try:
        image = service.marked_image(db, service.active_person(db, person_id), image_id)
    except EventError as exc:
        raise _http(exc) from None
    return details.read(storage, image)


@router.get("/people/{person_id}/images/{image_id}/{variant}")
def marked_image_file(person_id: uuid.UUID, image_id: uuid.UUID, variant: str, _: Account = Depends(consulting),
                      db: Session = Depends(get_session), storage: ObjectStorage = Depends(get_storage)):
    """Only the images marked for that person (a photographer sees them even in someone else's event,
    because the person authorized exactly this)."""
    try:
        image = service.marked_image(db, service.active_person(db, person_id), image_id)
    except EventError as exc:
        raise _http(exc) from None
    key = {"thumb": image.thumb_key, "preview": image.preview_key}.get(variant)
    if not key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Arquivo não encontrado.")
    return Response(storage.get(key), media_type="image/jpeg", headers={"Cache-Control": "private, max-age=600"})


class DecisionIn(BaseModel):
    image_ids: list[uuid.UUID] = Field(min_length=1, max_length=1000)
    confirm: bool


@router.post("/people/{person_id}/marks")
def decide(person_id: uuid.UUID, body: DecisionIn, account: Account = Depends(consulting), db: Session = Depends(get_session)):
    try:
        return {"decided": service.decide(db, account, service.active_person(db, person_id), body.image_ids, body.confirm)}
    except EventError as exc:
        raise _http(exc) from None
