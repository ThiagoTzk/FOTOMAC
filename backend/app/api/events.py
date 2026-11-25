"""Operation-area event routes: /api/v1/events/*, /api/v1/themes, /api/v1/dashboard.
Every route requires a valid session: there is no public write path."""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_account
from app import parameters
from app.db.models import Account, AccountRole, DatePrecision, Event, EventStatus, Theme
from app.db.session import get_session
from app.events import collaboration, dates, service
from app.images.service import can_upload
from app.parameters import new_expiry, retention_months
from app.storage.factory import get_storage
from app.storage.port import ObjectStorage
from app.themes import service as themes_service

router = APIRouter(tags=["events"])


class ThemeOut(BaseModel):
    id: int
    name: str
    icon: str


class PersonOut(BaseModel):
    id: uuid.UUID
    full_name: str
    team: str | None = None   # "Equipe de marketing" when the event was created by the marketing team


class CollaboratorOut(BaseModel):
    signature: str
    photos: int


class RequestOut(BaseModel):
    """A collaboration request (01/11/2026): to send photos and/or to accept RAW files, with the two optional texts."""
    id: uuid.UUID
    status: str                  # pending | accepted | declined | cancelled
    wants_upload: bool
    wants_raw: bool
    message: str | None
    reply: str | None
    raw_turned_on: bool
    created_at: datetime
    decided_at: datetime | None
    requester_id: uuid.UUID
    requester_name: str
    requester_role: str
    requester_signature: str | None
    decider_name: str | None
    seen: bool                   # the requester has read the answer
    messages: int                # the conversation (01/11/2026)
    unread: bool                 # a message from the other side not read yet by this account
    can_chat: bool               # this account takes part in the conversation


def _request(db: Session, account: Account, r) -> RequestOut:
    from app.accounts.service import ROLE_LABEL
    talks = collaboration.participant(account, r)
    return RequestOut(id=r.id, status=r.status, wants_upload=r.wants_upload, wants_raw=r.wants_raw, message=r.message,
                      reply=r.reply, raw_turned_on=r.raw_turned_on, created_at=r.created_at, decided_at=r.decided_at,
                      requester_id=r.requester_id, requester_name=r.requester.full_name,
                      requester_role=ROLE_LABEL[r.requester.role], requester_signature=r.requester.photographer_signature,
                      decider_name=r.decider.full_name if r.decider else None, seen=r.requester_seen_at is not None,
                      messages=len(r.messages), unread=talks and collaboration.unread(db, account, r), can_chat=talks)


class ChatItemOut(BaseModel):
    """One line of the conversation: the request itself, the answer (or the cancellation) and each message."""
    kind: str                    # request | answer | cancelled | message
    author_name: str
    mine: bool
    text: str | None             # what was written (the request's message, the reply or the message)
    note: str | None             # what happened, for request / answer / cancelled
    created_at: datetime


class ChatOut(BaseModel):
    items: list[ChatItemOut]
    closed: str | None           # why this account can only read it now


def _asked(r) -> str:
    return ("enviar imagens e usar arquivos RAW" if r.wants_upload and r.wants_raw
            else "enviar imagens" if r.wants_upload else "aceitar arquivos RAW")


def _chat(account: Account, r) -> ChatOut:
    def item(kind, author, text, note, when):
        mine = author is not None and author.id == account.id
        return ChatItemOut(kind=kind, author_name="Você" if mine else (author.full_name if author else "Conta removida"),
                           mine=mine, text=text, note=note, created_at=when)
    items = [item("request", r.requester, r.message, f"pediu para {_asked(r)}", r.created_at)]
    if r.status in ("accepted", "declined") and r.decided_at:
        note = "aceitou o pedido" if r.status == "accepted" else "recusou o pedido"
        if r.raw_turned_on:
            note += " e ligou os arquivos RAW"
        items.append(item("answer", r.decider, r.reply, note, r.decided_at))
    elif r.status == "cancelled" and r.decided_at:
        items.append(item("cancelled", r.requester, None, "cancelou o pedido", r.decided_at))
    items += [item("message", m.author, m.body, None, m.created_at) for m in r.messages]
    return ChatOut(items=sorted(items, key=lambda i: i.created_at), closed=collaboration.closed_reason(account, r))


