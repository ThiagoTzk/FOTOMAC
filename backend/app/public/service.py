"""Public area rules — what a visitor WITHOUT an account can do.

Privacy guarantees enforced here, on the server:
- only "Publicado" events exist publicly; everything else is "not found";
- no image is served unless it is in the result of THIS visitor session's last search;
- the search reference comes only from the camera, through the guided capture with liveness check:
  the frames and their vectors live only in memory during the search;
- the search compares only against vectors of ONE event.
"""
from __future__ import annotations

import json
import logging
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import Select, func, or_, select, text
from sqlalchemy.orm import Session

from app import audit, email_address, parameters
from app.auth.tokens import token_hash
from app.calibration import poses
from app.config import get_settings
from app.db.models import (Account, AccountRole, AccountStatus, ConsentRecord, Event, EventStatus, FaceEmbedding,
                           Image, ImageIndexingStatus, ImageReviewStatus, RemovalRequest, RemovalStatus, Theme,
                           Video, VideoFaceEmbedding, VideoProcessingStatus, VisitorSession)
from app.events.service import EventError, NotFound
from app.face.port import FaceEngine, FaceQualityTooLowError, NoFaceDetectedError
from app.face.selection import NO_FACE_MESSAGE, select_query_face
from app.imaging import decode_image, is_jpeg
from app.notifications.port import EmailMessage, EmailSender, notify
from app.security import signed_links
from app.videos import recognition

SESSION_HOURS = 2
REMOVAL_HOURS = 72

# Guided capture. The browser takes ~6 frames per step (front + 4 movements) at most 1280 px.
MOVES = ("esquerda", "direita", "cima", "baixo")
# The drawn order is valid for one capture, right after it is asked. 04/11/2026: 240 s, because a movement that fails
# is now repeated on the spot (the coordinator's test: say "erro, tente de novo" and ask for that movement again).
CAPTURE_SECONDS = 240
MIN_FRAMES, MAX_FRAMES = 5, 40
MAX_FRAME_BYTES = 2 * 1024 * 1024
# The poses of one capture must be the same person: otherwise someone could turn their own head for
# the liveness check while showing another person's photo in the frontal frame. Same person across
# poses scores ~0.4-0.9 with SFace; different people stay below ~0.25 (NASA fixtures: at most 0.24).
# The development log (diagnostics_log) records the real values, to tune this with real faces.
SAME_PERSON = 0.30

log = logging.getLogger("fotomac.liveness")

# ------------------------------------------------------------------ consent text
# Versioned: the version goes to every consent record, so it is always possible to prove
# WHICH text a visitor accepted. Change the text → change the version.
CONSENT_VERSION = "2026-11-v5"   # v2 (17/10/2026): guided capture with liveness check
                                 # v3 (19/10/2026): the paragraph on minors left with the rest of the minors rules,
                                 # awaiting the official answer of the advisor and the coordination
                                 # v4 (02/11/2026): the recognition can be wrong, and the use of other people's images
                                 # v5 (04/11/2026): the videos of the event are compared too (RF035)
CONSENT_TITLE = "Permissão para uso de imagem"
CONSENT_PARAGRAPHS = [
    "Para encontrar suas fotos, precisamos de uma captura rápida do seu rosto: olhe para a câmera e siga os "
    "movimentos indicados na tela.",
    "Sua privacidade é nossa prioridade e seus dados serão tratados de acordo com a Lei Geral de Proteção de Dados "
    "(Lei nº 13.709/2018).",
    "A captura será utilizada apenas para comparar com as fotos e os vídeos deste evento e para confirmar que há uma pessoa real "
    "diante da câmera. Somente alguns quadros são enviados, e eles são excluídos após o processamento; o vídeo não é "
    "gravado. Não compartilhamos sua imagem com terceiros.",
    "O reconhecimento facial tem margem de erro: pode mostrar a foto de uma pessoa parecida com você ou deixar de "
    "mostrar fotos suas. Se aparecer uma foto que não é sua, não a baixe nem compartilhe. Um vídeo em que você aparece "
    "pode mostrar outras pessoas. Usar a imagem de outra pessoa sem autorização pode gerar responsabilização civil e "
    "criminal, conforme o caso.",
    "Para mais informações, acesse nossa Política de Privacidade e LGPD. Ao clicar em “Estou ciente”, concordo com os "
    "termos e condições.",
]


