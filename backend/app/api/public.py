"""PUBLIC routes: /api/v1/public/* — no account, no login.

Only consultation is exposed here: it is technically impossible to create, change or delete
anything from these routes, except a visitor's consent record and a removal REQUEST.
"""
from __future__ import annotations

import uuid
from datetime import date
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Query, Request, Response, UploadFile, status
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import audit, parameters
from app.api.deps import VISIT_HEADER, from_app
from app.config import get_settings
from app.db.models import Theme
from app.db.session import get_session
from app.events import dates
from app.events.service import EventError, NotFound
from app.face.factory import get_face_engine
from app.face.port import FaceEngine
from app.images import watermark
from app.images.processing import credit_line
from app.notifications.factory import get_email_sender
from app.notifications.port import EmailSender
from app.public import service
from app.security import atypical
from app.security.rate_limit import RateLimiter
from app.storage.factory import get_storage
from app.storage.port import ObjectStorage

router = APIRouter(prefix="/public", tags=["public"])
VISIT_COOKIE = "fotomac_visit"

# Inference is expensive and could be used to sweep a collection.
search_limiter = RateLimiter(max_requests=20, window_seconds=600)
download_limiter = RateLimiter(max_requests=60, window_seconds=600)
consent_limiter = RateLimiter(max_requests=30, window_seconds=600)
removal_limiter = RateLimiter(max_requests=10, window_seconds=3600)
# A capture checks up to 4 movements, each repeated a few times: generous, but not a free face detector.
check_limiter = RateLimiter(max_requests=120, window_seconds=600)


