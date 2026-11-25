"""Collaboration by request (01/11/2026, user test).

A photographer (or the marketing team) finds an event of someone else in the list and asks its responsible to send
photos to it, to accept RAW files there, or both, with an optional message ("quero enviar 24 imagens"). The
responsible accepts or declines, with an optional reply; each side is told on the bell (events.notifications).

Accepting the photos adds the account BY NAME to the event (EventCollaborator): it sends even with the
collaboration closed. The open collaboration of RF025 is unchanged. Turning RAW on is a choice made in the
acceptance itself, never implied: RAW stays off unless the responsible ticks it (memory: RAW off by default).

Each request is also a conversation (01/11/2026: "um chat de verdade para ficar salvo o que foi conversado"):
the requester and the responsible write to each other there, before and after the answer. The administrator joins
only where the responsible's account is not active, the same rule as answering (RF003 note 5): otherwise the
conversation is between the two of them (LGPD Art. 6º, III).

Data kept: who asked, what, the two optional messages, the conversation and the dates. A request goes, conversation
included, KEEP_DAYS after its last activity (the answer or the last message), the same period as the support page;
the audit log keeps the facts without the texts.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app import audit
from app.db.models import (PRODUCER_ROLES, Account, AccountRole, AccountStatus, CollaborationMessage,
                           CollaborationRead, CollaborationRequest, Event, EventCollaborator, EventStatus)
from app.events.service import EventError, NotFound, PermissionDenied, can_manage

MESSAGE_MAX = 500
CHAT_MAX = 1000
KEEP_DAYS = 90


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _clean(text: str | None) -> str | None:
    text = (text or "").strip()
    if len(text) > MESSAGE_MAX:
        raise EventError(f"A mensagem pode ter até {MESSAGE_MAX} caracteres.")
    return text or None


def _uploads(account: Account, event: Event) -> bool:
    from app.images.service import can_upload   # local: images.service imports events.service
    return can_upload(account, event)


def pending_of(db: Session, account: Account, event: Event) -> CollaborationRequest | None:
    return db.scalar(select(CollaborationRequest).where(CollaborationRequest.event_id == event.id,
                                                        CollaborationRequest.requester_id == account.id,
                                                        CollaborationRequest.status == "pending"))


def latest_of(db: Session, account: Account, event: Event) -> CollaborationRequest | None:
    """The account's latest request on the event (cancelled ones are not shown again)."""
    return db.scalar(select(CollaborationRequest).where(CollaborationRequest.event_id == event.id,
                                                        CollaborationRequest.requester_id == account.id,
                                                        CollaborationRequest.status != "cancelled")
                     .order_by(CollaborationRequest.created_at.desc()).limit(1))


def options(account: Account, event: Event) -> dict[str, bool]:
    """What this account could ask on this event now: {"upload": …, "raw": …}. Nothing for the responsible, the
    administrator, a hired photographer, an event that is over and someone whose access was ended there (the
    responsible ended it on purpose; asking again would only insist)."""
    if (account.role not in PRODUCER_ROLES or account.status != AccountStatus.ACTIVE or can_manage(account, event)
            or event.status == EventStatus.EXPIRED or event.deletion_due_at or event.blocks(account.id)):
        return {"upload": False, "raw": False}
    return {"upload": not _uploads(account, event), "raw": not event.raw_enabled}


def ask(db: Session, account: Account, event: Event, *, wants_upload: bool, wants_raw: bool,
        message: str | None) -> CollaborationRequest:
    can = options(account, event)
    if event.blocks(account.id):
        raise PermissionDenied("O responsável encerrou o seu acesso a este evento.")
    if not (can["upload"] or can["raw"]):
        raise EventError("Não há o que pedir neste evento.")
    if wants_upload and not can["upload"]:
        raise EventError("Você já pode enviar imagens a este evento.")
    if wants_raw and not can["raw"]:
        raise EventError("Este evento já aceita arquivos RAW.")
    if not (wants_upload or wants_raw):
        raise EventError("Escolha o que pedir.")
    if pending_of(db, account, event):
        raise EventError("Você já tem um pedido aguardando resposta neste evento.")
    request = CollaborationRequest(event_id=event.id, requester_id=account.id, wants_upload=wants_upload,
                                   wants_raw=wants_raw, message=_clean(message))
    db.add(request)
    db.flush()
    audit.record(db, "event.collaboration_requested", account.id, "event", event.id, request_id=str(request.id),
                 wants_upload=wants_upload, wants_raw=wants_raw)
    db.commit()
    return request


def get(db: Session, event: Event, request_id: uuid.UUID) -> CollaborationRequest:
    request = db.scalar(select(CollaborationRequest).where(CollaborationRequest.id == request_id,
                                                           CollaborationRequest.event_id == event.id))
    if request is None:
        raise NotFound("Pedido não encontrado.")
    return request


def cancel(db: Session, account: Account, request: CollaborationRequest) -> CollaborationRequest:
    if request.requester_id != account.id:
        raise NotFound("Pedido não encontrado.")
    if request.status != "pending":
        raise EventError("Este pedido já foi respondido.")
    request.status, request.decided_at = "cancelled", _now()
    audit.record(db, "event.collaboration_request_cancelled", account.id, "event", request.event_id,
                 request_id=str(request.id))
    db.commit()
    return request


