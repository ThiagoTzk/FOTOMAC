"""FOTOMAC API — the single REST contract consumed by the web site and the mobile app.

Run:  .venv/bin/uvicorn app.main:app --reload
Docs: http://127.0.0.1:8000/api/docs  (OpenAPI generated automatically by FastAPI)
"""
from __future__ import annotations

import logging
import re
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.api.deps import ACCOUNT_HEADER, session_token
from app.api import (accounts, admin_config, auth, calibration, events, geo, images, institutional, public, reports,
                     support, themes, videos)
from app.config import get_settings
from app.db.session import get_engine
from app.face import factory
from app.face.port import FaceEngineUnavailable
from app.notifications.factory import get_email_sender
from app.notifications.port import EmailDeliveryError
from app.parameters import MAX_VIDEO_MB
from app.storage.factory import get_storage

API_PREFIX = "/api/v1"  # versioned: the mobile app keeps working while v2 is introduced

if get_settings().diagnostics_log:  # DEVELOPMENT ONLY: the liveness numbers go to the API log (config.py)
    _diag = logging.getLogger("fotomac.liveness")
    if not _diag.handlers:
        _handler = logging.StreamHandler()
        _handler.setFormatter(logging.Formatter("%(asctime)s %(name)s %(message)s"))
        _diag.addHandler(_handler)
    _diag.setLevel(logging.INFO)


@asynccontextmanager
async def lifespan(_: FastAPI):
    get_storage().ensure_bucket()
    # A wrong mail configuration (FOTOMAC_EMAIL_SENDER=smtp without a server, unencrypted...) stops the API here,
    # while whoever installs it is looking, instead of failing at the first account created (17/11/2026).
    get_email_sender()
    from sqlalchemy.orm import Session as DbSession

    with DbSession(get_engine()) as db:  # request limits chosen by the administrator
        public.apply_limits(db)
        # Loading the model takes a moment: do it at startup, not on the first visitor. If it fails
        # the API still starts (safe failure): the search answers 503 and the panel shows why.
        try:
            factory.active_engine(db)
        except FaceEngineUnavailable as exc:
            logging.getLogger("fotomac.face").error("face engine unavailable at startup: %s", exc)
    worker = None
    if get_settings().background_worker:
        from sqlalchemy.orm import sessionmaker

        from app.indexing.worker import Worker
        worker = Worker(sessionmaker(bind=get_engine(), expire_on_commit=False), get_storage(), factory.active_engine)
        worker.start()
    yield
    if worker:
        worker.stop()


app = FastAPI(title="FOTOMAC API", version="0.1.0", lifespan=lifespan,
              docs_url=f"{API_PREFIX}/docs", openapi_url=f"{API_PREFIX}/openapi.json")

INTERNAL_ERROR = "Erro interno no servidor. Tente de novo; se continuar, avise a administração do FOTOMAC."


# Registered BEFORE the CORS middleware, so it sits INSIDE it: an unexpected error becomes a 500 that
# still carries the CORS headers. Without this the browser drops the response and the screen says
# "não foi possível conectar" — which hid a real server error on 22/10/2026 (Python replaced by Homebrew).
@app.middleware("http")
async def unexpected_errors(request: Request, call_next):
    try:
        return await call_next(request)
    except Exception:
        logging.getLogger("fotomac.api").exception("unexpected error on %s %s", request.method, request.url.path)
        return JSONResponse(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, content={"detail": INTERNAL_ERROR})


# The web front-end runs on another origin (port 8081 in development). Only the listed
# origins may call the API with the session cookie.
app.add_middleware(CORSMiddleware, allow_origins=get_settings().cors_origins, allow_credentials=True,
                   allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
                   allow_headers=["Content-Type", "Range", "If-Match", ACCOUNT_HEADER],
                   expose_headers=["Content-Range", "ETag"])   # the map reads its file in pieces (api/geo.py)

WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


@app.middleware("http")
async def refuse_foreign_writes(request: Request, call_next):
    """CSRF (one site making the browser of a logged-in person send a request): the session cookie is
    SameSite=Lax, which blocks OTHER sites — but every *.cesmac.edu.br counts as the same site. So a
    write is refused when the browser says it comes from an origin that is not ours. Requests without
    Origin (the mobile app, scripts, tests) are not from a browser page and pass to the normal checks."""
    origin = request.headers.get("origin")
    if request.method in WRITE_METHODS and origin and origin not in get_settings().cors_origins:
        return JSONResponse(status_code=status.HTTP_403_FORBIDDEN, content={"detail": "Origem não permitida."})
    return await call_next(request)