def _address(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def limit_search(event_id: uuid.UUID, request: Request, db: Session = Depends(get_session)) -> None:
    """The search limiter (RF024 note 4), and the alert to the administrator when it blocks an address (note 5)."""
    try:
        search_limiter.check(_address(request))
    except HTTPException:
        atypical.searches_blocked(db, _address(request), event_id, search_limiter.max_requests, search_limiter.window // 60)
        raise


# A refused search that may be someone trying a photo or a screen: the liveness check failed, or the face changed.
SUSPICIOUS = {"liveness", "consistency"}


def apply_limits(db: Session) -> None:
    """The administrator sets these numbers ("Limites de requisição" in the panel); applied at startup
    and right after every change. (In-process limiters: with several API processes, each one
    keeps its own count — a shared store such as Redis would be the next step.)"""
    search_limiter.max_requests = parameters.get(db, "searches_per_address")
    download_limiter.max_requests = parameters.get(db, "downloads_per_address")


class ThemeOut(BaseModel):
    id: int
    name: str
    icon: str


class PublicEvent(BaseModel):
    id: uuid.UUID
    name: str
    date_label: str
    date_start: date
    date_end: date
    date_precision: str
    location: str
    description: str
    latitude: float | None
    longitude: float | None
    location_note: str | None
    has_children: bool   # the notice "Este evento contém imagens com crianças" (04/11/2026); never where the terms are
    themes: list[ThemeOut]
    photos: int
    credits: list[str]
    expires_on: date


def _out(db: Session, e) -> PublicEvent:
    return PublicEvent(id=e.id, name=e.name, date_label=dates.label(e.date_precision, e.date_start, e.date_end),
                       date_start=e.date_start, date_end=e.date_end, date_precision=e.date_precision.value,
                       location=e.location, description=e.description, latitude=e.latitude, longitude=e.longitude,
                       location_note=e.location_note, has_children=e.has_children,
                       themes=[ThemeOut(id=t.id, name=t.name, icon=t.icon) for t in sorted(e.themes, key=lambda t: t.name)],
                       photos=service.published_count(db, e.id), credits=service.credits(db, e), expires_on=e.expires_on)


def _event(db: Session, event_id: uuid.UUID):
    try:
        return service.get_public_event(db, event_id)
    except NotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from None


def _visit_token(request: Request) -> str | None:
    """The visit: the site's cookie, or the app's header (the app keeps it only in memory, 06/11/2026)."""
    return request.cookies.get(VISIT_COOKIE) or request.headers.get(VISIT_HEADER) or None


def _visit(request: Request, db: Session, event_id: uuid.UUID | None = None):
    return service.get_session(db, _visit_token(request), event_id)


# ------------------------------------------------------------------ listing

@router.get("/themes", response_model=list[ThemeOut])
def themes(db: Session = Depends(get_session)):
    return [ThemeOut(id=t.id, name=t.name, icon=t.icon) for t in db.scalars(select(Theme).where(Theme.active.is_(True)).order_by(Theme.name))]


@router.get("/events")
def list_events(q: str | None = Query(None, max_length=150), theme_id: list[int] = Query([]), day: date | None = None,
                period_start: date | None = None, period_end: date | None = None, page: int = Query(1, ge=1),
                db: Session = Depends(get_session)):
    items, total = service.list_public_events(db, q, theme_id, day, period_start, period_end, page)
    return {"items": [_out(db, e) for e in items], "total": total, "page": page, "page_size": 20}


@router.get("/events/{event_id}", response_model=PublicEvent)
def get_event(event_id: uuid.UUID, db: Session = Depends(get_session)):
    return _out(db, _event(db, event_id))


@router.get("/events/{event_id}/cover")
def cover(event_id: uuid.UUID, db: Session = Depends(get_session), storage: ObjectStorage = Depends(get_storage)):
    """The ONLY image of an event shown without facial search."""
    event = _event(db, event_id)
    if not event.cover_object_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Evento sem capa.")
    return Response(storage.get(event.cover_object_key), media_type="image/jpeg",
                    headers={"Cache-Control": "public, max-age=3600"})


# ------------------------------------------------------------------ consent

@router.get("/consent")
def consent_text(db: Session = Depends(get_session)):
    return {"version": service.CONSENT_VERSION, "title": service.CONSENT_TITLE,
            "paragraphs": service.CONSENT_PARAGRAPHS, "retention": service.retention_text(db)}


@router.post("/events/{event_id}/consent", status_code=status.HTTP_204_NO_CONTENT,
             dependencies=[Depends(consent_limiter)])
def give_consent(event_id: uuid.UUID, request: Request, response: Response, db: Session = Depends(get_session)):
    """The explicit "Estou ciente" (no pre-checked option, no tacit acceptance)."""
    token = service.give_consent(db, _event(db, event_id))
    if from_app(request):
        return JSONResponse({"visit_token": token})
    response.set_cookie(VISIT_COOKIE, token, max_age=service.SESSION_HOURS * 3600, httponly=True,
                        secure=get_settings().cookie_secure, samesite="lax", path="/api/v1/public")


# ------------------------------------------------------------------ search

class ResultItem(BaseModel):
    id: uuid.UUID
    captured_at: str | None
    credit: str


def _result_items(db: Session, ids: list[uuid.UUID]) -> list[ResultItem]:
    from app.db.models import Image
    images = {i.id: i for i in db.scalars(select(Image).where(Image.id.in_(ids)))} if ids else {}
    return [ResultItem(id=i, captured_at=images[i].captured_at.isoformat() if images[i].captured_at else None,
                       credit=credit_line(images[i].credit_signature))
            for i in ids if i in images and images[i].removal_requested_at is None]


class VideoItem(BaseModel):
    id: uuid.UUID
    duration_seconds: float
    captured_at: str | None
    credit: str


def _video_items(db: Session, ids: list[uuid.UUID]) -> list[VideoItem]:
    from app.db.models import Video
    videos = {v.id: v for v in db.scalars(select(Video).where(Video.id.in_(ids)))} if ids else {}
    return [VideoItem(id=i, duration_seconds=videos[i].duration_seconds,
                      captured_at=videos[i].captured_at.isoformat() if videos[i].captured_at else None,
                      credit=credit_line(videos[i].credit_signature).replace("Fotografia", "Vídeo", 1))
            for i in ids if i in videos and videos[i].removal_requested_at is None]


def _public_error(exc: service.PublicError) -> HTTPException:
    code = status.HTTP_403_FORBIDDEN if exc.reason == "consent_required" else (
        status.HTTP_429_TOO_MANY_REQUESTS if exc.reason == "limit" else status.HTTP_422_UNPROCESSABLE_ENTITY)
    return HTTPException(code, {"message": str(exc), "reason": exc.reason})


@router.post("/events/{event_id}/capture")
def capture_challenge(event_id: uuid.UUID, request: Request, db: Session = Depends(get_session)):
    """Starts a guided capture: the order of the head movements, drawn by the server."""
    event = _event(db, event_id)
    try:
        order = service.issue_challenge(db, _visit(request, db, event_id), event)
        atypical.capture_started(_address(request))
        return {"order": order}
    except service.PublicError as exc:
        raise _public_error(exc) from None


@router.post("/events/{event_id}/capture/check", dependencies=[Depends(check_limiter)])
async def capture_check(event_id: uuid.UUID, request: Request, step: str = Form(...), fronts: list[UploadFile] = File(...),
                        frames: list[UploadFile] = File(...), db: Session = Depends(get_session),
                        engine: FaceEngine = Depends(get_face_engine)):
    """Did this movement work? Answered during the capture, so the screen says "deu certo" or asks again."""
    event = _event(db, event_id)
    if len(fronts) + len(frames) > service.MAX_CHECK_FRAMES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"message": "A captura chegou incompleta. Grave de novo.",
                                                                  "reason": "format"})
    front_data = [await f.read(service.MAX_FRAME_BYTES + 1) for f in fronts]
    step_data = [await f.read(service.MAX_FRAME_BYTES + 1) for f in frames]
    try:
        result = service.check_step(db, engine, _visit(request, db, event_id), event, front_data, step, step_data)
        atypical.step_checked(db, _address(request), event.id, step, result["ok"], result.get("reason"))
        return result
    except service.PublicError as exc:
        raise _public_error(exc) from None
    finally:
        del front_data, step_data  # dropped as soon as the check ends