class EventOut(BaseModel):
    id: uuid.UUID
    name: str
    date_precision: str
    date_start: date
    date_end: date
    date_label: str
    location: str
    description: str
    postal_code: str | None
    latitude: float | None
    longitude: float | None
    location_note: str | None
    can_edit_map: bool              # the map belongs to who created the event (service.can_edit_map)
    themes: list[ThemeOut]
    status: str
    collaboration_open: bool
    expires_on: date
    owner: PersonOut
    relation: str          # owner | collaborator | admin | contractor | viewer (marketing, published only) | outsider
    can_manage: bool
    photos: int
    published: int
    collaborators: list[CollaboratorOut]
    approvals_pending: int         # photos of a hired photographer awaiting the administrator
    failed: int                    # published photos whose face processing failed ("Falha")
    removals: int                  # photos and videos someone asked to remove (team only)
    videos_ready: int              # videos converted and not published yet (team only)
    video_approvals_pending: int   # videos of a hired photographer awaiting the administrator
    cover_version: str | None      # changes with the cover (cache); None = the event has no cover
    raw_enabled: bool              # the event accepts camera RAW files (its own switch)
    has_children: bool             # "Este evento contém imagens com crianças" (04/11/2026)
    children_authorization_ref: str | None   # where the guardians' signed terms are (team only)
    children_declared_by: str | None         # who declared the authorisation, and when
    children_declared_at: datetime | None
    can_upload: bool               # this account may send photos to the event now
    access_blocked: bool           # this account's access was turned off in "Configuração do evento"
    deletion_due_at: datetime | None  # "Excluir evento": eliminated at this moment unless undone
    deletion_grace_days: int          # how long a deletion can be undone (parameter, shown before confirming)
    ask_upload: bool                  # this account may ask the responsible to send photos here
    ask_raw: bool                     # ... or to accept RAW files here
    my_request: RequestOut | None     # this account's latest request on the event
    requests_waiting: int             # for whoever manages the event: requests to answer


class EventPage(BaseModel):
    items: list[EventOut]
    total: int
    page: int
    page_size: int


def _out(db: Session, account: Account, event: Event, stats: service.EventStats, working: bool | None = None,
         waiting: int | None = None) -> EventOut:
    if working is None:
        working = bool(service.working_on(db, account, [event.id]))
    relation = service.relation(account, event, bool(service.has_uploaded(db, account, [event.id])), working)
    if relation in ("viewer", "outsider"):  # the published count only: not how many are still under review
        stats = service.EventStats(photos=stats.published, published=stats.published)
    manages = service.can_manage(account, event)
    can_ask = collaboration.options(account, event)
    mine = collaboration.latest_of(db, account, event) if (can_ask["upload"] or can_ask["raw"] or not manages) else None
    if waiting is None and manages:
        waiting = collaboration.waiting(db, [event.id]).get(event.id, 0)
    return EventOut(
        id=event.id, name=event.name, date_precision=event.date_precision.value,
        date_start=event.date_start, date_end=event.date_end,
        date_label=dates.label(event.date_precision, event.date_start, event.date_end),
        location=event.location, description=event.description, postal_code=event.postal_code,
        latitude=event.latitude, longitude=event.longitude, location_note=event.location_note,
        can_edit_map=service.can_edit_map(account, event),
        themes=[ThemeOut(id=t.id, name=t.name, icon=t.icon) for t in sorted(event.themes, key=lambda t: t.name)],
        status=event.status.value, collaboration_open=event.collaboration_open, expires_on=event.expires_on,
        owner=PersonOut(id=event.owner.id, full_name=event.owner.full_name,
                        team="Equipe de marketing" if event.owner.role == AccountRole.MARKETING else None),
        relation=relation, can_manage=manages,
        photos=stats.photos, published=stats.published,
        collaborators=[CollaboratorOut(signature=s, photos=n) for s, n in sorted(stats.by_photographer.items())],
        approvals_pending=stats.approvals_pending, failed=stats.failed,
        removals=stats.removals, videos_ready=stats.videos_ready, video_approvals_pending=stats.video_approvals,   # zero for viewer/outsider (stats reset above)
        cover_version=event.updated_at.strftime("%Y%m%d%H%M%S") if event.cover_object_key else None,
        deletion_due_at=event.deletion_due_at, raw_enabled=event.raw_enabled, has_children=event.has_children,
        children_authorization_ref=event.children_authorization_ref if relation != "outsider" else None,
        children_declared_by=_name(db, event.children_declared_by) if relation != "outsider" else None,
        children_declared_at=event.children_declared_at if relation != "outsider" else None,
        can_upload=can_upload(account, event), access_blocked=event.blocks(account.id),
        deletion_grace_days=int(parameters.get(db, "event_deletion_days")),
        ask_upload=can_ask["upload"], ask_raw=can_ask["raw"], my_request=_request(db, account, mine) if mine else None,
        requests_waiting=(waiting or 0) if manages else 0)


