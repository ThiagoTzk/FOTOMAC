"""Event rules — independent of HTTP."""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timezone

from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import audit, parameters
from app.db.models import (PRODUCER_ROLES, Account, AccountRole, AccountStatus, DatePrecision, Event, EventAccessBlock, EventCollaborator, EventStatus, Image,
                           ImageIndexingStatus, ImageReviewStatus, Theme, Video, VideoProcessingStatus)
from app.events import dates
from app.imaging import is_jpeg
from app.imaging_meta import strip_gps
from app.storage.port import ObjectStorage

MAX_COVER_BYTES = 25 * 1024 * 1024
PAGE_SIZE = 10   # 01/11/2026: ten per page, the newest event first


class EventError(Exception):
    """Message safe to show to the user."""


class PermissionDenied(EventError):
    pass


class NotFound(EventError):
    """Also used for events the account cannot see: the answer must not reveal that a
    private event exists."""


@dataclass
class EventInput:
    name: str
    theme_ids: list[int]
    date_precision: DatePrecision
    date_start: date
    date_end: date | None
    location: str
    description: str
    raw_enabled: bool | None = False   # None on an edit: RAW is switched in "Configuração do evento"
    # "Este evento contém imagens com crianças" (04/11/2026). None on an edit: switched in "Configuração do evento".
    has_children: bool | None = False
    children_reference: str | None = None   # where the guardians' signed terms are
    children_declared: bool = False         # "Declaro que a autorização dos responsáveis foi coletada"
    postal_code: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    location_note: str | None = None


# ------------------------------------------------------------------ permissions

def can_manage(account: Account, event: Event) -> bool:
    """Exclusive prerogatives of the responsible photographer: edit the event,
    open collaboration, publish, download the package. Always also the administrator, which
    covers the case of a suspended responsible account: the administrator takes over."""
    return account.role == AccountRole.ADMIN or event.owner_id == account.id


def can_edit_map(account: Account, event: Event) -> bool:
    """The map of the event belongs to whoever created it (01/11/2026). The administrator takes over only where that
    account is no longer active, the same rule as the collaboration requests; collaborators never edit it."""
    return event.owner_id == account.id or (account.role == AccountRole.ADMIN and event.owner.status != AccountStatus.ACTIVE)


def _visible_to(account: Account) -> Select:
    """Events an account may see in the operation area."""
    query = select(Event)
    if account.role == AccountRole.ADMIN:
        return query
    if account.role == AccountRole.CONTRACTOR:  # only the event it was hired for
        return query.where(Event.id == account.bound_event_id)
    uploaded = select(Image.event_id).where(Image.uploaded_by == account.id).union(
        select(Video.event_id).where(Video.uploaded_by == account.id))
    granted = select(EventCollaborator.event_id).where(EventCollaborator.account_id == account.id)
    seen = [Event.owner_id == account.id,
            and_(Event.collaboration_open.is_(True), Event.status != EventStatus.EXPIRED),
            Event.id.in_(uploaded), Event.id.in_(granted)]
    if account.role == AccountRole.MARKETING:  # the published collection, to choose from
        seen.append(Event.status == EventStatus.PUBLISHED)
        # A published video does not put the event on the site, so an event with videos only is reached here.
        seen.append(Event.id.in_(select(Video.event_id).where(Video.review_status == ImageReviewStatus.PUBLISHED)))
    return query.where(or_(*seen))


def _listed_to(account: Account) -> Select:
    """Events an account finds in the list (01/11/2026): photographers and marketing see EVERY active event,
    so they can ask to collaborate. Finding is not working on it: on an event outside _visible_to the account sees the
    summary only (name, date, place, cover, responsible) and never a photo; every photo route still asks _visible_to."""
    if account.role not in PRODUCER_ROLES:
        return _visible_to(account)
    working = _visible_to(account).with_only_columns(Event.id)
    return select(Event).where(or_(Event.id.in_(working),
                                   and_(Event.status != EventStatus.EXPIRED, Event.deletion_due_at.is_(None))))


def get_visible(db: Session, account: Account, event_id: uuid.UUID) -> Event:
    event = db.scalar(_visible_to(account).where(Event.id == event_id))
    if event is None:
        raise NotFound("Evento não encontrado.")
    return event