@router.post("/events/{event_id}/search", dependencies=[Depends(limit_search)])
async def search(event_id: uuid.UUID, request: Request, frames: list[UploadFile] = File(...),
                 steps: list[str] = Form(...), db: Session = Depends(get_session),
                 engine: FaceEngine = Depends(get_face_engine)):
    """Search from the frames of a guided capture, never from a single uploaded photo: the gallery
    upload is gone — only a live face passes the liveness check."""
    event = _event(db, event_id)
    if len(frames) > service.MAX_FRAMES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"message": "A captura chegou incompleta. Grave de novo.",
                                                                  "reason": "format"})
    data = [await f.read(service.MAX_FRAME_BYTES + 1) for f in frames]
    try:
        matches = service.search(db, engine, _visit(request, db, event_id), event, data, steps)
    except service.PublicError as exc:
        if exc.reason in SUSPICIOUS:
            atypical.liveness_refused(db, _address(request), event.id)
        raise _public_error(exc) from None
    finally:
        del data  # the frames are dropped as soon as the search ends
    atypical.search_done(_address(request))
    return {"items": _result_items(db, [m.image_id for m in matches]),
            "videos": _video_items(db, list(_visit(request, db, event_id).result_video_ids or []))}


@router.post("/session/end", status_code=status.HTTP_204_NO_CONTENT)
def end_visit(request: Request, db: Session = Depends(get_session)):
    """Called when the visitor leaves the event page (or closes/reloads the tab). The session
    row is deleted, which makes the cookie worthless; the cookie itself is not touched, so a
    late answer can never erase the cookie of a NEW consent given meanwhile."""
    service.end_session(db, _visit_token(request))


def _allowed(request: Request, db: Session, image_id: uuid.UUID):
    try:
        return service.allowed_image(db, _visit(request, db), image_id)
    except EventError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from None