def _name(db: Session, account_id: uuid.UUID | None) -> str | None:
    account = db.get(Account, account_id) if account_id else None
    return account.full_name if account else None


def _event_input(name, theme_ids, date_precision, date_start, date_end, location, description,
                 raw_enabled: bool | None = False, postal_code: str | None = None, latitude: float | None = None,
                 longitude: float | None = None, location_note: str | None = None, has_children: bool | None = None,
                 children_reference: str | None = None, children_declared: bool = False) -> service.EventInput:
    try:
        precision = DatePrecision(date_precision)
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tipo de data inválido.") from None
    return service.EventInput(name=name, theme_ids=theme_ids, date_precision=precision, date_start=date_start,
                              date_end=date_end, location=location, description=description,
                              raw_enabled=raw_enabled, postal_code=postal_code, latitude=latitude,
                              longitude=longitude, location_note=location_note, has_children=has_children,
                              children_reference=children_reference, children_declared=children_declared)


async def _read_cover(cover: UploadFile | None) -> bytes | None:
    if cover is None or not cover.filename:
        return None
    data = await cover.read(service.MAX_COVER_BYTES + 1)
    return data


def _error(exc: service.EventError) -> HTTPException:
    code = (status.HTTP_404_NOT_FOUND if isinstance(exc, service.NotFound)
            else status.HTTP_403_FORBIDDEN if isinstance(exc, service.PermissionDenied)
            else status.HTTP_400_BAD_REQUEST)
    return HTTPException(code, str(exc))


@router.get("/themes", response_model=list[ThemeOut])
def list_themes(_: Account = Depends(current_account), db: Session = Depends(get_session)):
    """Active themes only: inactive ones are no longer offered."""
    return [ThemeOut(id=t.id, name=t.name, icon=t.icon)
            for t in db.scalars(select(Theme).where(Theme.active.is_(True)).order_by(Theme.name))]


class NewThemeIn(BaseModel):
    name: str = Field(max_length=200)
    icon: str | None = Field(None, max_length=40)


@router.post("/themes", response_model=ThemeOut, status_code=status.HTTP_201_CREATED)
def create_theme(body: NewThemeIn, account: Account = Depends(current_account), db: Session = Depends(get_session)):
    """A new theme (tag), created on the Temas screen or while filling in an event, by any team account
    (administrator, photographer, marketing) with the symbol they chose; the creator owns it (RF027).
    It is shared by every event and becomes a public filter."""
    try:
        theme = themes_service.create(db, account, body.name, body.icon)
    except service.EventError as exc:
        raise _error(exc) from None
    return ThemeOut(id=theme.id, name=theme.name, icon=theme.icon)


@router.get("/dashboard")
def dashboard(account: Account = Depends(current_account), db: Session = Depends(get_session)):
    return service.dashboard(db, account)