def get_listed(db: Session, account: Account, event_id: uuid.UUID) -> Event:
    """The event page and its cover: also for an event the account only found in the list."""
    event = db.scalar(_listed_to(account).where(Event.id == event_id))
    if event is None:
        raise NotFound("Evento não encontrado.")
    return event


def working_on(db: Session, account: Account, event_ids: list[uuid.UUID]) -> set[uuid.UUID]:
    """Among event_ids, the ones the account works on (or, marketing, views): the others are "outsider"."""
    if not event_ids:
        return set()
    return set(db.scalars(_visible_to(account).with_only_columns(Event.id).where(Event.id.in_(event_ids))))


def relation(account: Account, event: Event, uploaded: bool = False, working: bool = True) -> str:
    """owner | admin | contractor | collaborator | viewer | outsider. "viewer": the marketing team looking at a
    published event of someone else, with collaboration closed and no photo of theirs in it; it
    sees the published photos only and changes nothing. "outsider": an event found in the list that the account
    does not work on (working=False); summary only, and the way to ask to collaborate."""
    if event.owner_id == account.id:
        return "owner"
    if account.role == AccountRole.ADMIN:
        return "admin"
    if account.role == AccountRole.CONTRACTOR:
        return "contractor"
    if not working:
        return "outsider"
    if account.role == AccountRole.MARKETING and not event.collaboration_open and not uploaded \
            and not event.admits(account.id):
        return "viewer"
    return "collaborator"


def has_uploaded(db: Session, account: Account, event_ids: list[uuid.UUID]) -> set[uuid.UUID]:
    """The events (among event_ids) where the account has photos or videos of its own."""
    if not event_ids:
        return set()
    photos = select(Image.event_id).where(Image.uploaded_by == account.id, Image.event_id.in_(event_ids))
    videos = select(Video.event_id).where(Video.uploaded_by == account.id, Video.event_id.in_(event_ids))
    return set(db.scalars(photos.union(videos)))


# ------------------------------------------------------------------ create / edit

def _validate(db: Session, data: EventInput, current: Event | None = None) -> tuple[list[Theme], date, date]:
    name, location, description = data.name.strip(), data.location.strip(), data.description.strip()
    if not name or len(name) > 150:
        raise EventError("Informe o nome do evento (até 150 caracteres).")
    if not location or len(location) > 150:
        raise EventError("Informe o local do evento (até 150 caracteres).")
    if not description or len(description) > 300:
        raise EventError("Informe a descrição do evento (até 300 caracteres).")
    # Active themes — plus, when editing, the ones the event already has even if inactivated
    # since: they stay in the events that use them.
    kept = [t.id for t in current.themes] if current else []
    themes = db.scalars(select(Theme).where(Theme.id.in_(data.theme_ids),
                                            or_(Theme.active.is_(True), Theme.id.in_(kept)))).all()
    if not themes or len(themes) != len(set(data.theme_ids)):
        raise EventError("Selecione um ou mais temas válidos.")
    try:
        start, end = dates.normalize(data.date_precision, data.date_start, data.date_end)
    except dates.EventDateError as exc:
        raise EventError(str(exc)) from None
    return list(themes), start, end


def _store_cover(storage: ObjectStorage, event_id: uuid.UUID, cover: bytes) -> str:
    if len(cover) > MAX_COVER_BYTES:
        raise EventError("A capa deve ter no máximo 25 MB.")
    if not is_jpeg(cover):  # by binary signature, not extension
        raise EventError("A capa deve ser uma imagem JPEG.")
    key = f"covers/{event_id}/{uuid.uuid4()}.jpg"
    # The cover is the only image shown publicly without facial search: no geolocation.
    storage.put(key, strip_gps(cover), "image/jpeg")
    return key


def _map(data: EventInput) -> dict:
    """The optional place on the map, checked here: the form is only a convenience."""
    postal = re.sub(r"\D", "", data.postal_code or "") or None
    if postal and len(postal) != 8:
        raise EventError("Informe o CEP com 8 números.")
    if (data.latitude is None) != (data.longitude is None):
        raise EventError("Coloque o pin no mapa de novo.")
    if data.latitude is not None and not (-90 <= data.latitude <= 90 and -180 <= data.longitude <= 180):
        raise EventError("O pin está fora do mapa.")
    note = (data.location_note or "").strip() or None
    if note and len(note) > 300:
        raise EventError("A descrição do local deve ter no máximo 300 caracteres.")
    return {"postal_code": postal, "latitude": data.latitude, "longitude": data.longitude, "location_note": note}