@router.post("/images/{image_id}/download-link", dependencies=[Depends(download_limiter)])
def download_link(image_id: uuid.UUID, request: Request, db: Session = Depends(get_session)):
    """The download address — signed, 15 minutes, this session and this image only."""
    _allowed(request, db, image_id)
    token = service.download_token(_visit(request, db), image_id)
    return {"url": f"/api/v1/public/images/{image_id}/download?t={token}"}


@router.get("/images/{image_id}/download")
def download(image_id: uuid.UUID, request: Request, t: str | None = None, db: Session = Depends(get_session),
             storage: ObjectStorage = Depends(get_storage)):
    """Delivers a copy of the photo in its original resolution, with the institutional watermark and
    the credits and ownership notice in the metadata, no GPS — one image per
    operation. The original in the collection is not changed. Served by the API itself: the storage
    address never reaches the browser — nor the "Where from" that the browser writes into the file."""
    image = _allowed(request, db, image_id)
    if not service.valid_download_token(_visit(request, db), image_id, t):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Link de download expirado. Abra a foto e toque em “Baixar” de novo.")
    audit.record(db, "public.download", None, "image", image.id, event_id=str(image.event_id))  # no visitor data
    db.commit()
    name = f"FOTOMAC - {image.event.name}.jpg".replace("/", "-").replace('"', "")
    disposition = f"attachment; filename=\"FOTOMAC.jpg\"; filename*=UTF-8''{quote(name)}"
    marked = watermark.apply(storage.get(image.object_key), image.credit_signature,
                             int(parameters.get(db, "watermark_corner")))
    return Response(marked, media_type="image/jpeg",
                    headers={"Content-Disposition": disposition, "Cache-Control": "no-store"})


@router.get("/images/{image_id}/{variant}")
def image_file(image_id: uuid.UUID, variant: str, request: Request, db: Session = Depends(get_session),
               storage: ObjectStorage = Depends(get_storage)):
    image = _allowed(request, db, image_id)
    key = {"thumb": image.thumb_key, "preview": image.preview_key}.get(variant)
    if not key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Arquivo não encontrado.")
    # Reduced copy for the screen. "no-store": not even the browser cache keeps
    # it — on a shared computer the cache would show the photos to the next person.
    return Response(storage.get(key), media_type="image/jpeg", headers={"Cache-Control": "no-store"})


# ------------------------------------------------------------------ videos found by the search (RF035)

def _allowed_video(request: Request, db: Session, video_id: uuid.UUID):
    try:
        return service.allowed_video(db, _visit(request, db), video_id)
    except EventError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from None


