"""Support page: the team writes to the administration, and both sides talk until it is solved (28/10 and 31/10/2026).

A suspended, inactive or expired account also reaches the routes of the person's side (not the administrator's):
it is the way to ask to come back, from the restricted screen.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.accounts.service import ROLE_LABEL, STATUS_LABEL
from app.api.deps import current_account_even_blocked, require_role
from app.db.models import Account, AccountRole, SupportMessage
from app.db.session import get_session
from app.security.rate_limit import RateLimiter
from app.support import service

router = APIRouter(tags=["suporte"])
admin_only = require_role(AccountRole.ADMIN)
send_limiter = RateLimiter(max_requests=10, window_seconds=3600)    # new conversations, per account
reply_limiter = RateLimiter(max_requests=60, window_seconds=3600)   # replies, per account: a conversation, not a flood


class MessageIn(BaseModel):
    kind: str = Field(max_length=12)
    subject: str = Field(max_length=200)
    message: str = Field(max_length=4000)
    page: str | None = Field(None, max_length=300)


class ReplyIn(BaseModel):
    body: str = Field(max_length=3000)


class StatusIn(BaseModel):
    status: str = Field(max_length=12)
    note: str | None = Field(None, max_length=3000)


class EntryOut(BaseModel):
    from_admin: bool
    author_name: str | None
    body: str | None
    status: str | None
    status_label: str | None
    created_at: datetime


class MessageOut(BaseModel):
    id: uuid.UUID
    kind: str
    kind_label: str
    subject: str
    message: str
    page: str | None
    status: str
    status_label: str
    created_at: datetime
    resolved_at: datetime | None
    entries: list[EntryOut]
    unread: bool              # the other side did something this side has not read yet
    # Only in the administrator's list: who wrote, and the situation of that account (to reactivate it from there).
    author_id: uuid.UUID | None = None
    author_name: str | None = None
    author_email: str | None = None
    author_role: str | None = None
    author_status: str | None = None
    author_status_label: str | None = None


def _out(row: SupportMessage, for_admin: bool = False) -> MessageOut:
    entries = [EntryOut(from_admin=e.from_admin,
                        # The person sees "Administração", not which administrator; the administrator sees the name.
                        author_name=(e.author.full_name if e.author else None) if for_admin or not e.from_admin else "Administração",
                        body=e.body, status=e.status, status_label=service.STATUS[e.status] if e.status else None,
                        created_at=e.created_at) for e in row.entries]
    out = MessageOut(id=row.id, kind=row.kind, kind_label=service.KINDS[row.kind], subject=row.subject,
                     message=row.message, page=row.page, status=row.status, status_label=service.STATUS[row.status],
                     created_at=row.created_at, resolved_at=row.resolved_at, entries=entries,
                     unread=service.unread(row, for_admin))
    if for_admin:
        a = row.account
        out.author_id, out.author_name, out.author_email = a.id, a.full_name, a.email
        out.author_role, out.author_status, out.author_status_label = ROLE_LABEL[a.role], a.status.value, STATUS_LABEL[a.status]
    return out


def _http(exc: service.SupportError) -> HTTPException:
    code = status.HTTP_404_NOT_FOUND if isinstance(exc, service.NotFound) else status.HTTP_400_BAD_REQUEST
    return HTTPException(code, str(exc))


# ---------------------------------------------------------------- the person's side

@router.post("/support", response_model=MessageOut, status_code=status.HTTP_201_CREATED)
def send(body: MessageIn, account: Account = Depends(current_account_even_blocked), db: Session = Depends(get_session)):
    send_limiter.check(str(account.id))
    try:
        return _out(service.send(db, account, body.kind, body.subject, body.message, body.page))
    except service.SupportError as exc:
        raise _http(exc) from None


@router.get("/support/mine", response_model=list[MessageOut])
def mine(account: Account = Depends(current_account_even_blocked), db: Session = Depends(get_session)):
    return [_out(r) for r in service.mine(db, account)]


@router.post("/support/{message_id}/replies", response_model=MessageOut)
def reply_mine(message_id: uuid.UUID, body: ReplyIn, account: Account = Depends(current_account_even_blocked),
               db: Session = Depends(get_session)):
    reply_limiter.check(str(account.id))
    try:
        return _out(service.reply(db, account, message_id, body.body, as_admin=False))
    except service.SupportError as exc:
        raise _http(exc) from None


@router.post("/support/{message_id}/seen", status_code=status.HTTP_204_NO_CONTENT)
def seen_mine(message_id: uuid.UUID, account: Account = Depends(current_account_even_blocked),
              db: Session = Depends(get_session)):
    try:
        service.mark_seen(db, account, message_id, as_admin=False)
    except service.SupportError as exc:
        raise _http(exc) from None


# ---------------------------------------------------------------- the administration's side

@router.get("/admin/support", response_model=list[MessageOut])
def all_messages(status_: str | None = Query(None, alias="status", pattern="^(active|open|analyzing|fixing|resolved)$"),
                 _: Account = Depends(admin_only), db: Session = Depends(get_session)):
    return [_out(r, for_admin=True) for r in service.all_messages(db, status_)]


@router.post("/admin/support/{message_id}/replies", response_model=MessageOut)
def reply(message_id: uuid.UUID, body: ReplyIn, admin: Account = Depends(admin_only), db: Session = Depends(get_session)):
    reply_limiter.check(str(admin.id))
    try:
        return _out(service.reply(db, admin, message_id, body.body, as_admin=True), for_admin=True)
    except service.SupportError as exc:
        raise _http(exc) from None


@router.post("/admin/support/{message_id}/status", response_model=MessageOut)
def change_status(message_id: uuid.UUID, body: StatusIn, admin: Account = Depends(admin_only),
                  db: Session = Depends(get_session)):
    try:
        return _out(service.set_status(db, admin, message_id, body.status, body.note), for_admin=True)
    except service.SupportError as exc:
        raise _http(exc) from None


@router.post("/admin/support/{message_id}/seen", status_code=status.HTTP_204_NO_CONTENT)
def seen(message_id: uuid.UUID, admin: Account = Depends(admin_only), db: Session = Depends(get_session)):
    try:
        service.mark_seen(db, admin, message_id, as_admin=True)
    except service.SupportError as exc:
        raise _http(exc) from None