@router.get("/notifications")
def notifications(account: Account = Depends(current_account), db: Session = Depends(get_session)):
    """The panel's bell: what needs this account's attention now (computed, never stored), newest first.
    "unseen" lights the bell's counter: the notices that appeared after the person last opened it."""
    from app.events.notifications import for_account, mark_dismissed, unseen
    items = mark_dismissed(db, account, for_account(db, account))
    return {"items": sorted(items, key=lambda n: n["since"], reverse=True),
            "urgent": sum(1 for n in items if n["urgent"]), "unseen": unseen(items, account.notices_seen_at)}


class DismissIn(BaseModel):
    key: str = Field(min_length=1, max_length=400)


@router.post("/notifications/dismiss", status_code=status.HTTP_204_NO_CONTENT)
def notifications_dismiss(body: DismissIn, account: Account = Depends(current_account), db: Session = Depends(get_session)):
    """Removes one notice from this account's bell (08/11/2026). The overview keeps showing it; it comes back to the
    bell when something new happens behind it."""
    from app.events.notifications import dismiss
    if not dismiss(db, account, body.key):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Este aviso não existe mais.")


@router.post("/notifications/seen", status_code=status.HTTP_204_NO_CONTENT)
def notifications_seen(account: Account = Depends(current_account), db: Session = Depends(get_session)):
    """The person opened the bell: the counter goes out until something new appears (28/10/2026). The notices
    themselves stay until their situation is solved."""
    account.notices_seen_at = datetime.now(timezone.utc)
    db.commit()


@router.get("/events", response_model=EventPage)
def list_events(q: str | None = Query(None, max_length=150), theme_id: int | None = None,
                status_: str | None = Query(None, alias="status"), period_start: date | None = None,
                period_end: date | None = None, scope: str = Query("all", pattern="^(all|mine|collaborations|enabled)$"),
                page: int = Query(1, ge=1),
                account: Account = Depends(current_account), db: Session = Depends(get_session)):
    try:
        event_status = EventStatus(status_) if status_ else None
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Status inválido.") from None
    items, total = service.list_events(db, account, q=q, theme_id=theme_id, status=event_status,
                                       period_start=period_start, period_end=period_end, scope=scope, page=page)
    ids = [e.id for e in items]
    stats, working, waiting = service.stats_for(db, ids), service.working_on(db, account, ids), collaboration.waiting(db, ids)
    return EventPage(items=[_out(db, account, e, stats[e.id], e.id in working, waiting.get(e.id, 0)) for e in items],
                     total=total,
                     page=page, page_size=service.PAGE_SIZE)


@router.get("/events/expiry-preview")
def expiry_preview(date_precision: str, date_start: date, date_end: date | None = None,
                   _: Account = Depends(current_account), db: Session = Depends(get_session)):
    """Lets the edit screen show the NEW expiry date before saving."""
    try:
        start, end = dates.normalize(DatePrecision(date_precision), date_start, date_end)
    except (ValueError, dates.EventDateError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc) or "Data inválida.") from None
    months = retention_months(db)
    return {"expires_on": new_expiry(end, months, date.today()), "retention_months": months,
            "date_label": dates.label(DatePrecision(date_precision), start, end)}


@router.post("/events", response_model=EventOut, status_code=status.HTTP_201_CREATED)
async def create_event(name: str = Form(...), theme_ids: list[int] = Form(...), date_precision: str = Form(...),
                       date_start: date = Form(...), date_end: date | None = Form(None),
                       location: str = Form(...), description: str = Form(...),
                       raw_enabled: bool = Form(False), postal_code: str | None = Form(None),
                       latitude: float | None = Form(None), longitude: float | None = Form(None),
                       location_note: str | None = Form(None), has_children: bool = Form(False),
                       children_reference: str | None = Form(None), children_declared: bool = Form(False),
                       cover: UploadFile | None = File(None),
                       account: Account = Depends(current_account), db: Session = Depends(get_session),
                       storage: ObjectStorage = Depends(get_storage)):
    data = _event_input(name, theme_ids, date_precision, date_start, date_end, location, description, raw_enabled,
                        postal_code, latitude, longitude, location_note, has_children, children_reference,
                        children_declared)
    try:
        event = service.create_event(db, storage, account, data, await _read_cover(cover))
    except service.EventError as exc:
        raise _error(exc) from None
    return _out(db, account, event, service.stats_for(db, [event.id])[event.id])