def create_event(db: Session, storage: ObjectStorage, account: Account, data: EventInput,
                 cover: bytes | None) -> Event:
    if account.role not in PRODUCER_ROLES and account.role != AccountRole.ADMIN:
        raise PermissionDenied("Esta conta não cadastra eventos.")
    if cover is None:
        raise EventError("Selecione a imagem de capa do evento (JPEG).")
    themes, start, end = _validate(db, data)
    event = Event(id=uuid.uuid4(), name=data.name.strip(), date_precision=data.date_precision,
                  date_start=start, date_end=end, location=data.location.strip(),
                  description=data.description.strip(), owner_id=account.id, **_map(data),
                  raw_enabled=bool(data.raw_enabled),
                  expires_on=parameters.new_expiry(end, parameters.retention_months(db), date.today()))
    event.themes = themes
    if data.has_children:
        _declare_children(account, event, data.children_reference, data.children_declared)
    event.cover_object_key = _store_cover(storage, event.id, cover)
    db.add(event)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        storage.delete(event.cover_object_key)
        raise EventError("Já existe um evento com este nome nesta data.") from None
    audit.record(db, "event.create", account.id, "event", event.id, name=event.name)
    if event.has_children:
        audit.record(db, "event.children_declared", account.id, "event", event.id,
                     reference=event.children_authorization_ref)
    db.commit()
    return event


def _place_of(event: Event) -> dict:
    """The map in the audit history."""
    return {"postal_code": event.postal_code, "location_note": event.location_note,
            "pin": f"{event.latitude:.6f}, {event.longitude:.6f}" if event.latitude is not None else None}


def update_event(db: Session, storage: ObjectStorage, account: Account, event: Event,
                 data: EventInput, cover: bytes | None) -> Event:
    if not can_manage(account, event):
        raise PermissionDenied("Somente o fotógrafo responsável pelo evento pode editá-lo.")
    if event.status == EventStatus.EXPIRED:
        raise EventError("Este evento expirou e não pode mais ser alterado.")
    _refuse_while_deleting(event)
    themes, start, end = _validate(db, data, event)
    place = _map(data)

    before = {"name": event.name, "location": event.location, "description": event.description,
              "date": dates.label(event.date_precision, event.date_start, event.date_end),
              "themes": sorted(t.name for t in event.themes), "raw": event.raw_enabled, **_place_of(event)}
    event.name, event.location, event.description = data.name.strip(), data.location.strip(), data.description.strip()
    event.date_precision, event.date_start, event.date_end = data.date_precision, start, end
    expires_on = parameters.new_expiry(end, parameters.retention_months(db), date.today())
    if expires_on != event.expires_on:
        event.expires_on, event.expiry_notice_sent_at = expires_on, None
    event.themes = themes
    if data.raw_enabled is not None:
        event.raw_enabled = data.raw_enabled
    if can_edit_map(account, event):   # anyone else editing the event leaves the map as it is
        for field, value in place.items():
            setattr(event, field, value)
    after = {"name": event.name, "location": event.location, "description": event.description,
             "date": dates.label(event.date_precision, event.date_start, event.date_end),
             "themes": sorted(t.name for t in themes), "raw": event.raw_enabled, **_place_of(event)}

    old_cover = None
    if cover is not None:
        old_cover = event.cover_object_key
        event.cover_object_key = _store_cover(storage, event.id, cover)
        after["cover"] = "substituída"
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise EventError("Já existe um evento com este nome nesta data.") from None

    # Auditable history with the changed fields.
    changed = {k: {"de": before.get(k), "para": v} for k, v in after.items() if before.get(k) != v}
    if changed:
        audit.record(db, "event.update", account.id, "event", event.id, changes=changed)
    db.commit()
    if old_cover:
        storage.delete(old_cover)
    return event


def _refuse_while_deleting(event: Event) -> None:
    """An event with a deletion scheduled is frozen until the deletion is undone. Enforced
    here, not only by hiding buttons: a rule that lives only in the screen is no rule at all."""
    if event.deletion_due_at:
        raise EventError("Este evento está com exclusão agendada. Desfaça a exclusão para alterá-lo.")


