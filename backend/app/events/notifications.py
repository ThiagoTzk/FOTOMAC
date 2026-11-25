"""What needs the attention of THIS account: the bell of the panel and the "Avisos" card of the
overview (17/10/2026).

Computed from the data on every request. Only the person's own "dismiss" of a notice in the bell is stored
(08/11/2026, NoticeDismissal). A notice disappears by itself when the
situation is solved (there is no "mark as read" to forget, and no new record about people is kept).
Each notice says what happened, in which event, and where to act, and since when ("since": the latest
change behind it — a new photo waiting moves it up). The bell lists the newest first and its counter shows
the notices that appeared after the person last opened it (28/10/2026); the overview keeps them by importance.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import (Account, AccountRole, AccountStatus, AuditLog, CollaborationRequest, Event, EventStatus, Image,
                           ImageIndexingStatus, ImageReviewStatus, NoticeDismissal, SupportMessage, Video)
from app.events import collaboration
from app.events.service import videos_ready_to_publish
from app.parameters import NOTICE_DAYS
from app.public.service import REMOVAL_HOURS
from app.security.atypical import ACTION as ATYPICAL


@dataclass
class Notice:
    kind: str          # removal | video_removal | videos_ready | deletion | approval | video_approval | failed | expiring | ready | processing | own_pending | own_rejected | support
                       # | collab_request | collab_answer | collab_chat | atypical
    tone: str          # danger | warning | info
    urgent: bool
    title: str
    description: str
    href: str
    since: datetime    # when the situation began, or last grew


def _plural(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


def _br(moment: datetime) -> str:
    return moment.astimezone().strftime("%d/%m às %H:%M")


def _day_start(day: date) -> datetime:
    return datetime.combine(day, time.min).astimezone()


def unseen(items: list[dict], seen_at: datetime | None) -> int:
    """How many notices appeared (or grew) after the person last opened the bell. A dismissed one does not count."""
    return sum(1 for n in items if not n.get("dismissed") and (seen_at is None or n["since"] > seen_at))


def key_of(n: dict) -> str:
    """Which notice it is, across requests: its kind and the screen it leads to (one per event, conversation...)."""
    return f"{n['kind']}|{n['href']}"


def mark_dismissed(db: Session, account: Account, items: list[dict]) -> list[dict]:
    """Marks the notices the person dismissed in the bell (08/11/2026). A notice comes back when something new
    happens behind it (its "since" grows: another photo waiting, another removal request). Dismissals of notices that
    no longer exist (the situation was solved) are deleted: if it happens again, it is news again."""
    rows = {d.key: d for d in db.scalars(select(NoticeDismissal).where(NoticeDismissal.account_id == account.id))}
    current = set()
    for n in items:
        n["key"] = key_of(n)
        current.add(n["key"])
        d = rows.get(n["key"])
        n["dismissed"] = d is not None and n["since"] <= d.since
    stale = [d for k, d in rows.items() if k not in current]
    for d in stale:
        db.delete(d)
    if stale:
        db.commit()
    return items


def dismiss(db: Session, account: Account, key: str) -> bool:
    """The person removes one notice from the bell. The moment kept is the notice's own (computed here, never taken
    from the request). False: no such notice now (already solved)."""
    notice = next((n for n in for_account(db, account) if key_of(n) == key), None)
    if notice is None:
        return False
    row = db.get(NoticeDismissal, (account.id, key))
    if row is None:
        db.add(NoticeDismissal(account_id=account.id, key=key, since=notice["since"]))
    else:
        row.since = notice["since"]
    db.commit()
    return True


def _support(db: Session, account: Account, now: datetime) -> list[Notice]:
    """The support page as a conversation (31/10/2026): one notice per conversation where the OTHER side did
    something not read yet — a new message or reply for the administrator; a reply or a new status for whoever
    wrote. Opening the conversation clears it."""
    from app.support.service import STATUS, unread
    admin = account.role == AccountRole.ADMIN
    q = select(SupportMessage).order_by(SupportMessage.last_entry_at.desc()).limit(50)
    if not admin:
        q = q.where(SupportMessage.account_id == account.id)
    out: list[Notice] = []
    for m in db.scalars(q):
        if not unread(m, for_admin=admin):
            continue
        theirs = [e for e in m.entries if e.from_admin != admin]
        last = theirs[-1] if theirs else None
        if admin:
            title = f"Suporte: {'nova mensagem' if last is None else 'nova resposta'} de {m.account.full_name.split()[0]}"
            when = last.created_at if last else m.created_at
        else:
            title = ("Suporte: sua mensagem está “" + STATUS[last.status] + "”" if last and last.status and not last.body
                     else "Suporte: a administração respondeu")
            when = last.created_at if last else m.last_entry_at
        out.append(Notice("support", "info", m.kind == "access" and admin, title, f"“{m.subject}”. Abra para ler.",
                          f"/suporte?conversa={m.id}", when))
    return out


def _asked(r: CollaborationRequest) -> str:
    return ("enviar imagens e usar arquivos RAW" if r.wants_upload and r.wants_raw
            else "enviar imagens" if r.wants_upload else "aceitar arquivos RAW")


def _answers(db: Session, account: Account) -> list[Notice]:
    """Collaboration requests (01/11/2026): the answer to this account's own requests, until it opens the event."""
    out: list[Notice] = []
    for r in db.scalars(select(CollaborationRequest).where(
            CollaborationRequest.requester_id == account.id, CollaborationRequest.status.in_(("accepted", "declined")),
            CollaborationRequest.requester_seen_at.is_(None))):
        who = r.decider.full_name if r.decider else "O responsável"
        ok = r.status == "accepted"
        what = "a sua participação" if r.wants_upload else "o seu pedido de arquivos RAW"
        title = f"{who} {'aceitou' if ok else 'recusou'} {what}"
        if ok and r.wants_raw and not r.raw_turned_on:
            title += " (sem ligar o RAW)"
        reply = f"“{r.reply}”" if r.reply else ("Você já pode enviar imagens." if ok and r.wants_upload else "Abra o evento para ver.")
        out.append(Notice("collab_answer", "info" if ok else "warning", False, title,
                          f"Evento {r.event.name}. {reply}", f"/eventos/{r.event_id}", r.decided_at))
    return out


