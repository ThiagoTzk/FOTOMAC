"""Authentication through the real HTTP API."""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api.deps import SESSION_COOKIE
from app.auth import service
from app.db import models as m
from app.db.session import get_session
from app.main import app
from app.notifications.factory import get_email_sender
from app.security.rate_limit import login_limiter, password_link_limiter

STRONG = "Fotomac#2026"


class FakeSender:
    def __init__(self):
        self.sent = []

    def send(self, message):
        self.sent.append(message)

    def last_token(self) -> str:
        return re.search(r"token=([\w-]+)", self.sent[-1].body).group(1)


@pytest.fixture
def sender():
    return FakeSender()


@pytest.fixture
def client(db, sender):
    login_limiter.reset()
    password_link_limiter.reset()
    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[get_email_sender] = lambda: sender
    # Without "with": the startup (model loading) is not needed for these routes.
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture
def pending(db, sender) -> m.Account:
    account = m.Account(full_name="Bruno Rocha", email="bruno.teste@cesmac.edu.br",
                        role=m.AccountRole.PHOTOGRAPHER, photographer_signature="Bruno Rocha")
    db.add(account)
    db.flush()
    service.send_activation_link(db, account, sender)
    return account


@pytest.fixture
def active(client, pending, sender) -> m.Account:
    r = client.post("/api/v1/auth/first-access", json={
        "token": sender.last_token(), "password": STRONG, "password_confirmation": STRONG})
    assert r.status_code == 200
    client.cookies.clear()
    return pending


def login(client, email="bruno.teste@cesmac.edu.br", password=STRONG, remember=False):
    return client.post("/api/v1/auth/login", json={"email": email, "password": password, "remember": remember})


# ----------------------------------------------------------------- first access

def test_account_is_created_without_password_and_cannot_log_in(client, pending):
    assert pending.status == m.AccountStatus.PENDING and pending.password_hash is None
    assert login(client, password="").status_code == 401


def test_first_access_full_flow(client, pending, sender, db):
    token = sender.last_token()
    assert client.post("/api/v1/auth/first-access/check", json={"token": token}).json() == {
        "valid": True, "needs_identity": False, "full_name": None}   # identification: hired photographer only

    weak = client.post("/api/v1/auth/first-access",
                       json={"token": token, "password": "abc", "password_confirmation": "abc"})
    assert weak.status_code == 400
    assert set(weak.json()["detail"]["failed_rules"]) == {"min_length", "upper_lower", "digit_special"}

    mismatch = client.post("/api/v1/auth/first-access",
                           json={"token": token, "password": STRONG, "password_confirmation": STRONG + "x"})
    assert mismatch.json()["detail"]["message"] == "As senhas não coincidem."

    ok = client.post("/api/v1/auth/first-access",
                     json={"token": token, "password": STRONG, "password_confirmation": STRONG})
    assert ok.status_code == 200 and SESSION_COOKIE in ok.cookies
    db.refresh(pending)
    assert pending.status == m.AccountStatus.ACTIVE
    assert pending.password_hash.startswith("$argon2id$")       # never the plain password
    assert STRONG not in pending.password_hash
    assert client.get("/api/v1/auth/me").json()["full_name"] == "Bruno Rocha"

    # Single use: the same link cannot be used again.
    again = client.post("/api/v1/auth/first-access",
                        json={"token": token, "password": STRONG, "password_confirmation": STRONG})
    assert again.status_code == 400 and "inválido" in again.json()["detail"]["message"]


def test_expired_activation_link_is_refused(client, pending, sender, db):
    token = sender.last_token()
    link = db.scalar(select(m.PasswordToken).where(m.PasswordToken.account_id == pending.id))
    link.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    db.flush()
    assert client.post("/api/v1/auth/first-access/check", json={"token": token}).json()["valid"] is False


def test_reissuing_the_link_invalidates_the_previous_one(client, pending, sender, db):
    first = sender.last_token()
    service.send_activation_link(db, pending, sender)
    assert client.post("/api/v1/auth/first-access/check", json={"token": first}).json()["valid"] is False
    assert client.post("/api/v1/auth/first-access/check", json={"token": sender.last_token()}).json()["valid"] is True


def test_tokens_are_stored_only_as_hashes(pending, sender, db):
    token = sender.last_token()
    stored = db.scalar(select(m.PasswordToken.token_hash).where(m.PasswordToken.account_id == pending.id))
    assert stored != token and len(stored) == 64


# ----------------------------------------------------------------- login