def set_collaboration(db: Session, account: Account, event: Event, open_: bool) -> Event:
    if not can_manage(account, event):
        raise PermissionDenied("Somente o fotógrafo responsável pode liberar a colaboração.")
    _refuse_while_deleting(event)
    if event.collaboration_open != open_:
        event.collaboration_open = open_
        # Every release and suspension is recorded.
        audit.record(db, "event.collaboration_" + ("opened" if open_ else "suspended"),
                     account.id, "event", event.id)
        db.commit()
    return event


def set_raw(db: Session, account: Account, event: Event, enabled: bool) -> Event:
    """RAW on/off at any time ("Configuração do evento"). Turning it off refuses new RAW files; the ones
    already sent stay."""
    if not can_manage(account, event):
        raise PermissionDenied("Somente o fotógrafo responsável pode mudar a configuração do evento.")
    if event.status == EventStatus.EXPIRED:
        raise EventError("Este evento expirou e não pode mais ser alterado.")
    _refuse_while_deleting(event)
    if event.raw_enabled != enabled:
        event.raw_enabled = enabled
        audit.record(db, "event.raw_" + ("enabled" if enabled else "disabled"), account.id, "event", event.id)
        db.commit()
    return event


CHILDREN_REFERENCE_MAX = 300


def _declare_children(account: Account, event: Event, reference: str | None, declared: bool) -> None:
    """LGPD Art. 14, § 1: children's data with the consent of one of the parents; Art. 8, § 2: proving it is the
    controller's burden. CESMAC collects the terms (answer of 04/11/2026); the system records who declared it
    and where the signed terms are, so the declaration can be checked."""
    reference = (reference or "").strip()
    if not declared:
        raise EventError("Para marcar o evento com crianças, declare que a autorização dos responsáveis foi coletada.")
    if not reference:
        raise EventError("Informe onde estão guardados os termos de autorização dos responsáveis.")
    if len(reference) > CHILDREN_REFERENCE_MAX:
        raise EventError(f"O local dos termos deve ter no máximo {CHILDREN_REFERENCE_MAX} caracteres.")
    event.has_children = True
    event.children_authorization_ref, event.children_declared_by, event.children_declared_at = reference, account.id, _now()


def set_children(db: Session, account: Account, event: Event, enabled: bool, reference: str | None = None,
                 declared: bool = False) -> Event:
    """"Este evento contém imagens com crianças" on/off at any time ("Configuração do evento"). On, it needs the
    declaration again; off, the declaration goes with it (the audit keeps the history)."""
    if not can_manage(account, event):
        raise PermissionDenied("Somente o fotógrafo responsável pode mudar a configuração do evento.")
    if event.status == EventStatus.EXPIRED:
        raise EventError("Este evento expirou e não pode mais ser alterado.")
    _refuse_while_deleting(event)
    if enabled:
        _declare_children(account, event, reference, declared)
        audit.record(db, "event.children_declared", account.id, "event", event.id,
                     reference=event.children_authorization_ref)
    elif event.has_children:
        event.has_children = False
        event.children_authorization_ref = event.children_declared_by = event.children_declared_at = None
        audit.record(db, "event.children_removed", account.id, "event", event.id)
    db.commit()
    return event


@dataclass
class Member:
    account: Account
    photos: int
    owner: bool
    blocked: bool


def members(db: Session, event: Event) -> list[Member]:
    """Who works on the event: the responsible, whoever sent photos to it, whoever was accepted by name and the
    hired photographers bound to it. Administrators are not listed: they always have access."""
    counts = dict(db.execute(select(Image.uploaded_by, func.count()).where(Image.event_id == event.id)
                             .group_by(Image.uploaded_by)).all())
    ids = set(counts) | {event.owner_id} | {g.account_id for g in event.granted}
    ids |= set(db.scalars(select(Account.id).where(Account.role == AccountRole.CONTRACTOR,
                                                   Account.bound_event_id == event.id)))
    people = db.scalars(select(Account).where(Account.id.in_(ids))).all()
    out = [Member(a, counts.get(a.id, 0), a.id == event.owner_id, event.blocks(a.id)) for a in people
           if a.role != AccountRole.ADMIN or a.id == event.owner_id]
    return sorted(out, key=lambda m: (not m.owner, m.account.full_name.lower()))