class PublicError(EventError):
    """reason lets the screen pick the right guidance; message is safe to show."""

    def __init__(self, message: str, reason: str = "error"):
        super().__init__(message)
        self.reason = reason


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ------------------------------------------------------------------ events

def published_events() -> Select:
    # Only "Publicado"; "Em Edição", "Em Processamento" and "Expirado" do not
    # exist for the public — not even by direct address.
    return select(Event).where(Event.status == EventStatus.PUBLISHED,
                               Event.deletion_due_at.is_(None))  # an event being deleted left the site at once


def published_images() -> Select:
    return (select(Image).join(Event, Event.id == Image.event_id)
            .where(Event.status == EventStatus.PUBLISHED, Image.review_status == ImageReviewStatus.PUBLISHED))


def get_public_event(db: Session, event_id: uuid.UUID) -> Event:
    event = db.scalar(published_events().where(Event.id == event_id))
    if event is None:
        raise NotFound("Evento não encontrado.")
    return event


def list_public_events(db: Session, q: str | None, theme_ids: list[int], day: datetime | None,
                       period_start, period_end, page: int, page_size: int = 20) -> tuple[list[Event], int]:
    query = published_events()
    if q and q.strip():
        term = q.strip().lower()
        # Partial, accent-insensitive AND tolerant to simple spelling mistakes
        # (trigram similarity, pg_trgm): "fecil" finds "FeCiAL", "colacao" finds "Colação".
        name = func.unaccent(func.lower(Event.name))
        query = query.where(or_(name.like(func.unaccent(f"%{term}%")),
                                func.word_similarity(func.unaccent(term), name) > 0.4))
    if theme_ids:  # several themes combined: an event with ANY of them
        query = query.where(Event.themes.any(Theme.id.in_(theme_ids)))
    if day:  # by the EVENT date, not the upload date
        query = query.where(Event.date_start <= day, Event.date_end >= day)
    if period_start:
        query = query.where(Event.date_end >= period_start)
    if period_end:
        query = query.where(Event.date_start <= period_end)
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    items = db.scalars(query.order_by(Event.date_start.desc(), Event.created_at.desc())
                       .offset((max(page, 1) - 1) * page_size).limit(page_size)).all()
    return list(items), total


def published_count(db: Session, event_id: uuid.UUID) -> int:
    """Counts only published images — and shows none of them."""
    return db.scalar(select(func.count()).select_from(Image).where(
        Image.event_id == event_id, Image.review_status == ImageReviewStatus.PUBLISHED)) or 0


def credits(db: Session, event: Event) -> list[str]:
    """Every photographer of the coverage (collaboration may add several)."""
    names = db.scalars(select(Image.credit_signature).where(
        Image.event_id == event.id, Image.review_status == ImageReviewStatus.PUBLISHED).distinct()).all()
    return sorted(names) or [event.owner.photographer_signature or event.owner.full_name]


# ------------------------------------------------------------------ consent and session

def give_consent(db: Session, event: Event) -> str:
    """Records the "Estou ciente" and opens an anonymous session for this event. Returns the
    session token (goes only into an HttpOnly cookie)."""
    record = ConsentRecord(event_id=event.id, text_version=CONSENT_VERSION)
    db.add(record)
    db.flush()
    token = secrets.token_urlsafe(32)
    db.add(VisitorSession(token_hash=token_hash(token), event_id=event.id, consent_id=record.id,
                          expires_at=_now() + timedelta(hours=SESSION_HOURS), result_ids=[]))
    db.commit()
    return token


def get_session(db: Session, token: str | None, event_id: uuid.UUID | None = None) -> VisitorSession | None:
    if not token:
        return None
    s = db.get(VisitorSession, token_hash(token))
    if s is None or s.expires_at < _now() or (event_id and s.event_id != event_id):
        return None
    return s


def end_session(db: Session, token: str | None) -> None:
    """The visitor left the event page: the result and the consent of that visit are erased.
    Nothing of the search survives the page — on a shared computer the next person must not
    see someone else's photos."""
    if token:
        db.query(VisitorSession).filter(VisitorSession.token_hash == token_hash(token)).delete()
        db.commit()


# ------------------------------------------------------------------ search

@dataclass
class Match:
    image_id: uuid.UUID
    similarity: float


