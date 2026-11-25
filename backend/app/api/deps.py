"""Dependencies shared by the API routes."""
from __future__ import annotations

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.auth import service
from app.db.models import Account, AccountRole
from app.db.session import get_session

SESSION_COOKIE = "fotomac_session"
# The account the SCREEN believes it is acting as. One browser keeps one session cookie for every tab:
# logging in with another account in another tab silently changes who the first tab acts as, while
# it still shows the old name (a real case: an administrator's publication made
# from a tab showing the hired photographer). The site sends this header; the mobile app, scripts and
# tests do not, and keep working as before.
ACCOUNT_HEADER = "X-Fotomac-Account"
# The mobile app (06/11/2026) has no browser cookies: it says it is the app and sends the session in the
# Authorization header instead. A browser never sends this header by itself, so it opens no door to other sites (CSRF).
CLIENT_HEADER = "X-Fotomac-Client"
# The visitor's facial-search session, in the app (in the site it is the fotomac_visit cookie).
VISIT_HEADER = "X-Fotomac-Visit"


def from_app(request: Request) -> bool:
    return request.headers.get(CLIENT_HEADER) == "app"


def session_token(request: Request) -> str | None:
    """The login session: the HttpOnly cookie of the site, or the app's "Authorization: Bearer"."""
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        return token
    auth = request.headers.get("authorization", "")
    return auth[7:].strip() or None if auth[:7].lower() == "bearer " else None


def _account(request: Request, db: Session, blocked_ok: bool) -> Account:
    # "Use" of the session = what the person does: writing something (POST, PUT, DELETE) or the screen telling
    # that the person is moving, typing or scrolling (POST /auth/activity). Reads (GET) never count: the bell
    # and the progress bars ask by themselves every few seconds and would keep an abandoned session alive.
    account = service.account_for_session(db, session_token(request), background=request.method == "GET",
                                          blocked_ok=blocked_ok)
    if account is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sua sessão expirou. Entre novamente.")
    expected = request.headers.get(ACCOUNT_HEADER)
    if expected and expected != str(account.id):
        # Nothing is done under an identity the person did not see on the screen.
        raise HTTPException(status.HTTP_409_CONFLICT, {
            "reason": "account_changed",
            "message": "Outra conta entrou neste navegador, em outra aba. Esta página vai ser atualizada; "
                       "para usar duas contas ao mesmo tempo, use uma janela anônima."})
    return account


def current_account(request: Request, db: Session = Depends(get_session)) -> Account:
    """Rejects the request BEFORE any processing when there is no valid session of an ACTIVE account.
    The check runs on the server, never only in the screen."""
    return _account(request, db, blocked_ok=False)


def current_account_even_blocked(request: Request, db: Session = Depends(get_session)) -> Account:
    """Also a suspended, inactive or expired account that logged in with the right password (31/10/2026). Only for
    the routes of the restricted screen: who I am, presence/activity, my photo, and the Support page."""
    return _account(request, db, blocked_ok=True)


def require_role(*roles: AccountRole):
    def checker(account: Account = Depends(current_account)) -> Account:
        if account.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Você não tem permissão para esta ação.")
        return account
    return checker