def set_member_access(db: Session, actor: Account, event: Event, account_id: uuid.UUID, allowed: bool) -> Member:
    """Turns one person's access to the event off or back on. Off: they no longer send photos to the event
    nor change the ones they sent, which stay in the collection with their credit and data."""
    if not can_manage(actor, event):
        raise PermissionDenied("Somente o fotógrafo responsável pode mudar quem trabalha no evento.")
    _refuse_while_deleting(event)
    member = next((m for m in members(db, event) if m.account.id == account_id), None)
    if member is None:
        raise NotFound("Esta pessoa não trabalha neste evento.")
    if member.owner:
        raise EventError("O fotógrafo responsável sempre tem acesso ao evento.")
    if allowed and member.blocked:
        event.access_blocks = [b for b in event.access_blocks if b.account_id != account_id]
        audit.record(db, "event.access_restored", actor.id, "event", event.id, account_id=str(account_id))
    elif not allowed and not member.blocked:
        event.access_blocks.append(EventAccessBlock(account_id=account_id, blocked_by=actor.id))
        audit.record(db, "event.access_blocked", actor.id, "event", event.id, account_id=str(account_id))
    db.commit()
    member.blocked = not allowed
    return member


# ------------------------------------------------------------------ queries

@dataclass
class EventStats:
    photos: int = 0           # images that are part of the collection (not discarded)
    published: int = 0
    by_photographer: dict = field(default_factory=dict)
    approvals_pending: int = 0  # photos of a hired photographer awaiting the administrator
    failed: int = 0           # published photos whose face processing failed (shown beside the status, 31/10/2026)
    removals: int = 0         # photos AND videos someone asked to remove, waiting for the deadline (05/11/2026)
    videos_ready: int = 0     # videos converted and not published yet (05/11/2026: a pending task, like photos)
    video_approvals: int = 0  # videos of a hired photographer awaiting the administrator (05/11/2026)


def stats_for(db: Session, event_ids: list[uuid.UUID]) -> dict[uuid.UUID, EventStats]:
    out = {eid: EventStats() for eid in event_ids}
    if not event_ids:
        return out
    rows = db.execute(
        select(Image.event_id, Image.review_status, Account.photographer_signature, func.count())
        .join(Account, Account.id == Image.uploaded_by)
        # A rejected photo is not part of the collection either: it only waits 7 days to be eliminated.
        .where(Image.event_id.in_(event_ids), Image.review_status != ImageReviewStatus.DISCARDED,
               Image.approval.is_distinct_from("rejected"))
        .group_by(Image.event_id, Image.review_status, Account.photographer_signature)).all()
    for event_id, status, signature, n in rows:
        s = out[event_id]
        s.photos += n
        if status == ImageReviewStatus.PUBLISHED:
            s.published += n
        s.by_photographer[signature] = s.by_photographer.get(signature, 0) + n
    for event_id, n in db.execute(select(Image.event_id, func.count()).where(
            Image.event_id.in_(event_ids), Image.approval == "pending").group_by(Image.event_id)):
        out[event_id].approvals_pending = n
    for event_id, n in db.execute(select(Image.event_id, func.count()).where(
            Image.event_id.in_(event_ids), Image.review_status == ImageReviewStatus.PUBLISHED,
            Image.indexing_status == ImageIndexingStatus.FAILED).group_by(Image.event_id)):
        out[event_id].failed = n
    for model in (Image, Video):
        for event_id, n in db.execute(select(model.event_id, func.count()).where(
                model.event_id.in_(event_ids), model.removal_requested_at.is_not(None)).group_by(model.event_id)):
            out[event_id].removals += n
    for event_id, n in db.execute(select(Video.event_id, func.count()).where(
            Video.event_id.in_(event_ids), *videos_ready_to_publish()).group_by(Video.event_id)):
        out[event_id].videos_ready = n
    for event_id, n in db.execute(select(Video.event_id, func.count()).where(
            Video.event_id.in_(event_ids), Video.approval == "pending").group_by(Video.event_id)):
        out[event_id].video_approvals = n
    return out


def videos_ready_to_publish() -> tuple:
    """Converted, in review and not waiting for (or refused by) the administrator: only "Publicar" is missing."""
    return (Video.review_status == ImageReviewStatus.IN_REVIEW, Video.processing_status == VideoProcessingStatus.READY,
            Video.approval.is_(None) | (Video.approval == "approved"))


