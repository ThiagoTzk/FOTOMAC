"""Authentication routes: /api/v1/auth/*"""
from __future__ import annotations

import uuid
from datetime import date, datetime

from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.accounts import photo as profile_photo
from app.api.deps import SESSION_COOKIE, current_account, current_account_even_blocked, from_app, session_token
from app.auth import service
from app.auth.passwords import PASSWORD_RULES
from app.config import get_settings
from app.db.models import Account, PasswordTokenPurpose
from app.db.session import get_session
from app.notifications.factory import get_email_sender
from app.notifications.port import EmailSender
from app.security.rate_limit import login_limiter, password_link_limiter
from app.storage.factory import get_storage
from app.storage.port import ObjectStorage

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginIn(BaseModel):
    email: str = Field(max_length=100)
    password: str = Field(max_length=200)
    remember: bool = False  # "Manter conectado": unchecked by default (shared computers)


class BlockedOut(BaseModel):
    since: datetime | None           # suspended/deactivated at, or when the temporary account ended
    last_login_at: datetime | None   # the last time it really entered the system


class AccountOut(BaseModel):
    id: uuid.UUID
    full_name: str
    email: str
    role: str
    role_label: str
    photographer_signature: str | None
    valid_until: datetime | None = None      # temporary account: when it stops working
    bound_event_id: uuid.UUID | None = None  # temporary account: the only event it works on
    # Inactivity (25/10/2026): minutes without use before the session ends, and how many seconds are left.
    # Both None with "Manter conectado".
    idle_minutes: int | None = None
    idle_left_seconds: int | None = None
    # Optional profile photo (28/10/2026): changes when the photo changes (busts the cache); None = initials.
    photo_version: str | None = None
    # "active", or suspended / inactive / expired: then the screen shows only the restricted page (31/10/2026).
    status: str = "active"
    status_label: str = "Ativa"
    blocked: BlockedOut | None = None


class LoginOut(AccountOut):
    # Only to the mobile app (06/11/2026), which keeps it in the phone's own safe (Keychain / Keystore) or only in
    # memory, and sends it as "Authorization: Bearer". The site gets None: its session stays in the HttpOnly cookie.
    session_token: str | None = None


class EmailIn(BaseModel):
    email: str = Field(max_length=100)


class TokenIn(BaseModel):
    token: str = Field(max_length=200)


class NewPasswordIn(BaseModel):
    token: str = Field(max_length=200)
    password: str = Field(max_length=200)
    password_confirmation: str = Field(max_length=200)


class FirstAccessIn(NewPasswordIn):
    # Hired photographer only: identification required before the account works.
    cpf: str | None = Field(None, max_length=20)
    birth_date: date | None = None


class PasswordRule(BaseModel):
    key: str
    label: str


def _account_out(a: Account, remember: bool = False, left: int | None = None, db: Session | None = None) -> AccountOut:
    from app.accounts.service import ROLE_LABEL, STATUS_LABEL
    idle = None if remember else get_settings().idle_minutes
    blocked = service.blocked_info(db, a) if db is not None else None
    return AccountOut(id=a.id, full_name=a.full_name, email=a.email, role=a.role.value, role_label=ROLE_LABEL[a.role],
                      photographer_signature=a.photographer_signature, valid_until=a.valid_until,
                      bound_event_id=a.bound_event_id, idle_minutes=idle,
                      idle_left_seconds=None if remember else (left if left is not None else idle * 60),
                      photo_version=a.photo_updated_at.strftime("%Y%m%d%H%M%S") if a.photo_key else None,
                      status=a.status.value, status_label=STATUS_LABEL[a.status],
                      blocked=BlockedOut(**blocked) if blocked else None)


def _me_out(request: Request, db: Session, account: Account) -> AccountOut:
    """The account as THIS session sees it: with "Manter conectado", no idle limit."""
    row = service.current_session(db, session_token(request))
    return _account_out(account, remember=bool(row and row.remember), left=service.idle_left(row) if row else None, db=db)


def _set_session_cookie(response: Response, token: str, max_age: int | None = None) -> None:
    s = get_settings()
    # HttpOnly: page JavaScript cannot read it, so an injected script cannot steal it.
    # SameSite=Lax: other sites cannot make the browser send it on POST requests (CSRF).
    # No max_age = a browser-session cookie: closing the browser logs out, unless "Manter conectado".
    response.set_cookie(SESSION_COOKIE, token, max_age=max_age, httponly=True,
                        secure=s.cookie_secure, samesite="lax", path="/api")


def _password_error(exc: service.AuthError) -> HTTPException:
    detail: dict = {"message": str(exc)}
    if isinstance(exc, service.WeakPasswordError):
        detail["failed_rules"] = exc.failed
    return HTTPException(status.HTTP_400_BAD_REQUEST, detail)


# exclude_unset: the site's answer has no "session_token" key at all, not even empty.
@router.post("/login", response_model=LoginOut, response_model_exclude_unset=True, dependencies=[Depends(login_limiter)])
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_session)):
    try:
        result = service.login(db, body.email, body.password, body.remember)
    except service.AuthError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from None
    out = _account_out(result.account, remember=result.remember_seconds is not None, db=db)
    if from_app(request):
        # No cookie for the app: a cookie left in the phone's cookie jar would outlive "Sair".
        return LoginOut(**out.model_dump(), session_token=result.session_token)
    _set_session_cookie(response, result.session_token, result.remember_seconds)
    return LoginOut(**out.model_dump())


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(request: Request, response: Response, db: Session = Depends(get_session)):
    service.logout(db, session_token(request))
    response.delete_cookie(SESSION_COOKIE, path="/api")