def _require_session(db: Session, session: VisitorSession | None, event: Event) -> VisitorSession:
    # Without the recorded consent, NO vector is generated.
    if session is None or session.event_id != event.id:
        raise PublicError("Antes da busca, leia o aviso de permissão para uso de imagem e confirme que está ciente.",
                          "consent_required")
    if session.searches >= parameters.get(db, "searches_per_session"):
        raise PublicError("Você atingiu o limite de buscas desta sessão. Volte ao evento e tente novamente mais tarde.",
                          "limit")
    return session


def issue_challenge(db: Session, session: VisitorSession | None, event: Event) -> list[str]:
    """Draws the order of the 4 head movements for ONE guided capture. Drawn here, not
    in the browser, so nobody can choose the order of a video recorded beforehand."""
    session = _require_session(db, session, event)
    order = secrets.SystemRandom().sample(MOVES, len(MOVES))
    session.capture_order, session.capture_issued_at = order, _now()
    db.commit()
    return order


def _refuse(db: Session, session: VisitorSession, event: Event, outcome: str, message: str, diagnostics: dict) -> None:
    session.searches += 1
    audit.record(db, "public.search", None, "event", event.id, outcome=outcome)  # aggregated, anonymous
    db.commit()
    if get_settings().diagnostics_log:
        log.info("busca recusada (%s): %s", outcome, json.dumps(diagnostics, ensure_ascii=False))
    raise PublicError(message, outcome)


LIVENESS_MESSAGE = ("Não conseguimos confirmar os movimentos. Busque de novo e siga as instruções da tela, virando o "
                    "rosto devagar, com o rosto inteiro no círculo e boa luz.")


MAX_CHECK_FRAMES = 16


def check_step(db: Session, engine: FaceEngine, session: VisitorSession | None, event: Event,
               fronts: list[bytes], step: str, moved: list[bytes]) -> dict:
    """One movement of the guided capture, checked while the visitor is still in front of the camera (04/11/2026,
    the coordinator's test: say at once whether it worked, and ask again for the movement that failed). The SAME
    measure as the final check (poses.select_guided). It searches nothing, stores nothing, spends no search and does
    not use up the drawn order: the final search checks everything again."""
    if session is None or session.event_id != event.id:
        raise PublicError("Antes da busca, leia o aviso de permissão para uso de imagem e confirme que está ciente.",
                          "consent_required")
    order, issued = session.capture_order, session.capture_issued_at
    if not order or not issued or (_now() - issued).total_seconds() > CAPTURE_SECONDS:
        raise PublicError("A captura expirou. Toque em “Buscar minhas fotos” e grave de novo.", "challenge")
    if (step != "frente" and step not in order) or not fronts or not moved or len(fronts) + len(moved) > MAX_CHECK_FRAMES or \
            any(len(f) > MAX_FRAME_BYTES or not is_jpeg(f) for f in (*fronts, *moved)):
        raise PublicError("A captura chegou incompleta. Grave de novo.", "format")
    if step == "frente":
        return _check_front(db, engine, moved)
    frames = [*fronts, *moved]
    steps = ["frente"] * len(fronts) + [step] * len(moved)
    images = [decode_image(f) for f in frames]
    described = [poses.frame_from_faces(n, img, engine.detect(img)) for n, img in enumerate(images)]
    del images, frames
    if not any(described[len(fronts):]):
        return {"ok": False, "reason": "no_face"}
    _, liveness = poses.select_guided(described, steps)
    report = next((r for r in liveness.get("steps", []) if r["step"] == step), None)
    if get_settings().diagnostics_log:
        log.info("passo conferido: %s", json.dumps(report, ensure_ascii=False))
    if not report:
        return {"ok": False, "reason": "no_front"}
    if not report["required"]:
        # Up and down (05/11/2026, user test, almost every nod "failed"): the 5 points of the detector barely move
        # when the head tilts (real nods measured 0.03 to 0.16 against a noise of about 0.04), so judging the nod
        # here failed real people. They never decided the liveness check: the face seen in the step is enough.
        seen = any(f is not None and f.score >= poses.MIN_SCORE for f in described[len(fronts):])
        if seen and report.get("opposite"):
            # 08/11/2026 (option B): only a nod clearly the OTHER way fails here, the final search refuses it too.
            return {"ok": False, "reason": "opposite"}
        if seen and report.get("sideways"):
            # 09/11/2026: a turn to a side instead of up or down, refused here and by the final search.
            return {"ok": False, "reason": "sideways"}
        if seen and (report["movement"] is None or report["movement"] < poses.NOD_MIN):
            # 09/11/2026: a face that stood still or went weakly the wrong way is asked again (poses.NOD_MIN).
            return {"ok": False, "reason": "movement"}
        return {"ok": seen, "reason": None if seen else "no_face"}
    # A turn almost to profile (the detector unsure of the face) is "movement" too: a separate "turn a little less"
    # message was tried on 11/11/2026 and taken out by the author; the turn must be moderate, neither too subtle nor too much.
    return {"ok": bool(report["ok"]), "reason": None if report["ok"] else "movement"}