def test_login_and_logout(client, active, db):
    r = login(client)
    assert r.status_code == 200 and SESSION_COOKIE in r.cookies
    assert "token" not in r.text                                 # the token is only in the cookie
    assert client.get("/api/v1/auth/me").status_code == 200
    assert client.post("/api/v1/auth/logout").status_code == 204
    assert client.get("/api/v1/auth/me").status_code == 401


def test_cookie_is_httponly_and_samesite(client, active):
    header = login(client).headers["set-cookie"].lower()
    assert "httponly" in header and "samesite=lax" in header and "path=/api" in header


def _session_row(db, account) -> m.Session:
    return db.scalars(select(m.Session).where(m.Session.account_id == account.id)
                      .order_by(m.Session.id.desc())).first()


def test_without_keep_signed_in_the_cookie_dies_with_the_browser(client, active, db):
    header = login(client).headers["set-cookie"].lower()
    assert "max-age" not in header and "expires" not in header    # a browser-session cookie
    left = _session_row(db, active).expires_at - datetime.now(timezone.utc)
    assert timedelta(hours=7) < left <= timedelta(hours=8)          # and the server ends it after 8 h


def test_keep_signed_in_lasts_thirty_days(client, active, db):
    r = client.post("/api/v1/auth/login", json={"email": active.email, "password": STRONG, "remember": True})
    assert r.status_code == 200
    assert f"max-age={30 * 24 * 3600}" in r.headers["set-cookie"].lower().replace(" ", "")
    left = _session_row(db, active).expires_at - datetime.now(timezone.utc)
    assert timedelta(days=29) < left <= timedelta(days=30)
    audit = db.scalars(select(m.AuditLog).where(m.AuditLog.action == "auth.login")).all()[-1]
    assert audit.details == {"remember": True}


def test_session_lifetime():
    """8 hours, or 30 days with "Manter conectado". A temporary account's session is no longer cut at the end of its
    time (31/10/2026): from then on it reaches only the restricted screen — proved in
    test_profiles_v2.test_the_account_expires_at_the_end_of_its_period_and_is_kept."""
    hired = m.Account(role=m.AccountRole.CONTRACTOR, valid_until=datetime.now(timezone.utc) + timedelta(hours=5))
    assert service.session_lifetime(hired, remember=False) == timedelta(hours=8)
    staff = m.Account(role=m.AccountRole.PHOTOGRAPHER)
    assert service.session_lifetime(staff, remember=True) == timedelta(days=30)


def test_wrong_password_and_unknown_email_get_the_same_answer(client, active):
    """No hint about which accounts exist."""
    wrong = login(client, password="Errada#123")
    unknown = login(client, email="ninguem@cesmac.edu.br")
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json() == {"detail": service.GENERIC_LOGIN_ERROR}


def test_email_is_case_insensitive(client, active):
    assert login(client, email="BRUNO.TESTE@cesmac.edu.br").status_code == 200


def test_lockout_after_five_failures_and_reset_unlocks(client, active, sender):
    for _ in range(5):
        assert login(client, password="Errada#123").status_code == 401
    assert login(client).status_code == 401                      # right password, but locked

    client.post("/api/v1/auth/password/forgot", json={"email": "bruno.teste@cesmac.edu.br"})
    r = client.post("/api/v1/auth/password/reset", json={
        "token": sender.last_token(), "password": "Nova#Senha9", "password_confirmation": "Nova#Senha9"})
    assert r.status_code == 204
    assert login(client, password="Nova#Senha9").status_code == 200   # recovery e-mail unlocks


def test_password_reset_ends_all_other_sessions(client, active, sender):
    """Changing the password logs out every other device."""
    assert login(client).status_code == 200
    assert client.get("/api/v1/auth/me").status_code == 200
    client.post("/api/v1/auth/password/forgot", json={"email": active.email})
    client.post("/api/v1/auth/password/reset", json={
        "token": sender.last_token(), "password": "Outra#Senha1", "password_confirmation": "Outra#Senha1"})
    assert client.get("/api/v1/auth/me").status_code == 401


def test_forgot_password_does_not_reveal_unknown_emails(client, active, sender):
    before = len(sender.sent)
    known = client.post("/api/v1/auth/password/forgot", json={"email": active.email})
    unknown = client.post("/api/v1/auth/password/forgot", json={"email": "ninguem@cesmac.edu.br"})
    assert known.status_code == unknown.status_code == 202 and known.json() == unknown.json()
    assert len(sender.sent) == before + 1                        # e-mail only to the real account


def test_reset_link_cannot_activate_and_vice_versa(client, active, sender):
    client.post("/api/v1/auth/password/forgot", json={"email": active.email})
    reset_token = sender.last_token()
    r = client.post("/api/v1/auth/first-access",
                    json={"token": reset_token, "password": STRONG, "password_confirmation": STRONG})
    assert r.status_code == 400