@router.get("/me", response_model=AccountOut)
def me(request: Request, account: Account = Depends(current_account_even_blocked), db: Session = Depends(get_session)):
    return _me_out(request, db, account)


@router.post("/activity", status_code=status.HTTP_204_NO_CONTENT)
def activity(_: Account = Depends(current_account_even_blocked)):
    """The person is using the page (moving the mouse, typing, reading) without calling the server: keeps
    the session from ending for inactivity. The check in current_account does the update."""


@router.get("/presence", status_code=status.HTTP_204_NO_CONTENT)
def presence(request: Request, _: Account = Depends(current_account_even_blocked), db: Session = Depends(get_session)):
    """A tab of the site is open (sent every minute). Without "Manter conectado", the session ends when no tab is
    open — reopening a browser that restored the cookie lands on the login (28/10/2026). Not "use": the idle
    limit still counts."""
    service.tab_open(db, session_token(request))


@router.post("/presence/closed", status_code=status.HTTP_204_NO_CONTENT)
def presence_closed(request: Request, db: Session = Depends(get_session)):
    """The last open tab is closing (navigator.sendBeacon, which cannot wait for an answer). Only marks the time:
    a page of the same session coming back within seconds (a reload) keeps it."""
    service.tab_closed(db, session_token(request))


@router.get("/password-rules", response_model=list[PasswordRule])
def password_rules():
    """Single source of truth for the checklist shown on the password screens."""
    return [PasswordRule(key=k, label=label) for k, label in PASSWORD_RULES]


@router.post("/password/forgot", status_code=status.HTTP_202_ACCEPTED,
             dependencies=[Depends(password_link_limiter)])
def forgot_password(body: EmailIn, db: Session = Depends(get_session),
                    sender: EmailSender = Depends(get_email_sender)):
    service.request_password_reset(db, body.email, sender)
    # Same answer whether or not the account exists.
    return {"message": "Se o e-mail pertencer a uma conta cadastrada, as instruções de recuperação serão enviadas."}


@router.post("/password/reset/check")
def check_reset_link(body: TokenIn, db: Session = Depends(get_session)):
    return {"valid": service.link_is_valid(db, body.token, PasswordTokenPurpose.RESET)}


@router.post("/password/reset", status_code=status.HTTP_204_NO_CONTENT,
             dependencies=[Depends(password_link_limiter)])
def reset_password(body: NewPasswordIn, db: Session = Depends(get_session)):
    try:
        service.reset_password(db, body.token, body.password, body.password_confirmation)
    except service.AuthError as exc:
        raise _password_error(exc) from None


@router.post("/first-access/check")
def check_activation_link(body: TokenIn, db: Session = Depends(get_session)):
    return service.activation_info(db, body.token)


@router.post("/first-access", response_model=LoginOut, response_model_exclude_unset=True,
             dependencies=[Depends(password_link_limiter)])
def first_access(body: FirstAccessIn, request: Request, response: Response, db: Session = Depends(get_session)):
    try:
        result = service.activate_account(db, body.token, body.password, body.password_confirmation,
                                          body.cpf, body.birth_date)
    except service.AuthError as exc:
        raise _password_error(exc) from None
    out = _account_out(result.account)
    if from_app(request):   # the same as the login: the token to the app, the cookie to the site
        return LoginOut(**out.model_dump(), session_token=result.session_token)
    _set_session_cookie(response, result.session_token)
    return LoginOut(**out.model_dump())


class SignatureIn(BaseModel):
    photographer_signature: str = Field(max_length=80)


class ChangePasswordIn(BaseModel):
    current_password: str = Field(max_length=200)
    password: str = Field(max_length=200)
    password_confirmation: str = Field(max_length=200)


@router.patch("/me", response_model=AccountOut)
def update_me(body: SignatureIn, request: Request, account: Account = Depends(current_account),
              db: Session = Depends(get_session)):
    """Only the signature is editable by the holder; name, e-mail and role belong to the
    administrator."""
    try:
        return _me_out(request, db, service.update_signature(db, account, body.photographer_signature))
    except service.AuthError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None


@router.put("/me/photo", response_model=AccountOut)
async def set_photo(request: Request, file: UploadFile = File(...), account: Account = Depends(current_account),
                    db: Session = Depends(get_session), storage: ObjectStorage = Depends(get_storage)):
    """Optional profile photo, instead of the initials. Saved again as a small JPEG without metadata."""
    try:
        profile_photo.save(db, storage, account, await file.read(profile_photo.MAX_BYTES + 1))
    except profile_photo.PhotoError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None
    return _me_out(request, db, account)


@router.delete("/me/photo", response_model=AccountOut)
def remove_photo(request: Request, account: Account = Depends(current_account), db: Session = Depends(get_session),
                 storage: ObjectStorage = Depends(get_storage)):
    profile_photo.remove(db, storage, account, actor=account)
    return _me_out(request, db, account)


@router.get("/me/photo")
def my_photo(account: Account = Depends(current_account_even_blocked), storage: ObjectStorage = Depends(get_storage)):
    """Only the account's own photo: nobody else's is served."""
    if not account.photo_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Sem foto de perfil.")
    return Response(storage.get(account.photo_key), media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


@router.post("/password/change", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(login_limiter)])
def change_password(body: ChangePasswordIn, request: Request, account: Account = Depends(current_account),
                    db: Session = Depends(get_session)):
    try:
        service.change_password(db, account, session_token(request) or "", body.current_password,
                                body.password, body.password_confirmation)
    except service.AuthError as exc:
        raise _password_error(exc) from None
