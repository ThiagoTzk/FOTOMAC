"""Support page (28/10/2026): someone of the team tells the administration about a problem, a suggestion or a
question ("quando tento fazer X no evento, não funciona").

Since 31/10/2026 (user test) it is a conversation: not every problem is solved at once, so the administration
moves it through "Em análise" and "Em correção" before "Resolvida", and both sides write to each other in the
meantime; the bell tells each side what the other did. An account that was suspended or whose time ended also
writes here (kind "access"), from the restricted screen, to ask to come back.

The messages may carry personal data written by the person, so they are kept only while useful: a solved
conversation is deleted KEEP_DAYS after it was solved (period to be confirmed by the legal department), with all its
entries, and every conversation goes with its account. The audit log records who did what, never the text.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app import audit
from app.db.models import Account, SupportEntry, SupportMessage

KINDS = {"problem": "Problema", "suggestion": "Sugestão", "question": "Dúvida", "access": "Acesso à conta"}
STATUS = {"open": "Aberta", "analyzing": "Em análise", "fixing": "Em correção", "resolved": "Resolvida"}
KEEP_DAYS = 90   # decided by the author on 31/10/2026 (it was 180); the legal department confirms


class SupportError(Exception):
    pass


class NotFound(SupportError):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _clean(text: str | None, limit: int, what: str, required: bool = True) -> str | None:
    text = " ".join((text or "").split()) if what in ("subject", "page") else (text or "").strip()
    if required and not text:
        raise SupportError({"subject": "Escreva o assunto.", "message": "Descreva o que aconteceu.",
                            "reply": "Escreva a mensagem."}[what])
    if len(text) > limit:
        field = {"subject": "No assunto", "message": "Na mensagem", "page": "No local", "reply": "Na mensagem"}[what]
        raise SupportError(f"{field}, use no máximo {limit} caracteres.")
    return text or None


def send(db: Session, account: Account, kind: str, subject: str, message: str, page: str | None) -> SupportMessage:
    if kind not in KINDS:
        raise SupportError("Escolha o tipo: problema, sugestão, dúvida ou acesso à conta.")
    now = _now()
    row = SupportMessage(account_id=account.id, kind=kind, subject=_clean(subject, 120, "subject"),
                         message=_clean(message, 3000, "message"), page=_clean(page, 200, "page", required=False),
                         last_entry_at=now, requester_seen_at=now)
    db.add(row)
    db.flush()
    audit.record(db, "support.sent", account.id, "support_message", row.id, kind=kind)   # never the text itself
    db.commit()
    return row


def mine(db: Session, account: Account) -> list[SupportMessage]:
    return list(db.scalars(select(SupportMessage).where(SupportMessage.account_id == account.id)
                           .order_by(SupportMessage.last_entry_at.desc())))


def all_messages(db: Session, status: str | None) -> list[SupportMessage]:
    """status: one of STATUS, "active" (everything not solved yet) or None (all)."""
    q = select(SupportMessage).order_by(SupportMessage.last_entry_at.desc())
    if status == "active":
        q = q.where(SupportMessage.status != "resolved")
    elif status:
        q = q.where(SupportMessage.status == status)
    return list(db.scalars(q))


def _get(db: Session, message_id: uuid.UUID, requester: Account | None = None) -> SupportMessage:
    row = db.get(SupportMessage, message_id)
    # The person only reaches their own conversations (the same answer as "does not exist").
    if row is None or (requester is not None and row.account_id != requester.id):
        raise NotFound("Mensagem não encontrada.")
    return row


def reply(db: Session, author: Account, message_id: uuid.UUID, body: str, as_admin: bool) -> SupportMessage:
    row = _get(db, message_id, None if as_admin else author)
    if row.status == "resolved" and not as_admin:
        raise SupportError("Esta conversa foi encerrada. Se o problema voltar, envie uma nova mensagem.")
    now = _now()
    row.entries.append(SupportEntry(author_id=author.id, from_admin=as_admin, body=_clean(body, 2000, "reply"),
                                    created_at=now))
    row.last_entry_at = now
    if as_admin:
        row.admin_seen_at = now
    else:
        row.requester_seen_at = now
    audit.record(db, "support.reply", author.id, "support_message", row.id, admin=as_admin)
    db.commit()
    return row


def set_status(db: Session, admin: Account, message_id: uuid.UUID, status: str, note: str | None) -> SupportMessage:
    """The administration moves the conversation (also back: a solved one may reopen). An optional note goes with it."""
    if status not in STATUS:
        raise SupportError("Situação inválida.")
    row = _get(db, message_id)
    if status == row.status:
        raise SupportError(f"A mensagem já está “{STATUS[status]}”.")
    now = _now()
    row.entries.append(SupportEntry(author_id=admin.id, from_admin=True, status=status,
                                    body=_clean(note, 2000, "reply", required=False), created_at=now))
    row.status = status
    row.resolved_at, row.resolved_by = (now, admin.id) if status == "resolved" else (None, None)
    row.last_entry_at = row.admin_seen_at = now
    audit.record(db, "support.status", admin.id, "support_message", row.id, status=status)
    db.commit()
    return row


def mark_seen(db: Session, account: Account, message_id: uuid.UUID, as_admin: bool) -> None:
    row = _get(db, message_id, None if as_admin else account)
    if as_admin:
        row.admin_seen_at = _now()
    else:
        row.requester_seen_at = _now()
    db.commit()


def unread(row: SupportMessage, for_admin: bool) -> bool:
    """Something the OTHER side did after this side last read the conversation."""
    seen = row.admin_seen_at if for_admin else row.requester_seen_at
    news = [e.created_at for e in row.entries if e.from_admin != for_admin]
    if for_admin:
        news.append(row.created_at)   # the first message itself
    return bool(news) and (seen is None or max(news) > seen)


def delete_old(db: Session) -> int:
    """Minimization: a solved conversation does not stay forever (its entries go with it)."""
    limit = _now() - timedelta(days=KEEP_DAYS)
    gone = db.execute(delete(SupportMessage).where(SupportMessage.status == "resolved", SupportMessage.resolved_at < limit))
    db.commit()
    return gone.rowcount or 0