def test_suspension_cuts_an_open_session_immediately(client, active, db):
    """Status is re-checked on every request, on the server: only the restricted screen is left (31/10/2026)."""
    assert login(client).status_code == 200
    active.status = m.AccountStatus.SUSPENDED
    db.flush()
    assert client.get("/api/v1/dashboard").status_code == 401
    assert client.get("/api/v1/events").status_code == 401
    assert client.get("/api/v1/auth/me").json()["status"] == "suspended"


def test_protected_route_without_cookie_is_refused(client):
    assert client.get("/api/v1/auth/me").status_code == 401


def test_login_rate_limit(client, active):
    codes = [login(client, password="Errada#123").status_code for _ in range(11)]
    assert codes[-1] == 429


def test_audit_trail_records_logins_without_typed_emails(client, active, db):
    login(client)
    login(client, email="intruso@exemplo.com")
    actions = db.scalars(select(m.AuditLog.action).order_by(m.AuditLog.id)).all()
    assert "auth.login" in actions and "auth.login_failed" in actions
    details = db.scalars(select(m.AuditLog.details)).all()
    assert "intruso@exemplo.com" not in str(details)


def test_password_rules_endpoint_matches_the_screens(client):
    labels = [r["label"] for r in client.get("/api/v1/auth/password-rules").json()]
    assert labels == ["No mínimo 8 caracteres", "Uma letra maiúscula e uma minúscula",
                      "Um número e um caractere especial"]


def test_an_unexpected_error_is_a_readable_500_that_the_browser_can_read(monkeypatch):
    """22/10/2026: a server error used to reach the screen as "não foi possível conectar" — the 500 had
    no CORS headers and the browser discarded it. Now it is plain Portuguese, with the CORS headers."""
    from fastapi.testclient import TestClient as Client
    from app import main
    from app.public import service as public_service

    def broken(*_args, **_kwargs):
        raise RuntimeError("boom")
    from app.db.session import get_session
    monkeypatch.setattr(public_service, "list_public_events", broken)
    main.app.dependency_overrides[get_session] = lambda: None   # never the development database
    try:
        origin = main.get_settings().cors_origins[0]
        r = Client(main.app).get("/api/v1/public/events", headers={"Origin": origin})
    finally:
        main.app.dependency_overrides.clear()
    assert r.status_code == 500 and r.json()["detail"] == main.INTERNAL_ERROR
    assert r.headers.get("access-control-allow-origin") == origin


def test_a_tab_never_acts_as_an_account_it_does_not_show(client, active):
    """22/10/2026: one browser, one session cookie for every tab. A tab still SHOWING the hired photographer
    must not publish as the administrator who logged in in another tab: the site says which account it
    believes it is, and the server refuses when the session is another one."""
    assert login(client).status_code == 200
    assert client.get("/api/v1/auth/me", headers={"X-Fotomac-Account": str(active.id)}).status_code == 200
    r = client.get("/api/v1/auth/me", headers={"X-Fotomac-Account": "00000000-0000-0000-0000-000000000000"})
    assert r.status_code == 409 and r.json()["detail"]["reason"] == "account_changed"
    assert client.get("/api/v1/auth/me").status_code == 200        # the app, scripts and tests send no header


def test_a_session_without_use_ends_but_keep_signed_in_does_not(client, active, db):
    """25/10/2026: idle_minutes without use and the session ends, on the server. Reads (GET, like the bell asking
    by itself) are not use; writes and POST /auth/activity are. "Manter conectado" is exempt."""
    from app.config import get_settings
    idle = get_settings().idle_minutes
    login(client)
    me = client.get("/api/v1/auth/me").json()
    assert me["idle_minutes"] == idle and 0 < me["idle_left_seconds"] <= idle * 60
    row = _session_row(db, active)
    row.last_activity_at = datetime.now(timezone.utc) - timedelta(minutes=idle - 1)
    db.flush()
    assert client.get("/api/v1/auth/me").status_code == 200
    db.refresh(row)
    assert row.last_activity_at < datetime.now(timezone.utc) - timedelta(minutes=idle - 2)   # a read: not use
    assert client.post("/api/v1/auth/activity").status_code == 204                            # the person moved
    db.refresh(row)
    assert row.last_activity_at > datetime.now(timezone.utc) - timedelta(seconds=5)
    row.last_activity_at = datetime.now(timezone.utc) - timedelta(minutes=idle, seconds=1)
    db.flush()
    assert client.get("/api/v1/auth/me").status_code == 401                                   # ended for inactivity
    db.refresh(row)
    assert row.revoked_at is not None
    assert db.scalars(select(m.AuditLog.action).where(m.AuditLog.action == "auth.session_idle")).first()

    client.cookies.clear()
    r = client.post("/api/v1/auth/login", json={"email": active.email, "password": STRONG, "remember": True})
    assert r.json()["idle_minutes"] is None
    kept = _session_row(db, active)
    kept.last_activity_at = datetime.now(timezone.utc) - timedelta(days=3)
    db.flush()
    assert client.get("/api/v1/auth/me").status_code == 200                                   # "Manter conectado"


