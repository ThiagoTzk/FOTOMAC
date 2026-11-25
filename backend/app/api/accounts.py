"""ADMINISTRATOR routes for accounts: /api/v1/admin/accounts/*.

Every route requires an active administrator session — checked on the server before any
processing. There is deliberately no DELETE.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.accounts import service
from app.api.deps import require_role
from app.db.models import Account, AccountRole, AccountStatus
from app.db.session import get_session
from app.events.service import EventError, NotFound, PermissionDenied
from app.notifications.factory import get_email_sender
from app.notifications.port import EmailDeliveryError, EmailSender
from app.storage.factory import get_storage
from app.storage.port import ObjectStorage

router = APIRouter(prefix="/admin/accounts", tags=["admin: contas"])
admin_only = require_role(AccountRole.ADMIN)


class AccountRow(BaseModel):
    id: uuid.UUID
    full_name: str
    email: str
    role: str
    role_label: str
    status: str
    status_label: str
    photographer_signature: str | None
    locked: bool
    activation_link: str | None   # "valid" | "expired" for pending accounts
    created_at: datetime
    # The profile photo the person chose to send (30/10/2026: the administrator sees it, to know who is who).
    photo_version: str | None = None


class ContractorOut(BaseModel):
    """Temporary account. The CPF is shown masked; nothing here leaves the administrator's area."""
    event_id: uuid.UUID | None
    event_name: str | None
    contract_number: str | None
    valid_until: datetime | None
    contract_hours: int | None   # how long it works from the first access (chosen by the administrator)
    cpf: str | None              # "***.***.***-12"
    birth_date: date | None
    identity_erased_at: datetime | None
    photos: int
    photos_pending: int          # awaiting the administrator's approval


class AccountDetail(AccountRow):
    owned_events: int
    is_me: bool
    contractor: ContractorOut | None = None
    dev_link_available: bool = False  # TEMPORÁRIO — remover antes da implantação (see service.dev_activation_link)
    link_sent: bool = True            # False: the account was created but the mail server did not take the link


def _row(db: Session, a: Account) -> dict:
    return dict(id=a.id, full_name=a.full_name, email=a.email, role=a.role.value, role_label=service.ROLE_LABEL[a.role],
                status=a.status.value, status_label=service.STATUS_LABEL[a.status],
                photographer_signature=a.photographer_signature, locked=service.is_locked(a),
                activation_link=service.activation_link_state(db, a), created_at=a.created_at,
                photo_version=a.photo_updated_at.strftime("%Y%m%d%H%M%S") if a.photo_key else None)


def _contractor(db: Session, a: Account) -> ContractorOut | None:
    if a.role != AccountRole.CONTRACTOR:
        return None
    from sqlalchemy import func, select

    from app.db.models import Event, Image
    ident = service.contractor_identity(db, a) or {}
    event = db.get(Event, a.bound_event_id) if a.bound_event_id else None
    photos = db.scalar(select(func.count()).select_from(Image).where(Image.uploaded_by == a.id)) or 0
    pending = db.scalar(select(func.count()).select_from(Image).where(Image.uploaded_by == a.id,
                                                                     Image.approval == "pending")) or 0
    return ContractorOut(event_id=a.bound_event_id, event_name=event.name if event else None,
                         contract_number=a.contract_number, valid_until=a.valid_until,
                         contract_hours=a.contract_hours, cpf=ident.get("cpf"),
                         birth_date=ident.get("birth_date"), identity_erased_at=ident.get("erased_at"),
                         photos=photos, photos_pending=pending)


def _detail(db: Session, a: Account, admin: Account) -> AccountDetail:
    return AccountDetail(**_row(db, a), owned_events=service.owned_events(db, a), is_me=a.id == admin.id,
                         dev_link_available=service.dev_mode_link_available(), contractor=_contractor(db, a))


def _http(exc: EventError) -> HTTPException:
    code = (status.HTTP_404_NOT_FOUND if isinstance(exc, NotFound)
            else status.HTTP_403_FORBIDDEN if isinstance(exc, PermissionDenied) else status.HTTP_400_BAD_REQUEST)
    return HTTPException(code, str(exc))


def _get(db: Session, account_id: uuid.UUID) -> Account:
    try:
        return service.get_account(db, account_id)
    except EventError as exc:
        raise _http(exc) from None


@router.get("")
def list_accounts(q: str | None = Query(None, max_length=120), role: AccountRole | None = None,
                  status_: AccountStatus | None = Query(None, alias="status"),
                  admin: Account = Depends(admin_only), db: Session = Depends(get_session)):
    items, counts = service.list_accounts(db, q, role, status_)
    return {"items": [AccountRow(**_row(db, a)) for a in items], "counts": counts,
            "institutional_domain": service.INSTITUTIONAL_DOMAIN}


class AccountIn(BaseModel):
    full_name: str = Field(max_length=200)
    email: str = Field(max_length=200)
    role: AccountRole
    photographer_signature: str | None = Field(None, max_length=200)
    bound_event_id: uuid.UUID | None = None                      # hired photographer only
    contract_number: str | None = Field(None, max_length=200)
    contract_hours: int | None = None                            # hired photographer only (default 24)