_VIDEO_UPLOAD = re.compile(rf"^{API_PREFIX}/events/[^/]+/videos$")


@app.middleware("http")
async def refuse_oversized_videos(request: Request, call_next):
    """The server writes a whole form to disk BEFORE any route runs, so a video route alone could not stop someone
    without a session from filling the disk. Here the refusal comes before the body is read."""
    if request.method == "POST" and _VIDEO_UPLOAD.match(request.url.path):
        length = request.headers.get("content-length")
        if session_token(request) is None:
            return JSONResponse(status_code=status.HTTP_401_UNAUTHORIZED, content={"detail": "Sessão necessária."})
        if not length or not length.isdigit():
            return JSONResponse(status_code=status.HTTP_411_LENGTH_REQUIRED, content={"detail": "Tamanho do envio não informado."})
        if int(length) > (MAX_VIDEO_MB + 1) * 1024 * 1024:
            return JSONResponse(status_code=413, content={"detail": {
                "message": "O vídeo ultrapassa o limite aceito pelo servidor.", "reason": "too_large"}})
    return await call_next(request)


@app.exception_handler(FaceEngineUnavailable)
async def engine_unavailable(_: Request, __: FaceEngineUnavailable) -> JSONResponse:
    """Safe failure: no search with a broken (or another) model. The visitor gets a plain notice —
    the technical reason stays in the log and in the administrator's panel."""
    return JSONResponse(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, content={"detail": {
        "message": "A busca por reconhecimento facial está temporariamente indisponível. Tente novamente mais tarde.",
        "reason": "engine_unavailable"}})


@app.exception_handler(EmailDeliveryError)
async def email_not_sent(_: Request, exc: EmailDeliveryError) -> JSONResponse:
    """A message the person NEEDS (a link) did not leave (notifications/port.py). What was done is saved; the
    screen says so and that the link can be sent again. The technical reason goes to the log only."""
    logging.getLogger("fotomac.email").error("required e-mail not sent: %s", exc)
    return JSONResponse(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, content={"detail": {
        "message": "O que você fez foi salvo, mas o e-mail com o link não pôde ser enviado agora: o servidor de e-mail "
                   "não respondeu. Tente enviar o link de novo em alguns minutos; se continuar, avise a administração do FOTOMAC.",
        "reason": "email_not_sent"}})


app.include_router(auth.router, prefix=API_PREFIX)
app.include_router(events.router, prefix=API_PREFIX)
app.include_router(geo.router, prefix=API_PREFIX)
app.include_router(images.router, prefix=API_PREFIX)
app.include_router(videos.router, prefix=API_PREFIX)
app.include_router(public.router, prefix=API_PREFIX)
app.include_router(accounts.router, prefix=API_PREFIX)
app.include_router(admin_config.router, prefix=API_PREFIX)
app.include_router(calibration.router, prefix=API_PREFIX)
app.include_router(institutional.admin_router, prefix=API_PREFIX)
app.include_router(institutional.public_router, prefix=API_PREFIX)
app.include_router(institutional.router, prefix=API_PREFIX)
app.include_router(support.router, prefix=API_PREFIX)
app.include_router(themes.router, prefix=API_PREFIX)
app.include_router(reports.router, prefix=API_PREFIX)


@app.get(f"{API_PREFIX}/health", tags=["infra"])
def health() -> dict:
    """Checks the three dependencies. Exposes no personal data and no secrets."""
    with get_engine().connect() as conn:
        conn.execute(text("SELECT 1"))
    get_storage().ensure_bucket()
    from sqlalchemy.orm import Session as DbSession

    with DbSession(get_engine()) as db:  # request limits chosen by the administrator
        public.apply_limits(db)
        engine = factory.engine_status(db)
    return {"status": "ok" if engine["version"] else "degraded", "database": "ok", "storage": "ok",
            "face_engine": {"model_version": engine["version"], "vector_dim": engine["vector_dim"],
                            "available": engine["version"] is not None}}