def _check_front(db: Session, engine: FaceEngine, frames: list[bytes]) -> dict:
    """The first step, "olhe para a câmera" (11/11/2026, a tester covered the camera with a finger and the screen said
    "deu certo": this step was never checked). The same rule the final search applies to its query face
    (select_query_face: detector confidence and minimum face size, the administrator's parameters), and at least half
    of the frames must have it, so a face that only flashes by does not pass."""
    min_score, min_side = parameters.get(db, "min_detection_score"), parameters.get(db, "min_query_face_side")
    good = missing = 0
    for data in frames:
        img = decode_image(data)
        try:
            select_query_face(engine.detect(img), img.shape[1], img.shape[0], min_score, min_side)
            good += 1
        except NoFaceDetectedError:
            missing += 1
        except FaceQualityTooLowError:
            pass
        finally:
            del img   # dropped at once, like every frame of the capture
    if get_settings().diagnostics_log:
        log.info("frente conferida: %s", json.dumps({"rosto_bom": good, "sem_rosto": missing, "quadros": len(frames)}))
    if good and good * 2 >= len(frames):
        return {"ok": True, "reason": None}
    return {"ok": False, "reason": "no_face" if missing * 2 >= len(frames) else "low_quality"}


def search(db: Session, engine: FaceEngine, session: VisitorSession | None, event: Event,
           frames: list[bytes], steps: list[str]) -> list[Match]:
    """Public search from a guided capture: frames taken while the visitor
    followed the movements drawn by issue_challenge(), each tagged with its step."""
    session = _require_session(db, session, event)
    # The drawn order is used once, whatever happens next: a failed capture asks for a new order.
    order, issued = session.capture_order, session.capture_issued_at
    session.capture_order = session.capture_issued_at = None
    if not order or not issued or (_now() - issued).total_seconds() > CAPTURE_SECONDS:
        db.commit()
        raise PublicError("A captura expirou. Toque em “Buscar minhas fotos” e grave de novo.", "challenge")
    if not MIN_FRAMES <= len(frames) <= MAX_FRAMES or len(frames) != len(steps) or \
            any(st not in ("frente", *MOVES) for st in steps) or \
            any(len(f) > MAX_FRAME_BYTES or not is_jpeg(f) for f in frames):
        db.commit()
        raise PublicError("A captura chegou incompleta. Grave de novo.", "format")

    # Each frame is decoded and detected ONCE, in memory only.
    images = [decode_image(f) for f in frames]
    detected = [engine.detect(img) for img in images]
    described = [poses.frame_from_faces(n, img, faces) for n, (img, faces) in enumerate(zip(images, detected))]
    chosen, liveness = poses.select_guided(described, steps)
    diagnostics = {"pedido": ["frente", *order], "liveness": liveness}
    if not any(described):  # no face in any frame: say so, not "movements not confirmed"
        _refuse(db, session, event, "no_face", NO_FACE_MESSAGE, diagnostics)
    if liveness.get("order") != order:
        liveness["passed"] = False
        diagnostics["ordem_recebida"] = liveness.get("order")
    if not liveness["passed"]:
        _refuse(db, session, event, "liveness", LIVENESS_MESSAGE, diagnostics)

    # One query face per pose; the frontal pose is required, the others are a bonus.
    min_score, min_side = parameters.get(db, "min_detection_score"), parameters.get(db, "min_query_face_side")
    vectors = []
    for index, pose in chosen:
        img = images[index]
        try:
            face = select_query_face(detected[index], img.shape[1], img.shape[0], min_score, min_side)
        except (NoFaceDetectedError, FaceQualityTooLowError) as exc:
            if pose == "frente":  # user-safe messages
                reason = "no_face" if isinstance(exc, NoFaceDetectedError) else "low_quality"
                _refuse(db, session, event, reason, str(exc), diagnostics)
            continue
        vectors.append((pose, face.embedding))
    # Every pose must be the same person as the frontal one.
    front = vectors[0][1]
    alike = {pose: round(float(front @ v), 3) for pose, v in vectors[1:]}
    diagnostics["mesma_pessoa"] = alike
    # A head tilted up or down gives a poor vector of the SAME person (05/11/2026, the author's own captures: 0.22, 0.08
    # and -0.05 for "cima", while the turns gave 0.43 to 0.71). Refusing the whole search for it punished whoever
    # did the movement right. That pose is left out of the search instead: it neither refuses nor finds anything.
    # The turns decide the liveness check, so a different face there still refuses.
    left_out = [pose for pose, value in alike.items() if value < SAME_PERSON and pose not in poses.REQUIRED]
    if left_out:
        diagnostics["fora_da_busca"] = left_out
        vectors = [(pose, v) for pose, v in vectors if pose not in left_out]
        alike = {pose: value for pose, value in alike.items() if pose not in left_out}
    if any(value < SAME_PERSON for value in alike.values()):
        _refuse(db, session, event, "consistency",
                "Durante a captura o rosto mudou ou apareceu outra pessoa. Busque de novo com só o seu rosto na câmera.",
                diagnostics)

    # A photo is returned when ANY pose reaches the threshold; it keeps its best similarity.
    threshold, limit = parameters.get(db, "similarity_threshold"), parameters.get(db, "max_results_per_search")
    best_of: dict[uuid.UUID, float] = {}
    for _, vector in vectors:
        best = func.max(1 - FaceEmbedding.embedding.cosine_distance(vector)).label("similarity")
        rows = db.execute(
            select(FaceEmbedding.image_id, best)
            .join(Image, Image.id == FaceEmbedding.image_id)
            .where(FaceEmbedding.event_id == event.id,                       # ONE event, always
                   FaceEmbedding.model_version == engine.model_version,      # comparable vectors only
                   Image.review_status == ImageReviewStatus.PUBLISHED,
                   Image.indexing_status == ImageIndexingStatus.PROCESSED,
                   Image.removal_requested_at.is_(None))
            .group_by(FaceEmbedding.image_id)
            .having(best >= threshold)
            .order_by(best.desc())
            .limit(limit)).all()
        for r in rows:
            best_of[r.image_id] = max(best_of.get(r.image_id, 0.0), float(r.similarity))

    # RF035: the same query vectors in the videos of the event; a video needs the person in several seconds.
    found_videos = recognition.matches(db, event.id, engine.model_version, [v for _, v in vectors], threshold)
    matches = sorted((Match(i, sim) for i, sim in best_of.items()), key=lambda m: -m.similarity)[:limit]
    session.searches += 1
    session.result_ids = [m.image_id for m in matches]  # results bound to the session
    session.result_video_ids = [vid for vid, _ in found_videos][:limit]
    del vectors, front, detected, described, images, frames  # nothing derived from the capture survives
    audit.record(db, "public.search", None, "event", event.id, found=len(matches), videos=len(session.result_video_ids),
                 poses=len(alike) + 1)
    db.commit()
    if get_settings().diagnostics_log:
        log.info("busca aceita: %s", json.dumps(diagnostics, ensure_ascii=False))
    return matches