def _chats(db: Session, account: Account) -> list[Notice]:
    """A new message in the conversation of a collaboration request, for each side (01/11/2026). The administrator is
    a participant only where the responsible's account is not active (collaboration.participant)."""
    talked = select(CollaborationRequest).join(Event).where(
        CollaborationRequest.messages.any(), CollaborationRequest.status != "cancelled")
    if account.role != AccountRole.ADMIN:
        talked = talked.where((CollaborationRequest.requester_id == account.id) | (Event.owner_id == account.id))
    out: list[Notice] = []
    for r in db.scalars(talked):
        if not (collaboration.participant(account, r) and collaboration.unread(db, account, r)):
            continue
        last = [m for m in r.messages if m.author_id != account.id][-1]
        who = last.author.full_name.split()[0] if last.author else "Alguém"
        body = last.body if len(last.body) <= 120 else last.body[:117] + "..."
        tab = "" if r.requester_id == account.id else "aba=configuracao&"
        out.append(Notice("collab_chat", "info", False, f"{r.event.name}: mensagem de {who}", f"“{body}”",
                          f"/eventos/{r.event_id}?{tab}conversa={r.id}", last.created_at))
    return out


def for_account(db: Session, account: Account) -> list[dict]:
    now = datetime.now(timezone.utc)
    out: list[Notice] = _support(db, account, now) + _answers(db, account) + _chats(db, account)

    if account.role == AccountRole.CONTRACTOR:  # its photos waiting
        # Its validity is no longer a notice (31/10/2026): a clock beside the bell counts it down, second by second.
        waiting, last = db.execute(select(func.count(), func.max(Image.uploaded_at)).where(
            Image.uploaded_by == account.id, Image.approval == "pending")).one()
        if waiting:
            out.append(Notice("own_pending", "info", False, f"{_plural(waiting, 'imagem aguarda', 'imagens aguardam')} aprovação",
                              "A administração revisa antes da publicação.",
                              f"/eventos/{account.bound_event_id}/imagens?filtro=pending_approval", last))
        rejected, last = db.execute(select(func.count(), func.max(Image.rejected_at)).where(
            Image.uploaded_by == account.id, Image.approval == "rejected")).one()
        if rejected:  # 22/10/2026: the sender sees the reason
            out.append(Notice("own_rejected", "danger", True,
                              f"{_plural(rejected, 'imagem recusada', 'imagens recusadas')} pela administração",
                              "Abra para ver o motivo. A imagem recusada não é publicada e é excluída em 7 dias.",
                              f"/eventos/{account.bound_event_id}/imagens?filtro=rejected", last or now))
        # 05/11/2026: its videos go through the same approval, and were missing here.
        waiting, last = db.execute(select(func.count(), func.max(Video.uploaded_at)).where(
            Video.uploaded_by == account.id, Video.approval == "pending")).one()
        if waiting:
            out.append(Notice("own_pending", "info", False, f"{_plural(waiting, 'vídeo aguarda', 'vídeos aguardam')} aprovação",
                              "A administração revisa antes da publicação.",
                              f"/eventos/{account.bound_event_id}/videos?filtro=pending_approval", last))
        rejected, last = db.execute(select(func.count(), func.max(Video.rejected_at)).where(
            Video.uploaded_by == account.id, Video.approval == "rejected")).one()
        if rejected:
            out.append(Notice("own_rejected", "danger", True,
                              f"{_plural(rejected, 'vídeo recusado', 'vídeos recusados')} pela administração",
                              "Abra para ver o motivo. O vídeo recusado não é publicado e é excluído em 7 dias.",
                              f"/eventos/{account.bound_event_id}/videos?filtro=rejected", last or now))
        return [asdict(n) for n in out]

    # The events this account answers for: all of them for the administrator, its own for the others.
    managed = select(Event).where(Event.status != EventStatus.EXPIRED)
    if account.role != AccountRole.ADMIN:
        managed = managed.where(Event.owner_id == account.id)
    events = {e.id: e for e in db.scalars(managed)}
    ids = list(events)
    if not ids:
        return [asdict(n) for n in out]

    # Someone asks to work on the event (01/11/2026). The administrator is told only where the responsible's account
    # is not active: it takes over the prerogatives then (RF003 note 5); otherwise the decision is the responsible's.
    answerable = [i for i, e in events.items()
                  if e.owner_id == account.id or e.owner.status != AccountStatus.ACTIVE]
    for r in db.scalars(select(CollaborationRequest).where(CollaborationRequest.event_id.in_(answerable),
                                                           CollaborationRequest.status == "pending")):
        first = r.requester.full_name.split()[0]
        out.append(Notice("collab_request", "warning", True, f"{events[r.event_id].name}: {first} pediu para {_asked(r)}",
                          (f"“{r.message}” " if r.message else "") + "Abra para aceitar ou recusar.",
                          f"/eventos/{r.event_id}?aba=configuracao", r.created_at))

    # Someone asked for an image to be removed: it goes automatically at the deadline.
    for event_id, n, first, last in db.execute(
            select(Image.event_id, func.count(), func.min(Image.removal_requested_at), func.max(Image.removal_requested_at))
            .where(Image.event_id.in_(ids), Image.removal_requested_at.is_not(None)).group_by(Image.event_id)):
        hours = max(0, round((first + timedelta(hours=REMOVAL_HOURS) - now).total_seconds() / 3600))
        out.append(Notice("removal", "danger", True,
                          f"{events[event_id].name}: {_plural(n, 'pedido', 'pedidos')} de remoção",
                          f"A imagem já saiu das buscas e é excluída automaticamente em até {hours} h.",
                          f"/eventos/{event_id}/imagens?filtro=removal", last))

    # The same for a video (05/11/2026): it left the searches at once and goes at the deadline.
    for event_id, n, first, last in db.execute(
            select(Video.event_id, func.count(), func.min(Video.removal_requested_at), func.max(Video.removal_requested_at))
            .where(Video.event_id.in_(ids), Video.removal_requested_at.is_not(None)).group_by(Video.event_id)):
        hours = max(0, round((first + timedelta(hours=REMOVAL_HOURS) - now).total_seconds() / 3600))
        out.append(Notice("video_removal", "danger", True,
                          f"{events[event_id].name}: {_plural(n, 'pedido', 'pedidos')} de remoção de vídeo",
                          f"O vídeo já saiu das buscas e é excluído automaticamente em até {hours} h.",
                          f"/eventos/{event_id}/videos", last))

    for e in events.values():  # "Excluir evento": the photos are eliminated at the end of the period
        if e.deletion_due_at:
            out.append(Notice("deletion", "danger", True, f"{e.name}: exclusão agendada",
                              f"Tudo é eliminado em {_br(e.deletion_due_at)}. Até lá, a exclusão pode ser desfeita.",
                              f"/eventos/{e.id}", e.deletion_requested_at or e.updated_at))

    if account.role == AccountRole.ADMIN:  # atypical use of the public search (RF024 note 5), the last 7 days
        n, last = db.execute(select(func.count(), func.max(AuditLog.occurred_at)).where(
            AuditLog.action == ATYPICAL, AuditLog.occurred_at >= now - timedelta(days=7))).one()
        if n:
            out.append(Notice("atypical", "warning", False,
                              f"Uso atípico na busca pública: {_plural(n, 'alerta', 'alertas')} em 7 dias",
                              "O bloqueio é automático. Veja quando e em qual evento em Registros.", "/registros", last))

    if account.role == AccountRole.ADMIN:  # a hired photographer's photos wait for the administrator
        for event_id, n, last in db.execute(select(Image.event_id, func.count(), func.max(Image.uploaded_at)).where(
                Image.event_id.in_(ids), Image.approval == "pending").group_by(Image.event_id)):
            out.append(Notice("approval", "warning", True,
                              f"{events[event_id].name}: {_plural(n, 'imagem aguarda', 'imagens aguardam')} aprovação",
                              "Enviadas por fotógrafo contratado. Só entram na publicação depois de aprovadas.",
                              f"/eventos/{event_id}/imagens?filtro=pending_approval", last))
        for event_id, n, last in db.execute(select(Video.event_id, func.count(), func.max(Video.uploaded_at)).where(
                Video.event_id.in_(ids), Video.approval == "pending").group_by(Video.event_id)):
            out.append(Notice("video_approval", "warning", True,
                              f"{events[event_id].name}: {_plural(n, 'vídeo aguarda', 'vídeos aguardam')} aprovação",
                              "Enviados por fotógrafo contratado. Só entram na publicação depois de aprovados.",
                              f"/eventos/{event_id}/videos?filtro=pending_approval", last))

    for event_id, n, last in db.execute(select(Image.event_id, func.count(), func.max(Image.uploaded_at)).where(
            Image.event_id.in_(ids), Image.indexing_status == ImageIndexingStatus.FAILED).group_by(Image.event_id)):
        out.append(Notice("failed", "warning", True,
                          f"{events[event_id].name}: {_plural(n, 'falha', 'falhas')} no reconhecimento facial",
                          "Essas imagens não aparecem nas buscas. Dá para reprocessar.",
                          f"/eventos/{event_id}/imagens?filtro=failed", last))

    soon = date.today() + timedelta(days=NOTICE_DAYS)  # download before the collection is eliminated
    for e in events.values():
        if not e.deletion_due_at and e.expires_on <= soon:
            out.append(Notice("expiring", "warning", True, f"{e.name}: expira em {e.expires_on.strftime('%d/%m/%Y')}",
                              "Nessa data as imagens e os dados de reconhecimento facial são eliminados. Baixe o acervo antes.",
                              f"/eventos/{e.id}/download", max(e.created_at, _day_start(e.expires_on - timedelta(days=NOTICE_DAYS)))))

    # Information only: the next step of the account's OWN events.
    own = [i for i, e in events.items() if e.owner_id == account.id and not e.deletion_due_at]
    if own:
        for event_id, n, last in db.execute(select(Image.event_id, func.count(), func.max(Image.uploaded_at)).where(
                # Same rule as the "ready" filter: neither waiting for the administrator NOR rejected (a
                # rejected photo stays in review for 7 days, visible only to its sender, and is never published).
                Image.event_id.in_(own), Image.review_status == ImageReviewStatus.IN_REVIEW,
                Image.approval.is_(None) | (Image.approval == "approved")).group_by(Image.event_id)):
            out.append(Notice("ready", "info", False,
                              f"{events[event_id].name}: {_plural(n, 'imagem pronta', 'imagens prontas')} para publicação",
                              "Confira e publique na aba Imagens.", f"/eventos/{event_id}/imagens?filtro=in_review", last))
        # Videos converted and not published (05/11/2026): the same reminder as the photos, until published.
        for event_id, n, last in db.execute(select(Video.event_id, func.count(), func.max(Video.uploaded_at)).where(
                Video.event_id.in_(own), *videos_ready_to_publish()).group_by(Video.event_id)):
            out.append(Notice("videos_ready", "info", False,
                              f"{events[event_id].name}: {_plural(n, 'vídeo pronto', 'vídeos prontos')} para publicação",
                              "Assista e publique na aba Vídeos. Só os publicados entram na busca facial.",
                              f"/eventos/{event_id}/videos", last))
        for event_id in own:
            if events[event_id].status == EventStatus.PROCESSING:
                out.append(Notice("processing", "info", False, f"{events[event_id].name}: reconhecimento facial em andamento",
                                  "O evento entra no site sozinho quando terminar.", f"/eventos/{event_id}/processamento",
                                  events[event_id].updated_at))

    order = {"danger": 0, "warning": 1, "info": 2}
    out.sort(key=lambda n: (order[n.tone], n.title))
    return [asdict(n) for n in out]