def list_events(db: Session, account: Account, *, q: str | None = None, theme_id: int | None = None,
                status: EventStatus | None = None, period_start: date | None = None,
                period_end: date | None = None, scope: str = "all", page: int = 1) -> tuple[list[Event], int]:
    # "all": every event the account finds; "enabled" ("Habilitados para mim"): its own and the ones it may work on.
    query = _listed_to(account) if scope == "all" else _visible_to(account)
    if scope == "mine":
        query = query.where(Event.owner_id == account.id)
    elif scope == "collaborations":
        query = query.where(Event.owner_id != account.id)
    if q:
        # Accent- and case-insensitive: "fecial" finds "FeCiAL".
        query = query.where(func.unaccent(func.lower(Event.name)).like(
            func.unaccent(func.lower(f"%{q.strip()}%"))))
    if theme_id:
        query = query.where(Event.themes.any(Theme.id == theme_id))
    if status:
        query = query.where(Event.status == status)
    # By the EVENT date, not the upload date; overlapping intervals match.
    if period_start:
        query = query.where(Event.date_end >= period_start)
    if period_end:
        query = query.where(Event.date_start <= period_end)
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    items = db.scalars(query.order_by(Event.date_start.desc(), Event.created_at.desc(), Event.name)
                       .offset((max(page, 1) - 1) * PAGE_SIZE).limit(PAGE_SIZE)).all()
    return list(items), total or 0


def dashboard(db: Session, account: Account) -> dict:
    """Numbers of the "Visão geral" screen, computed from real data."""
    owned = db.scalars(select(Event).where(Event.owner_id == account.id,
                                           Event.status != EventStatus.EXPIRED)).all()
    owned_ids = [e.id for e in owned]
    manageable = select(Event.id).where(Event.owner_id == account.id) if account.role != AccountRole.ADMIN \
        else select(Event.id)
    failed = db.scalar(select(func.count()).select_from(Image).where(
        Image.event_id.in_(manageable), Image.indexing_status == ImageIndexingStatus.FAILED)) or 0
    # Photos and videos: a video asked to be removed has the same 72 hours (05/11/2026).
    removals = [db.execute(select(func.count(), func.min(model.removal_requested_at)).where(
        model.event_id.in_(manageable), model.removal_requested_at.is_not(None))).one() for model in (Image, Video)]
    removal = (sum(n for n, _ in removals), min((first for _, first in removals if first), default=None))
    published_mine = db.scalar(select(func.count()).select_from(Image).where(
        Image.uploaded_by == account.id, Image.review_status == ImageReviewStatus.PUBLISHED)) or 0
    # The administrator must see, without opening each event, where photos of a hired
    # photographer wait for approval.
    approvals = db.execute(select(Event.id, Event.name, func.count(Image.id)).join(Image, Image.event_id == Event.id)
                           .where(Image.approval == "pending").group_by(Event.id, Event.name)
                           .order_by(func.count(Image.id).desc())).all() if account.role == AccountRole.ADMIN else []
    from app.events.notifications import for_account  # local: notifications → public.service → this module
    admin = account.role == AccountRole.ADMIN
    return {
        "events_owned": len(owned_ids),
        "processing": sum(1 for e in owned if e.status == EventStatus.PROCESSING),
        # Situations that need someone (the bell's counter): one per event and kind, not one per photo.
        "attention": sum(1 for n in for_account(db, account) if n["urgent"]),
        # The administrator creates few events: its overview counts the whole system.
        "active_events": db.scalar(select(func.count()).select_from(Event).where(
            Event.status != EventStatus.EXPIRED)) if admin else None,
        # Photos and videos of the hired photographer (05/11/2026: the videos were missing from the count).
        "approvals_total": sum(n for _, _, n in approvals) + (db.scalar(select(func.count()).select_from(Video).where(
            Video.approval == "pending")) or 0) if admin else None,
        "approvals_pending": [{"event_id": str(i), "event_name": name, "photos": n} for i, name, n in approvals],
        "photos_published": published_mine,
        "indexing_failures": failed,
        "removal_requests": removal[0],
        "oldest_removal_request": removal[1],
    }


def _now() -> datetime:
    return datetime.now(timezone.utc)