def test_closing_the_browser_ends_a_session_without_keep_signed_in(client, active, db):
    """28/10/2026: the browser restores the session cookie when it reopens "where it left off", so the server
    must know no tab is open. The last tab says it closed: a reload comes back in time and keeps the session;
    a page coming back later lands on the login. Tabs that stop giving signs of life end it too."""
    from app.auth.service import CLOSE_GRACE_SECONDS, PRESENCE_GRACE_MINUTES
    login(client)
    assert client.get("/api/v1/auth/presence").status_code == 204
    row = _session_row(db, active)
    db.refresh(row)
    assert row.seen_at is not None and row.last_activity_at is not None
    assert client.post("/api/v1/auth/presence/closed").status_code == 204                     # a reload…
    assert client.get("/api/v1/auth/me").status_code == 200                                    # …came back in time
    db.refresh(row)
    assert row.closed_at is None
    client.post("/api/v1/auth/presence/closed")                                                # browser closed
    row.closed_at = datetime.now(timezone.utc) - timedelta(seconds=CLOSE_GRACE_SECONDS + 1)
    db.flush()
    assert client.get("/api/v1/auth/me").status_code == 401                                   # reopened later
    db.refresh(row)
    assert row.revoked_at is not None
    assert db.scalars(select(m.AuditLog.action).where(m.AuditLog.action == "auth.session_closed")).first()

    client.cookies.clear()
    login(client)
    client.get("/api/v1/auth/presence")
    row = _session_row(db, active)
    row.seen_at = datetime.now(timezone.utc) - timedelta(minutes=PRESENCE_GRACE_MINUTES, seconds=1)
    db.flush()
    assert client.get("/api/v1/auth/me").status_code == 401                                   # no tab for 5 minutes

    client.cookies.clear()
    client.post("/api/v1/auth/login", json={"email": active.email, "password": STRONG, "remember": True})
    client.post("/api/v1/auth/presence/closed")
    kept = _session_row(db, active)
    kept.closed_at = datetime.now(timezone.utc) - timedelta(days=1)
    db.flush()
    assert client.get("/api/v1/auth/me").status_code == 200                                   # "Manter conectado"


@pytest.mark.parametrize("blocked", [m.AccountStatus.EXPIRED, m.AccountStatus.SUSPENDED, m.AccountStatus.INACTIVE])
def test_a_blocked_account_enters_only_the_restricted_screen_with_the_right_password(client, active, db, blocked):
    """31/10/2026 (user test: a suspended account got only the generic error and nowhere to go). With the RIGHT
    password it enters the restricted screen: its situation, its data and the Support page. A wrong password still
    gets the generic message — the login never reveals who has an account."""
    from app.auth.service import GENERIC_LOGIN_ERROR
    active.status = blocked
    db.flush()
    r = login(client, password="Errada#2026x")
    assert r.status_code == 401 and r.json()["detail"] == GENERIC_LOGIN_ERROR
    r = login(client, remember=True)
    assert r.status_code == 200 and r.json()["status"] == blocked.value and r.json()["blocked"] is not None
    assert r.json()["idle_minutes"] is not None                                   # never "Manter conectado"
    assert db.scalar(select(m.Session).where(m.Session.account_id == active.id)).remember is False
    # Reachable: who I am, presence, the Support page. Nothing else.
    assert client.get("/api/v1/auth/me").status_code == 200
    assert client.get("/api/v1/auth/presence").status_code == 204
    sent = client.post("/api/v1/support", json={"kind": "access", "subject": "Reativar minha conta",
                                                 "message": "Preciso enviar as fotos que faltam."})
    assert sent.status_code == 201 and sent.json()["kind_label"] == "Acesso à conta"
    assert client.get("/api/v1/support/mine").json()[0]["subject"] == "Reativar minha conta"
    for path in ("/api/v1/dashboard", "/api/v1/events", "/api/v1/notifications", "/api/v1/themes"):
        assert client.get(path).status_code == 401, path
    assert client.patch("/api/v1/auth/me", json={"photographer_signature": "X"}).status_code == 401
    assert "auth.login_restricted" in db.scalars(select(m.AuditLog.action)).all()