@router.get("/videos/{video_id}/thumb")
def video_thumb(video_id: uuid.UUID, request: Request, db: Session = Depends(get_session),
                storage: ObjectStorage = Depends(get_storage)):
    video = _allowed_video(request, db, video_id)
    if not video.thumb_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Miniatura não disponível.")
    return Response(storage.get(video.thumb_key), media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@router.get("/videos/{video_id}/play")
def video_play(video_id: uuid.UUID, request: Request, range_: str | None = Header(None, alias="Range"),
               db: Session = Depends(get_session), storage: ObjectStorage = Depends(get_storage)):
    """Watch before downloading, in parts (the player asks for ranges), only within this session's result.
    "no-store": a video of people does not stay in the cache of a shared computer."""
    from app.api.videos import _parse_range
    video = _allowed_video(request, db, video_id)
    size = video.web_bytes or 0
    span = _parse_range(range_, size)
    if span is None or span[0] == 0:   # once per viewing, without visitor data
        audit.record(db, "public.video_view", None, "video", video.id, event_id=str(video.event_id))
        db.commit()
    start, end = span or (0, size - 1)
    headers = {"Accept-Ranges": "bytes", "Content-Length": str(end - start + 1), "Cache-Control": "no-store"}
    if span is None:
        return StreamingResponse(storage.stream_range(video.web_key, 0, size - 1), media_type="video/mp4", headers=headers)
    headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return StreamingResponse(storage.stream_range(video.web_key, start, end), status_code=status.HTTP_206_PARTIAL_CONTENT,
                             media_type="video/mp4", headers=headers)


@router.post("/videos/{video_id}/download-link", dependencies=[Depends(download_limiter)])
def video_download_link(video_id: uuid.UUID, request: Request, db: Session = Depends(get_session)):
    _allowed_video(request, db, video_id)
    token = service.video_token(_visit(request, db), video_id, "download")
    return {"url": f"/api/v1/public/videos/{video_id}/download?t={token}"}


@router.get("/videos/{video_id}/download")
def video_download(video_id: uuid.UUID, request: Request, t: str | None = None, db: Session = Depends(get_session),
                   storage: ObjectStorage = Depends(get_storage)):
    """The WHOLE video (decision of 04/11/2026), with the institutional mark of the photos and the credit and
    ownership notice in the file. Made while it is sent: the download starts at once, and no marked copy is
    stored. The original in the collection is not changed."""
    import shutil
    import tempfile
    from pathlib import Path
    from app.images.processing import ownership_notice
    from app.videos import media
    video = _allowed_video(request, db, video_id)
    if not service.valid_video_token(_visit(request, db), video_id, "download", t):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Link de download expirado. Abra o vídeo e toque em “Baixar” de novo.")
    audit.record(db, "public.video_download", None, "video", video.id, event_id=str(video.event_id))  # no visitor data
    db.commit()
    folder = Path(tempfile.mkdtemp(prefix="fotomac-mark-"))
    try:
        source = folder / "source.mp4"
        storage.get_file(video.web_key, str(source))
        w, h = media.frame_size(source, folder)
        mark = folder / "mark.png"
        watermark.layer(w, h, int(parameters.get(db, "watermark_corner"))).save(mark)
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    notice = ownership_notice(video.credit_signature)

    def chunks():
        try:
            yield from media.watermarked(source, mark, video.credit_signature, notice)
        finally:   # the copy of the video leaves the server with the download, finished or not
            shutil.rmtree(folder, ignore_errors=True)

    name = f"FOTOMAC - {video.event.name}.mp4".replace("/", "-").replace('"', "")
    return StreamingResponse(chunks(), media_type="video/mp4", headers={
        "Cache-Control": "no-store",
        "Content-Disposition": f"attachment; filename=\"FOTOMAC.mp4\"; filename*=UTF-8''{quote(name)}"})


# ------------------------------------------------------------------ removal

class RemovalIn(BaseModel):
    contact_email: str = Field(max_length=120)
    reason: str | None = Field(None, max_length=500)


@router.post("/images/{image_id}/removal", dependencies=[Depends(removal_limiter)])
def request_removal(image_id: uuid.UUID, body: RemovalIn, request: Request, db: Session = Depends(get_session),
                    sender: EmailSender = Depends(get_email_sender)):
    try:
        req = service.request_removal(db, sender, _visit(request, db), image_id, body.contact_email, body.reason)
    except service.PublicError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, {"message": str(exc), "reason": exc.reason}) from None
    except EventError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from None
    return {"deadline": req.deadline_at.isoformat()}


@router.post("/videos/{video_id}/removal", dependencies=[Depends(removal_limiter)])
def request_video_removal(video_id: uuid.UUID, body: RemovalIn, request: Request, db: Session = Depends(get_session),
                          sender: EmailSender = Depends(get_email_sender)):
    """The whole video leaves every search now and is deleted in 72 hours (decision of 04/11/2026)."""
    try:
        req = service.request_video_removal(db, sender, _visit(request, db), video_id, body.contact_email, body.reason)
    except service.PublicError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, {"message": str(exc), "reason": exc.reason}) from None
    except EventError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from None
    return {"deadline": req.deadline_at.isoformat()}


@router.get("/privacy")
def privacy(db: Session = Depends(get_session)):
    """Data for the Privacy Policy page: the retention shown is the one in force."""
    return {"retention": service.retention_text(db), "consent_version": service.CONSENT_VERSION,
            "controller": "Centro Universitário CESMAC",
            "dpo": None}  # to be appointed by the institution