@router.post("", response_model=AccountDetail, status_code=status.HTTP_201_CREATED)
def create_account(body: AccountIn, admin: Account = Depends(admin_only), db: Session = Depends(get_session),
                   sender: EmailSender = Depends(get_email_sender)):
    # The record is saved BEFORE the e-mail leaves. If the mail server fails, the creation is still a success: the
    # screen opens the new record and says the link did not leave, next to "Reenviar link" (17/11/2026). A 503 here
    # would leave the form open, and sending it again would only answer "e-mail já cadastrado".
    try:
        account = service.create_account(db, admin, sender, service.AccountInput(
            body.full_name, body.email, body.role, body.photographer_signature, body.bound_event_id,
            body.contract_number, body.contract_hours))
    except EventError as exc:
        raise _http(exc) from None
    except EmailDeliveryError as exc:
        logging.getLogger("fotomac.email").error("activation e-mail not sent: %s", exc)
        account = db.scalar(select(Account).where(func.lower(Account.email) == body.email.strip().lower()))
        return _detail(db, account, admin).model_copy(update={"link_sent": False})
    return _detail(db, account, admin)


@router.get("/{account_id}", response_model=AccountDetail)
def get_account(account_id: uuid.UUID, admin: Account = Depends(admin_only), db: Session = Depends(get_session)):
    return _detail(db, _get(db, account_id), admin)


class AccountUpdate(BaseModel):
    full_name: str = Field(max_length=200)
    role: AccountRole
    photographer_signature: str | None = Field(None, max_length=200)


@router.put("/{account_id}", response_model=AccountDetail)
def update_account(account_id: uuid.UUID, body: AccountUpdate, admin: Account = Depends(admin_only),
                   db: Session = Depends(get_session)):
    account = _get(db, account_id)
    try:
        service.update_account(db, admin, account, body.full_name, body.role, body.photographer_signature)
    except EventError as exc:
        raise _http(exc) from None
    return _detail(db, account, admin)


class StatusIn(BaseModel):
    status: AccountStatus


@router.post("/{account_id}/status", response_model=AccountDetail)
def change_status(account_id: uuid.UUID, body: StatusIn, admin: Account = Depends(admin_only),
                  db: Session = Depends(get_session), sender: EmailSender = Depends(get_email_sender)):
    account = _get(db, account_id)
    try:
        service.change_status(db, admin, sender, account, body.status)
    except EventError as exc:
        raise _http(exc) from None
    return _detail(db, account, admin)


@router.post("/{account_id}/activation-link", status_code=status.HTTP_204_NO_CONTENT)
def resend_activation(account_id: uuid.UUID, admin: Account = Depends(admin_only), db: Session = Depends(get_session),
                      sender: EmailSender = Depends(get_email_sender)):
    try:
        service.resend_activation(db, admin, sender, _get(db, account_id))
    except EventError as exc:
        raise _http(exc) from None


# TEMPORÁRIO — REMOVER ANTES DA IMPLANTAÇÃO: development-only link display (service.dev_activation_link).
class DevLinkOut(BaseModel):
    url: str


@router.post("/{account_id}/activation-link/dev", response_model=DevLinkOut)
def dev_activation_link(account_id: uuid.UUID, admin: Account = Depends(admin_only), db: Session = Depends(get_session)):
    try:
        return DevLinkOut(url=service.dev_activation_link(db, admin, _get(db, account_id)))
    except EventError as exc:
        raise _http(exc) from None
# FIM DO TRECHO TEMPORÁRIO


class ContractIn(BaseModel):
    event_id: uuid.UUID
    contract_number: str = Field(max_length=200)
    hours: int


@router.post("/{account_id}/contract", response_model=AccountDetail)
def renew_contract(account_id: uuid.UUID, body: ContractIn, admin: Account = Depends(admin_only),
                   db: Session = Depends(get_session), sender: EmailSender = Depends(get_email_sender)):
    """Hired photographer: renew the access for a new coverage, or add hours to the current one."""
    account = _get(db, account_id)
    try:
        service.renew_contract(db, admin, sender, account, body.event_id, body.contract_number, body.hours)
    except EventError as exc:
        raise _http(exc) from None
    return _detail(db, account, admin)


@router.post("/{account_id}/unlock", response_model=AccountDetail)
def unlock(account_id: uuid.UUID, admin: Account = Depends(admin_only), db: Session = Depends(get_session)):
    account = _get(db, account_id)
    service.unlock(db, admin, account)
    return _detail(db, account, admin)


@router.get("/{account_id}/photo")
def account_photo(account_id: uuid.UUID, admin: Account = Depends(admin_only), db: Session = Depends(get_session),
                  storage: ObjectStorage = Depends(get_storage)):
    """The profile photo of an account, for the administrator only (the list of accounts)."""
    account = _get(db, account_id)
    if not account.photo_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Esta conta não tem foto de perfil.")
    return Response(storage.get(account.photo_key), media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})