def allowed_image(db: Session, session: VisitorSession | None, image_id: uuid.UUID) -> Image:
    """An image is served ONLY if it is in this session's result."""
    if session is None or image_id not in (session.result_ids or []):
        raise NotFound("Imagem não encontrada.")
    image = db.get(Image, image_id)
    if image is None or image.review_status != ImageReviewStatus.PUBLISHED or image.removal_requested_at:
        raise NotFound("Imagem não encontrada.")
    return image


DOWNLOAD_SECONDS = 15 * 60  # at most 15 minutes


def download_token(session: VisitorSession, image_id: uuid.UUID, now: float | None = None) -> str:
    """Signed address, valid for 15 minutes, bound to the session that asked for
    it and limited to this one image."""
    return signed_links.sign(session.token_hash, f"image:{image_id}", DOWNLOAD_SECONDS, now)


def valid_download_token(session: VisitorSession, image_id: uuid.UUID, token: str | None) -> bool:
    return signed_links.verify(session.token_hash, f"image:{image_id}", token)


# ------------------------------------------------------------------ videos found by the search (RF035)

def allowed_video(db: Session, session: VisitorSession | None, video_id: uuid.UUID) -> Video:
    """A video is served ONLY if the search of this session found the person in it."""
    if session is None or video_id not in (session.result_video_ids or []):
        raise NotFound("Vídeo não encontrado.")
    video = db.get(Video, video_id)
    if video is None or video.review_status != ImageReviewStatus.PUBLISHED or video.removal_requested_at \
            or video.processing_status != VideoProcessingStatus.READY:
        raise NotFound("Vídeo não encontrado.")
    return video