@router.get("/events/{event_id}", response_model=EventOut)
def get_event(event_id: uuid.UUID, account: Account = Depends(current_account), db: Session = Depends(get_session)):
    try:
        event = service.get_listed(db, account, event_id)   # an outsider gets the summary ("relation": "outsider")
    except service.EventError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from None
    return _out(db, account, event, service.stats_for(db, [event.id])[event.id])


@router.put("/events/{event_id}", response_model=EventOut)
async def update_event(event_id: uuid.UUID, name: str = Form(...), theme_ids: list[int] = Form(...),
                       date_precision: str = Form(...), date_start: date = Form(...),
                       date_end: date | None = Form(None), location: str = Form(...),
                       description: str = Form(...), raw_enabled: bool | None = Form(None),
                       postal_code: str | None = Form(None), latitude: float | None = Form(None),
                       longitude: float | None = Form(None), location_note: str | None = Form(None),
                       cover: UploadFile | None = File(None),
                       account: Account = Depends(current_account), db: Session = Depends(get_session),
                       storage: ObjectStorage = Depends(get_storage)):
    # raw_enabled is left out by the edit screen (it lives in "Configuração do evento"); sent, it still works.
    # The map is replaced like the other fields: left out, it is cleared (the edit screen always sends it).
    data = _event_input(name, theme_ids, date_precision, date_start, date_end, location, description, raw_enabled,
                        postal_code, latitude, longitude, location_note)
    try:
        event = service.get_visible(db, account, event_id)
        event = service.update_event(db, storage, account, event, data, await _read_cover(cover))
    except service.EventError as exc:
        raise _error(exc) from None
    return _out(db, account, event, service.stats_for(db, [event.id])[event.id])


class CollaborationIn(BaseModel):
    open: bool


@router.post("/events/{event_id}/deletion", response_model=EventOut)
def request_deletion(event_id: uuid.UUID, account: Account = Depends(current_account), db: Session = Depends(get_session)):
    """Leaves the public area and erases the face vectors now; the photos wait the grace period."""
    from app.events import deletion
    try:
        event = deletion.request_deletion(db, account, service.get_visible(db, account, event_id))
    except service.EventError as exc:
        raise _error(exc) from None
    return _out(db, account, event, service.stats_for(db, [event.id])[event.id])


@router.delete("/events/{event_id}/deletion", response_model=EventOut)
def cancel_deletion(event_id: uuid.UUID, account: Account = Depends(current_account), db: Session = Depends(get_session)):
    from app.events import deletion
    try:
        event = deletion.cancel_deletion(db, account, service.get_visible(db, account, event_id))
    except service.EventError as exc:
        raise _error(exc) from None
    return _out(db, account, event, service.stats_for(db, [event.id])[event.id])


@router.put("/events/{event_id}/collaboration", response_model=EventOut)
def set_collaboration(event_id: uuid.UUID, body: CollaborationIn, account: Account = Depends(current_account),
                      db: Session = Depends(get_session)):
    try:
        event = service.set_collaboration(db, account, service.get_visible(db, account, event_id), body.open)
    except service.EventError as exc:
        raise _error(exc) from None
    return _out(db, account, event, service.stats_for(db, [event.id])[event.id])


class RawIn(BaseModel):
    enabled: bool


@router.put("/events/{event_id}/raw", response_model=EventOut)
def set_raw(event_id: uuid.UUID, body: RawIn, account: Account = Depends(current_account),
            db: Session = Depends(get_session)):
    try:
        event = service.set_raw(db, account, service.get_visible(db, account, event_id), body.enabled)
    except service.EventError as exc:
        raise _error(exc) from None
    return _out(db, account, event, service.stats_for(db, [event.id])[event.id])


