"""Video routes of the panel (RF034). All require a session; the visitor's routes are in public.py (RF035)."""
from __future__ import annotations

import base64
import re
import tempfile
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import quote

import cv2
from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app import audit, parameters
from app.api.deps import session_token, current_account
from app.api.images import _http
from app.auth.tokens import token_hash
from app.db.models import Account, Video, VideoProcessingStatus
from app.db.session import get_session
from app.events import service as events
from app.images import service as images
from app.images.processing import FileRejected, credit_line
from app.public.service import REMOVAL_HOURS
from app.security import signed_links
from app.storage.factory import get_storage
from app.storage.port import ObjectStorage
from app.videos import media, recognition, service

router = APIRouter(tags=["videos"])
DOWNLOAD_LINK_MINUTES = 15
_CHUNK = 1024 * 1024
_RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")


class VideoOut(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    review_status: str
    processing_status: str
    failure: str | None
    credit: str
    uploaded_at: datetime
    captured_at: datetime | None
    size_bytes: int
    web_bytes: int | None
    duration_seconds: float
    width: int
    height: int
    video_codec: str
    audio_codec: str | None
    source_format: str
    converted: bool
    mine: bool
    can_manage: bool
    can_download: bool
    uploaded_by_name: str
    approval: str | None
    approved_by_name: str | None
    rejection_reason: str | None
    eliminated_at: datetime | None
    # Facial recognition (RF035): not_queued | pending | indexing | processed | no_faces | failed
    indexing_status: str
    face_seconds: int | None
    face_people: int | None           # different people found in it (only the count)
    removal_deadline: datetime | None   # a person found in it asked for it to go


def failure_text(video: Video) -> str | None:
    if video.processing_status == VideoProcessingStatus.FAILED:
        return (f"A conversão falhou {video.processing_attempts} vezes e parou. Use “Tentar de novo”; se a falha continuar, "
                "o arquivo pode estar corrompido: exclua e envie outra vez.")
    if video.processing_status == VideoProcessingStatus.PENDING and video.processing_attempts:
        return f"A tentativa {video.processing_attempts} de conversão falhou. O sistema tenta de novo sozinho."
    return None


def _out(account: Account, video: Video) -> VideoOut:
    return VideoOut(
        id=video.id, event_id=video.event_id, review_status=video.review_status.value,
        processing_status=video.processing_status.value, failure=failure_text(video),
        credit=credit_line(video.credit_signature).replace("Fotografia", "Vídeo", 1), uploaded_at=video.uploaded_at,
        captured_at=video.captured_at, size_bytes=video.size_bytes, web_bytes=video.web_bytes,
        duration_seconds=video.duration_seconds, width=video.width, height=video.height, video_codec=video.video_codec,
        audio_codec=video.audio_codec, source_format=video.source_format,
        converted=bool(video.web_key) and video.web_key != video.object_key, mine=video.uploaded_by == account.id,
        can_manage=service.can_manage_video(account, video), can_download=service.can_download(account, video),
        uploaded_by_name=video.uploader.full_name, approval=video.approval,
        approved_by_name=video.approver.full_name if video.approver else None, rejection_reason=video.rejection_reason,
        eliminated_at=video.rejected_at + timedelta(days=images.REJECTED_KEEP_DAYS) if video.rejected_at else None,
        indexing_status=video.indexing_status, face_seconds=video.face_seconds, face_people=video.face_people,
        removal_deadline=video.removal_requested_at + timedelta(hours=REMOVAL_HOURS) if video.removal_requested_at else None)


def _event(db: Session, account: Account, event_id: uuid.UUID):
    try:
        return events.get_visible(db, account, event_id)
    except events.EventError as exc:
        raise _http(exc) from None


def _video(db: Session, account: Account, video_id: uuid.UUID) -> Video:
    try:
        return service.get_video(db, video_id, account)
    except events.EventError as exc:
        raise _http(exc) from None


@router.get("/events/{event_id}/videos")
def list_videos(event_id: uuid.UUID, filter: str = Query("all"), account: Account = Depends(current_account),
                db: Session = Depends(get_session)):
    event = _event(db, account, event_id)
    return {"items": [_out(account, v) for v in service.list_videos(db, account, event, filter)],
            "counts": service.counts(db, event, account), "can_upload": images.can_upload(account, event),
            "storage_bytes": service.storage_used(db, event), "max_bytes": parameters.video_max_bytes(db),
            "max_seconds": parameters.video_max_seconds(db), "available": service.tool_ready()}


# `def`, not `async def`: FFmpeg blocks, so this runs in a worker thread and the server keeps answering.
@router.post("/events/{event_id}/videos", response_model=VideoOut, status_code=status.HTTP_201_CREATED)
def upload(event_id: uuid.UUID, file: UploadFile = File(...), account: Account = Depends(current_account),
           db: Session = Depends(get_session), storage: ObjectStorage = Depends(get_storage)):
    event = _event(db, account, event_id)
    limit = parameters.video_max_bytes(db)
    with tempfile.TemporaryDirectory(prefix="fotomac-upload-") as folder:
        path, size = Path(folder) / "sent", 0
        with open(path, "wb") as out:
            while chunk := file.file.read(_CHUNK):
                size += len(chunk)
                if size > limit:
                    raise HTTPException(status.HTTP_400_BAD_REQUEST, {
                        "message": f"O vídeo ultrapassa o limite de {limit // (1024 * 1024)} MB.", "reason": "too_large"})
                out.write(chunk)
        try:
            return _out(account, service.upload_video(db, storage, account, event, path))
        except (FileRejected, events.EventError) as exc:
            raise _http(exc) from None


@router.get("/videos/{video_id}", response_model=VideoOut)
def get_video(video_id: uuid.UUID, account: Account = Depends(current_account), db: Session = Depends(get_session)):
    return _out(account, _video(db, account, video_id))


@router.get("/videos/{video_id}/thumb")
def thumb(video_id: uuid.UUID, account: Account = Depends(current_account), db: Session = Depends(get_session),
          storage: ObjectStorage = Depends(get_storage)):
    video = _video(db, account, video_id)
    if not video.thumb_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Miniatura ainda não disponível.")
    return Response(storage.get(video.thumb_key), media_type="image/jpeg", headers={"Cache-Control": "private, max-age=600"})


PEOPLE_SIDE = 160   # px of each face shown below the player


@router.get("/videos/{video_id}/people")
def people(video_id: uuid.UUID, account: Account = Depends(current_account), db: Session = Depends(get_session),
           storage: ObjectStorage = Depends(get_storage)):
    """Who appears in the video, one face per person, below the player of the panel (05/11/2026). Only for
    whoever manages the video, never for the visitor. Each face is cut from the video now and sent inside the answer;
    nothing is stored, nothing is cached, and the opening is recorded."""
    video = _video(db, account, video_id)
    if not service.can_manage_video(account, video):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Somente quem gerencia o vídeo vê as pessoas encontradas.")
    faces = recognition.people_faces(db, video, parameters.get(db, "similarity_threshold")) \
        if video.indexing_status == "processed" else []
    out = []
    if faces:
        key = video.web_key or video.object_key   # the file that was analysed: the boxes are in its frames
        with tempfile.TemporaryDirectory(prefix="fotomac-people-") as folder:
            source = Path(folder) / ("source" + Path(key).suffix)
            storage.get_file(key, str(source))
            for n, (second, (x, y, w, h)) in enumerate(faces):
                frame_file = Path(folder) / f"p{n}.jpg"
                media.frame_at(source, second, frame_file)
                frame = cv2.imread(str(frame_file))
                if frame is None:
                    continue
                pad = int(0.25 * max(w, h))   # some hair and chin around the face, as a person recognises it
                crop = frame[max(0, y - pad):y + h + pad, max(0, x - pad):x + w + pad]
                if not crop.size:
                    continue
                crop = cv2.resize(crop, (PEOPLE_SIDE, round(PEOPLE_SIDE * crop.shape[0] / crop.shape[1])))
                jpeg = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes()
                out.append({"second": round(second, 1), "image": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()})
    audit.record(db, "video.people_viewed", account.id, "video", video.id, people=len(out))
    db.commit()
    return JSONResponse({"people": out}, headers={"Cache-Control": "no-store"})


def _parse_range(header: str | None, size: int) -> tuple[int, int] | None:
    """(start, end) of a "Range: bytes=..." header, both included. None: the whole file."""
    if not header:
        return None
    match = _RANGE.match(header.strip())
    if not match or not (match[1] or match[2]):
        return None
    if match[1]:
        start, end = int(match[1]), min(int(match[2]) if match[2] else size - 1, size - 1)
    else:  # "bytes=-500": the last 500 bytes
        start, end = max(size - int(match[2]), 0), size - 1
    if start > end or start >= size:
        raise HTTPException(416, "Intervalo inválido.",
                            headers={"Content-Range": f"bytes */{size}"})
    return start, end


@router.get("/videos/{video_id}/play")
def play(video_id: uuid.UUID, range_: str | None = Header(None, alias="Range"), account: Account = Depends(current_account),
         db: Session = Depends(get_session), storage: ObjectStorage = Depends(get_storage)):
    """In parts, always through the API (RF034): each part checks the session, and the storage address never
    leaves the server. "no-store": a video of a person does not stay in the cache of a shared computer."""
    video = _video(db, account, video_id)
    if not video.web_key or not video.web_bytes:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Vídeo ainda em conversão.")
    size = video.web_bytes
    span = _parse_range(range_, size)
    if span is None or span[0] == 0:  # who opened it, once per viewing: not every part of it
        audit.record(db, "video.view", account.id, "video", video.id, event_id=str(video.event_id))
        db.commit()
    start, end = span or (0, size - 1)
    headers = {"Accept-Ranges": "bytes", "Content-Length": str(end - start + 1), "Cache-Control": "private, no-store"}
    if span is None:
        return StreamingResponse(storage.stream_range(video.web_key, 0, size - 1), media_type="video/mp4", headers=headers)
    headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return StreamingResponse(storage.stream_range(video.web_key, start, end), status_code=status.HTTP_206_PARTIAL_CONTENT,
                             media_type="video/mp4", headers=headers)


@router.post("/videos/{video_id}/download-link")
def download_link(video_id: uuid.UUID, request: Request, account: Account = Depends(current_account),
                  db: Session = Depends(get_session)):
    video = _video(db, account, video_id)
    if not service.can_download(account, video):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Você não pode baixar este vídeo.")
    token = signed_links.sign(token_hash(session_token(request) or ""), f"video:{video_id}", DOWNLOAD_LINK_MINUTES * 60)
    return {"url": f"/api/v1/videos/{video_id}/download?t={token}"}


@router.get("/videos/{video_id}/download")
def download(video_id: uuid.UUID, request: Request, t: str | None = None, account: Account = Depends(current_account),
             db: Session = Depends(get_session), storage: ObjectStorage = Depends(get_storage)):
    video = _video(db, account, video_id)
    if not service.can_download(account, video):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Você não pode baixar este vídeo.")
    if not signed_links.verify(token_hash(session_token(request) or ""), f"video:{video_id}", t):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Link de download expirado. Abra o vídeo e baixe de novo.")
    # "publicity": marketing downloading someone else's work for institutional publicity (RF030), as for photos;
    # these are the "downloads para divulgação" of the compliance report (RNF14).
    audit.record(db, "video.download", account.id, "video", video.id, event_id=str(video.event_id),
                 publicity=not (service.can_manage_video(account, video) or video.uploaded_by == account.id))
    db.commit()
    size, chunks = storage.stream(video.object_key)
    name = f"FOTOMAC - {video.event.name}.{video.source_format}".replace("/", "-").replace('"', "")
    return StreamingResponse(chunks, media_type=service.CONTENT_TYPES[video.source_format], headers={
        "Content-Length": str(size), "Cache-Control": "no-store",
        "Content-Disposition": f"attachment; filename=\"FOTOMAC.{video.source_format}\"; filename*=UTF-8''{quote(name)}"})


class ApprovalIn(BaseModel):
    approve: bool
    reason: str | None = Field(None, max_length=300)


@router.post("/videos/{video_id}/approval", response_model=VideoOut)
def decide_approval(video_id: uuid.UUID, body: ApprovalIn, account: Account = Depends(current_account),
                    db: Session = Depends(get_session)):
    try:
        return _out(account, service.decide_approval(db, account, _video(db, account, video_id), body.approve, body.reason))
    except events.EventError as exc:
        raise _http(exc) from None


@router.post("/videos/{video_id}/discard", response_model=VideoOut)
def discard(video_id: uuid.UUID, account: Account = Depends(current_account), db: Session = Depends(get_session)):
    try:
        return _out(account, service.set_discarded(db, account, _video(db, account, video_id), True))
    except events.EventError as exc:
        raise _http(exc) from None


@router.post("/videos/{video_id}/restore", response_model=VideoOut)
def restore(video_id: uuid.UUID, account: Account = Depends(current_account), db: Session = Depends(get_session)):
    try:
        return _out(account, service.set_discarded(db, account, _video(db, account, video_id), False))
    except events.EventError as exc:
        raise _http(exc) from None


@router.post("/videos/{video_id}/retry", response_model=VideoOut)
def retry(video_id: uuid.UUID, account: Account = Depends(current_account), db: Session = Depends(get_session)):
    try:
        return _out(account, service.retry(db, account, _video(db, account, video_id)))
    except events.EventError as exc:
        raise _http(exc) from None


@router.delete("/videos/{video_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete(video_id: uuid.UUID, account: Account = Depends(current_account), db: Session = Depends(get_session),
           storage: ObjectStorage = Depends(get_storage)):
    try:
        service.delete_video(db, storage, account, _video(db, account, video_id))
    except events.EventError as exc:
        raise _http(exc) from None


class PublishIn(BaseModel):
    ids: list[uuid.UUID] | None = Field(None, max_length=images.MAX_PER_EVENT)


@router.post("/events/{event_id}/videos/publish")
def publish(event_id: uuid.UUID, body: PublishIn | None = None, account: Account = Depends(current_account),
            db: Session = Depends(get_session), storage: ObjectStorage = Depends(get_storage)):
    try:
        return service.publish(db, storage, account, _event(db, account, event_id), body.ids if body else None)
    except events.EventError as exc:
        raise _http(exc) from None