def video_token(session: VisitorSession, video_id: uuid.UUID, purpose: str, now: float | None = None) -> str:
    """Signed address bound to the session, the video and the purpose ("play" or "download")."""
    return signed_links.sign(session.token_hash, f"video-{purpose}:{video_id}", DOWNLOAD_SECONDS, now)


def valid_video_token(session: VisitorSession, video_id: uuid.UUID, purpose: str, token: str | None) -> bool:
    return signed_links.verify(session.token_hash, f"video-{purpose}:{video_id}", token)



# ------------------------------------------------------------------ removal

def _staff_emails(db: Session, event: Event) -> list[str]:
    admins = db.scalars(select(Account.email).where(Account.role == AccountRole.ADMIN,
                                                    Account.status == AccountStatus.ACTIVE)).all()
    return sorted({event.owner.email, *admins})


def request_removal(db: Session, sender: EmailSender, session: VisitorSession | None, image_id: uuid.UUID,
                    contact: str, reason: str | None) -> RemovalRequest:
    """From the enlarged photo of a search result (preferred way)."""
    return _open_removal(db, sender, [allowed_image(db, session, image_id)], contact, reason)[0]


def _open_removal(db: Session, sender: EmailSender, images: list[Image], contact: str,
                  reason: str | None) -> list[RemovalRequest]:
    contact = contact.strip()
    if wrong := email_address.problem(contact, 120):
        raise PublicError(wrong, "contact")
    pending = [i for i in images if i.removal_requested_at is None]
    if not pending:  # already on its way out: no second deadline
        raise PublicError("Já existe uma solicitação de remoção para esta imagem. Ela será excluída em até 72 horas.",
                          "already_requested")
    now = _now()
    deadline = now + timedelta(hours=REMOVAL_HOURS)
    requests = []
    for image in pending:
        req = RemovalRequest(id=uuid.uuid4(), image_id=image.id, event_id=image.event_id,
                             reason=(reason or "").strip()[:500] or None, contact_email=contact, deadline_at=deadline)
        image.removal_requested_at = now  # out of every search immediately
        db.add(req)
        audit.record(db, "removal.request", None, "image", image.id, deadline=deadline.isoformat())
        requests.append(req)
    db.commit()
    # Responsible photographer and administrators are notified at once — one
    # message per event concerned.
    for event in {i.event_id: i.event for i in pending}.values():
        for email in _staff_emails(db, event):
            notify(sender, EmailMessage(
                to=email, subject="FOTOMAC: solicitação de remoção de imagem",
                body=(f"Uma pessoa retratada solicitou a remoção de uma imagem do evento “{event.name}”.\n\n"
                      "A imagem já foi retirada das buscas e será excluída AUTOMATICAMENTE em 72 horas "
                      f"({deadline.astimezone().strftime('%d/%m/%Y às %H:%M')}), mesmo sem ação sua. Ela aparece "
                      "destacada como “Remoção solicitada” na área de imagens do evento.\n\nEquipe FOTOMAC")))
    notify(sender, EmailMessage(
        to=contact, subject="FOTOMAC: recebemos sua solicitação de remoção",
        body=("Recebemos sua solicitação. A imagem foi retirada imediatamente dos resultados de busca e será "
              "excluída definitivamente em até 72 horas. Você receberá outra mensagem quando a exclusão for "
              "concluída.\n\nEquipe FOTOMAC\nCentro Universitário CESMAC")))
    return requests