class ChildrenIn(BaseModel):
    enabled: bool
    reference: str | None = Field(default=None, max_length=300)
    declared: bool = False


@router.put("/events/{event_id}/children", response_model=EventOut)
def set_children(event_id: uuid.UUID, body: ChildrenIn, account: Account = Depends(current_account),
                 db: Session = Depends(get_session)):
    """"Este evento contém imagens com crianças": on only with the declaration of the guardians' authorisation."""
    try:
        event = service.set_children(db, account, service.get_visible(db, account, event_id), body.enabled,
                                     body.reference, body.declared)
    except service.EventError as exc:
        raise _error(exc) from None
    return _out(db, account, event, service.stats_for(db, [event.id])[event.id])


class MemberOut(BaseModel):
    account_id: uuid.UUID
    full_name: str
    signature: str | None
    role_label: str
    photos: int
    owner: bool
    allowed: bool


def _member(m: service.Member) -> MemberOut:
    from app.accounts.service import ROLE_LABEL
    return MemberOut(account_id=m.account.id, full_name=m.account.full_name, signature=m.account.photographer_signature,
                     role_label=ROLE_LABEL[m.account.role], photos=m.photos, owner=m.owner, allowed=not m.blocked)


@router.get("/events/{event_id}/members", response_model=list[MemberOut])
def list_members(event_id: uuid.UUID, account: Account = Depends(current_account), db: Session = Depends(get_session)):
    """Who works on the event — for whoever manages it ("Configuração do evento")."""
    try:
        event = service.get_visible(db, account, event_id)
    except service.EventError as exc:
        raise _error(exc) from None
    if not service.can_manage(account, event):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Somente o fotógrafo responsável vê quem trabalha no evento.")
    return [_member(m) for m in service.members(db, event)]


class AccessIn(BaseModel):
    allowed: bool


@router.put("/events/{event_id}/members/{account_id}", response_model=MemberOut)
def set_member_access(event_id: uuid.UUID, account_id: uuid.UUID, body: AccessIn,
                      account: Account = Depends(current_account), db: Session = Depends(get_session)):
    try:
        event = service.get_visible(db, account, event_id)
        return _member(service.set_member_access(db, account, event, account_id, body.allowed))
    except service.EventError as exc:
        raise _error(exc) from None


@router.get("/events/{event_id}/cover")
def event_cover(event_id: uuid.UUID, account: Account = Depends(current_account), db: Session = Depends(get_session),
                storage: ObjectStorage = Depends(get_storage)):
    """The cover, served by the API (the storage address never reaches the browser). Also for an event only found in
    the list: the cover identifies the event, as on the public site."""
    try:
        event = service.get_listed(db, account, event_id)
    except service.EventError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from None
    if not event.cover_object_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Evento sem capa.")
    return Response(storage.get(event.cover_object_key), media_type="image/jpeg",
                    headers={"Cache-Control": "private, max-age=300"})


# ------------------------------------------------------------------ collaboration requests (01/11/2026)

class AskIn(BaseModel):
    wants_upload: bool = False
    wants_raw: bool = False
    message: str | None = Field(None, max_length=collaboration.MESSAGE_MAX)


class ChatIn(BaseModel):
    body: str = Field(max_length=collaboration.CHAT_MAX)


class DecisionIn(BaseModel):
    accept: bool
    reply: str | None = Field(None, max_length=collaboration.MESSAGE_MAX)
    turn_raw_on: bool = False


@router.get("/events/{event_id}/collaboration-requests", response_model=list[RequestOut])
def list_requests(event_id: uuid.UUID, account: Account = Depends(current_account), db: Session = Depends(get_session)):
    """For whoever manages the event: the requests to answer, then the answered ones still kept."""
    try:
        event = service.get_visible(db, account, event_id)
    except service.EventError as exc:
        raise _error(exc) from None
    if not service.can_manage(account, event):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Somente o responsável pelo evento vê os pedidos.")
    return [_request(db, account, r) for r in collaboration.for_event(db, event)]