def decide(db: Session, actor: Account, request: CollaborationRequest, *, accept: bool, reply: str | None,
           turn_raw_on: bool) -> CollaborationRequest:
    """The responsible (or the administrator, who takes over its prerogatives) answers. Accepting photos adds the
    requester by name and gives the access back if it had been ended; RAW goes on only when turn_raw_on is ticked."""
    event = request.event
    if not can_manage(actor, event):
        raise PermissionDenied("Somente o responsável pelo evento responde a este pedido.")
    if request.status != "pending":
        raise EventError("Este pedido já foi respondido ou cancelado.")
    if event.status == EventStatus.EXPIRED or event.deletion_due_at:
        raise EventError("Este evento não pode mais ser alterado.")
    if turn_raw_on and not (accept and request.wants_raw):
        raise EventError("Os arquivos RAW só são ligados ao aceitar um pedido de RAW.")
    request.reply = _clean(reply)
    request.status, request.decided_at, request.decided_by = ("accepted" if accept else "declined"), _now(), actor.id
    if accept and request.wants_upload:
        if not event.admits(request.requester_id):
            event.granted.append(EventCollaborator(account_id=request.requester_id, added_by=actor.id))
        if event.blocks(request.requester_id):
            event.access_blocks = [b for b in event.access_blocks if b.account_id != request.requester_id]
    if turn_raw_on and not event.raw_enabled:
        event.raw_enabled = True
        audit.record(db, "event.raw_enabled", actor.id, "event", event.id, by_request=str(request.id))
        request.raw_turned_on = True
    audit.record(db, "event.collaboration_request_" + request.status, actor.id, "event", event.id,
                 request_id=str(request.id), requester_id=str(request.requester_id),
                 raw_turned_on=request.raw_turned_on)
    db.commit()
    return request


def for_event(db: Session, event: Event) -> list[CollaborationRequest]:
    """For whoever manages the event: the waiting requests first, then the answered ones still kept."""
    rows = db.scalars(select(CollaborationRequest).where(CollaborationRequest.event_id == event.id,
                                                         CollaborationRequest.status != "cancelled")
                      .order_by(CollaborationRequest.created_at.desc())).all()
    return sorted(rows, key=lambda r: r.status != "pending")


def mark_seen(db: Session, account: Account, request: CollaborationRequest) -> None:
    """The requester read the answer: the bell stops telling about it."""
    if request.requester_id == account.id and request.status in ("accepted", "declined") and not request.requester_seen_at:
        request.requester_seen_at = _now()
        db.commit()


def waiting(db: Session, event_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    """How many requests wait on each event (the pill in the lists and the tab)."""
    if not event_ids:
        return {}
    return dict(db.execute(select(CollaborationRequest.event_id, func.count()).where(
        CollaborationRequest.event_id.in_(event_ids), CollaborationRequest.status == "pending")
        .group_by(CollaborationRequest.event_id)).all())


# ------------------------------------------------------------------ conversation

def participant(account: Account, request: CollaborationRequest) -> bool:
    """Who talks in the request: the requester and the responsible. The administrator only where the responsible's
    account is not active: it takes over the event then (RF003 note 5)."""
    owner = request.event.owner
    return (account.id in (request.requester_id, owner.id)
            or (account.role == AccountRole.ADMIN and owner.status != AccountStatus.ACTIVE))


def closed_reason(account: Account, request: CollaborationRequest) -> str | None:
    """Why this account can only read the conversation now (None = it writes)."""
    event = request.event
    if request.status == "cancelled":
        return "O pedido foi cancelado. A conversa fica só para leitura."
    if event.status == EventStatus.EXPIRED or event.deletion_due_at:
        return "Este evento terminou. A conversa fica só para leitura."
    if account.id == request.requester_id and event.blocks(account.id):
        return "O responsável encerrou o seu acesso a este evento. A conversa fica só para leitura."
    return None


def _read(db: Session, account: Account, request: CollaborationRequest, when: datetime) -> None:
    db.merge(CollaborationRead(request_id=request.id, account_id=account.id, read_at=when))


def write(db: Session, account: Account, request: CollaborationRequest, body: str) -> CollaborationMessage:
    if not participant(account, request):
        raise NotFound("Pedido não encontrado.")
    reason = closed_reason(account, request)
    if reason:
        raise EventError(reason)
    body = (body or "").strip()
    if not body:
        raise EventError("Escreva a mensagem.")
    if len(body) > CHAT_MAX:
        raise EventError(f"A mensagem pode ter até {CHAT_MAX} caracteres.")
    now = _now()
    message = CollaborationMessage(author_id=account.id, body=body, created_at=now)
    request.messages.append(message)
    _read(db, account, request, now)   # what one writes, one has read
    audit.record(db, "event.collaboration_message", account.id, "event", request.event_id, request_id=str(request.id))
    db.commit()
    return message


def mark_read(db: Session, account: Account, request: CollaborationRequest) -> None:
    if participant(account, request):
        _read(db, account, request, _now())
        db.commit()


def unread(db: Session, account: Account, request: CollaborationRequest) -> bool:
    """A message from the other side after this account last read the conversation."""
    news = [m.created_at for m in request.messages if m.author_id != account.id]
    if not news:
        return False
    seen = db.scalar(select(CollaborationRead.read_at).where(CollaborationRead.request_id == request.id,
                                                             CollaborationRead.account_id == account.id))
    return seen is None or max(news) > seen


def delete_old(db: Session) -> int:
    """Minimization: a request goes, conversation included, KEEP_DAYS after its last activity (the answer or the last
    message); one nobody answered nor wrote about goes KEEP_DAYS after it was made."""
    limit = _now() - timedelta(days=KEEP_DAYS)
    last_message = (select(func.max(CollaborationMessage.created_at))
                    .where(CollaborationMessage.request_id == CollaborationRequest.id).scalar_subquery())
    # GREATEST ignores NULL in PostgreSQL: a request without messages counts only the answer (or its own date).
    gone = db.execute(delete(CollaborationRequest).where(
        func.greatest(func.coalesce(CollaborationRequest.decided_at, CollaborationRequest.created_at), last_message) < limit))
    db.commit()
    return gone.rowcount or 0