def request_video_removal(db: Session, sender: EmailSender, session: VisitorSession | None, video_id: uuid.UUID,
                          contact: str, reason: str | None) -> RemovalRequest:
    """A person found in a video asks for it to go (decision of 04/11/2026): the WHOLE video leaves every search
    at once and is deleted in 72 hours, as a photo. Cutting the person out would be manual work."""
    video = allowed_video(db, session, video_id)
    contact = contact.strip()
    if wrong := email_address.problem(contact, 120):
        raise PublicError(wrong, "contact")
    now = _now()
    deadline = now + timedelta(hours=REMOVAL_HOURS)
    req = RemovalRequest(id=uuid.uuid4(), video_id=video.id, event_id=video.event_id,
                         reason=(reason or "").strip()[:500] or None, contact_email=contact, deadline_at=deadline)
    video.removal_requested_at = now   # out of every search immediately
    db.query(VideoFaceEmbedding).filter(VideoFaceEmbedding.video_id == video.id).delete(synchronize_session=False)
    db.add(req)
    audit.record(db, "removal.request", None, "video", video.id, deadline=deadline.isoformat())
    db.commit()
    for email in _staff_emails(db, video.event):
        notify(sender, EmailMessage(
            to=email, subject="FOTOMAC: solicitação de remoção de vídeo",
            body=(f"Uma pessoa que aparece em um vídeo do evento “{video.event.name}” pediu a remoção dele.\n\n"
                  "O vídeo já foi retirado das buscas e será excluído AUTOMATICAMENTE em 72 horas "
                  f"({deadline.astimezone().strftime('%d/%m/%Y às %H:%M')}), mesmo sem ação sua.\n\nEquipe FOTOMAC")))
    notify(sender, EmailMessage(
        to=contact, subject="FOTOMAC: recebemos sua solicitação de remoção",
        body=("Recebemos sua solicitação. O vídeo foi retirado imediatamente dos resultados de busca e será "
              "excluído definitivamente em até 72 horas. Você receberá outra mensagem quando a exclusão for "
              "concluída.\n\nEquipe FOTOMAC\nCentro Universitário CESMAC")))
    return req


def conclude_video_removals(db: Session, sender: EmailSender, video_id: uuid.UUID, status: RemovalStatus) -> None:
    """The video was deleted: tells the requester and then ERASES their contact data."""
    for req in db.scalars(select(RemovalRequest).where(RemovalRequest.video_id == video_id,
                                                       RemovalRequest.status == RemovalStatus.RECEIVED)):
        if req.contact_email:
            notify(sender, EmailMessage(
                to=req.contact_email, subject="FOTOMAC: vídeo removido",
                body=("O vídeo que você pediu para remover foi excluído definitivamente do FOTOMAC, junto com os "
                      "dados de reconhecimento facial associados.\n\nEquipe FOTOMAC\nCentro Universitário CESMAC")))
        req.status, req.concluded_at, req.contact_email = status, _now(), None


def due_video_removals(db: Session) -> list[Video]:
    return list(db.scalars(select(Video).where(
        Video.removal_requested_at.is_not(None),
        Video.removal_requested_at <= _now() - timedelta(hours=REMOVAL_HOURS))))


def conclude_removals(db: Session, sender: EmailSender, image_id: uuid.UUID, status: RemovalStatus) -> None:
    """Called when the image is deleted (by the photographer or automatically): tells the
    requester and then ERASES their contact data."""
    for req in db.scalars(select(RemovalRequest).where(RemovalRequest.image_id == image_id,
                                                       RemovalRequest.status == RemovalStatus.RECEIVED)):
        if req.contact_email:
            notify(sender, EmailMessage(
                to=req.contact_email, subject="FOTOMAC: imagem removida",
                body=("A imagem que você pediu para remover foi excluída definitivamente do FOTOMAC, junto com os "
                      "dados de reconhecimento facial associados.\n\nEquipe FOTOMAC\nCentro Universitário CESMAC")))
        req.status, req.concluded_at, req.contact_email = status, _now(), None


def due_removals(db: Session) -> list[Image]:
    """Never let a missed deadline keep the image in the collection."""
    return list(db.scalars(select(Image).where(
        Image.removal_requested_at.is_not(None),
        Image.removal_requested_at <= _now() - timedelta(hours=REMOVAL_HOURS))))


def retention_text(db: Session) -> str:
    months = parameters.retention_months(db)
    return f"{months} meses" if months != 1 else "1 mês"