@router.post("/events/{event_id}/collaboration-requests", response_model=EventOut, status_code=status.HTTP_201_CREATED)
def ask(event_id: uuid.UUID, body: AskIn, account: Account = Depends(current_account), db: Session = Depends(get_session)):
    try:
        event = service.get_listed(db, account, event_id)
        collaboration.ask(db, account, event, wants_upload=body.wants_upload, wants_raw=body.wants_raw,
                          message=body.message)
    except service.EventError as exc:
        raise _error(exc) from None
    return _out(db, account, event, service.stats_for(db, [event.id])[event.id])


@router.delete("/events/{event_id}/collaboration-requests/{request_id}", response_model=EventOut)
def cancel_request(event_id: uuid.UUID, request_id: uuid.UUID, account: Account = Depends(current_account),
                   db: Session = Depends(get_session)):
    try:
        event = service.get_listed(db, account, event_id)
        collaboration.cancel(db, account, collaboration.get(db, event, request_id))
    except service.EventError as exc:
        raise _error(exc) from None
    return _out(db, account, event, service.stats_for(db, [event.id])[event.id])


@router.post("/events/{event_id}/collaboration-requests/{request_id}/decision", response_model=RequestOut)
def decide_request(event_id: uuid.UUID, request_id: uuid.UUID, body: DecisionIn,
                   account: Account = Depends(current_account), db: Session = Depends(get_session)):
    try:
        event = service.get_visible(db, account, event_id)
        request = collaboration.decide(db, account, collaboration.get(db, event, request_id), accept=body.accept,
                                       reply=body.reply, turn_raw_on=body.turn_raw_on)
    except service.EventError as exc:
        raise _error(exc) from None
    return _request(db, account, request)


@router.post("/events/{event_id}/collaboration-requests/{request_id}/seen", status_code=status.HTTP_204_NO_CONTENT)
def request_seen(event_id: uuid.UUID, request_id: uuid.UUID, account: Account = Depends(current_account),
                 db: Session = Depends(get_session)):
    """The requester opened the event and read the answer: the bell stops telling about it."""
    try:
        event = service.get_listed(db, account, event_id)
        collaboration.mark_seen(db, account, collaboration.get(db, event, request_id))
    except service.EventError as exc:
        raise _error(exc) from None


def _talk(db: Session, account: Account, event_id: uuid.UUID, request_id: uuid.UUID):
    """The request, for one of its participants only; anyone else gets the same answer as "does not exist"."""
    request = collaboration.get(db, service.get_listed(db, account, event_id), request_id)
    if not collaboration.participant(account, request):
        raise service.NotFound("Pedido não encontrado.")
    return request


@router.get("/events/{event_id}/collaboration-requests/{request_id}/messages", response_model=ChatOut)
def chat(event_id: uuid.UUID, request_id: uuid.UUID, account: Account = Depends(current_account),
         db: Session = Depends(get_session)):
    try:
        return _chat(account, _talk(db, account, event_id, request_id))
    except service.EventError as exc:
        raise _error(exc) from None


@router.post("/events/{event_id}/collaboration-requests/{request_id}/messages", response_model=ChatOut,
             status_code=status.HTTP_201_CREATED)
def write_message(event_id: uuid.UUID, request_id: uuid.UUID, body: ChatIn, account: Account = Depends(current_account),
                  db: Session = Depends(get_session)):
    try:
        request = _talk(db, account, event_id, request_id)
        collaboration.write(db, account, request, body.body)
    except service.EventError as exc:
        raise _error(exc) from None
    return _chat(account, request)


@router.post("/events/{event_id}/collaboration-requests/{request_id}/read", status_code=status.HTTP_204_NO_CONTENT)
def chat_read(event_id: uuid.UUID, request_id: uuid.UUID, account: Account = Depends(current_account),
              db: Session = Depends(get_session)):
    """The conversation is open on the screen: the bell stops telling about its messages."""
    try:
        collaboration.mark_read(db, account, _talk(db, account, event_id, request_id))
    except service.EventError as exc:
        raise _error(exc) from None
