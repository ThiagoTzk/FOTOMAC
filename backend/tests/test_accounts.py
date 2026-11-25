"""Accounts managed by the administrator, through the real API."""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.auth import passwords
from app.db import models as m
from app.db.session import get_session
from app.main import app
from app.notifications.factory import get_email_sender
from app.security.rate_limit import login_limiter, password_link_limiter

PASSWORD = "Fotomac#2026"


class Outbox:
    def __init__(self):
        self.sent = []

    def send(self, message):
        self.sent.append(message)

    def link(self):
        return re.search(r"primeiro-acesso\?token=([\w-]+)", self.sent[-1].body).group(1)


def make_account(db, name="Ana Lima", role=m.AccountRole.ADMIN, status=m.AccountStatus.ACTIVE) -> m.Account:
    a = m.Account(full_name=name, email=f"{uuid.uuid4().hex[:8]}@cesmac.edu.br", role=role,
                  photographer_signature=name if role == m.AccountRole.PHOTOGRAPHER else None,
                  password_hash=passwords.hash_password(PASSWORD) if status != m.AccountStatus.PENDING else None,
                  status=status)
    db.add(a)
    db.flush()
    return a


@pytest.fixture
def outbox():
    return Outbox()


@pytest.fixture
def client(db, outbox):
    login_limiter.reset()
    password_link_limiter.reset()
    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[get_email_sender] = lambda: outbox

    def for_account(account: m.Account) -> TestClient:
        c = TestClient(app)
        assert c.post("/api/v1/auth/login", json={"email": account.email, "password": PASSWORD}).status_code == 200
        return c
    yield for_account
    app.dependency_overrides.clear()


def new_photographer(c, email=None, **over):
    body = {"full_name": "Bruno Rocha", "email": email or f"{uuid.uuid4().hex[:8]}@cesmac.edu.br",
            "role": "photographer", "photographer_signature": "Bruno Rocha"}
    body.update(over)
    return c.post("/api/v1/admin/accounts", json=body)


# ----------------------------------------------------------------- access

def test_only_administrators_reach_these_routes(client, db):
    photographer = client(make_account(db, "Bruno Rocha", m.AccountRole.PHOTOGRAPHER))
    assert photographer.get("/api/v1/admin/accounts").status_code == 403
    assert new_photographer(photographer).status_code == 403
    assert TestClient(app).get("/api/v1/admin/accounts").status_code == 401


def test_there_is_no_delete(client, db):
    admin = client(make_account(db))
    target = make_account(db, "Bruno Rocha", m.AccountRole.PHOTOGRAPHER)
    assert admin.delete(f"/api/v1/admin/accounts/{target.id}").status_code == 405


# ----------------------------------------------------------------- create

def test_created_without_password_and_activated_by_single_use_link(client, db, outbox):
    admin = client(make_account(db))
    r = new_photographer(admin)
    assert r.status_code == 201
    body = r.json()
    assert body["status"] == "pending" and body["status_label"] == "Acesso Pendente" and body["activation_link"] == "valid"
    account = db.get(m.Account, uuid.UUID(body["id"]))
    assert account.password_hash is None                                  # never a system password
    assert outbox.sent[-1].to == account.email and PASSWORD not in outbox.sent[-1].body
    token = outbox.link()
    anon = TestClient(app)
    assert anon.post("/api/v1/auth/first-access", json={"token": token, "password": PASSWORD,
                                                        "password_confirmation": PASSWORD}).status_code == 200
    db.refresh(account)
    assert account.status == m.AccountStatus.ACTIVE
    log = db.scalar(select(m.AuditLog).where(m.AuditLog.action == "account.created", m.AuditLog.target_id == str(account.id)))
    assert log.actor_account_id is not None


@pytest.mark.parametrize("over,message", [
    ({"full_name": "Bruno"}, "nome completo"),                              # two words
    ({"email": "sem-arroba.cesmac.edu.br"}, "Falta o @"),
    ({"photographer_signature": ""}, "assinatura é obrigatória"),
    ({"full_name": "Bruno " + "B" * 120}, "120 caracteres"),
])
def test_validation(client, db, over, message):
    r = new_photographer(client(make_account(db)), **over)
    assert r.status_code == 400 and message in r.json()["detail"]


def test_email_is_unique_regardless_of_case(client, db):
    admin = client(make_account(db))
    assert new_photographer(admin, email="Bruno.Rocha@cesmac.edu.br").status_code == 201
    r = new_photographer(admin, email="bruno.rocha@CESMAC.edu.br")
    assert r.status_code == 400 and "Já existe" in r.json()["detail"]


def test_pending_first_and_link_can_be_resent(client, db, outbox):
    admin = client(make_account(db, "Ana Admin"))   # alphabetically BEFORE the pending one
    pending_id = new_photographer(admin, full_name="Zuleica Prado", photographer_signature="Zuleica").json()["id"]
    rows = admin.get("/api/v1/admin/accounts").json()["items"]
    assert rows[0]["id"] == pending_id                                    # pending highlighted first
    old = outbox.link()
    # Expired link → the list says so, and the administrator re-sends.
    db.execute(m.PasswordToken.__table__.update().values(expires_at=datetime.now(timezone.utc) - timedelta(minutes=1)))
    assert admin.get(f"/api/v1/admin/accounts/{pending_id}").json()["activation_link"] == "expired"
    assert admin.post(f"/api/v1/admin/accounts/{pending_id}/activation-link").status_code == 204
    new = outbox.link()
    assert new != old
    anon = TestClient(app)
    first = lambda t: anon.post("/api/v1/auth/first-access", json={"token": t, "password": PASSWORD, "password_confirmation": PASSWORD})
    assert first(old).status_code == 400 and first(new).status_code == 200
    assert admin.post(f"/api/v1/admin/accounts/{pending_id}/activation-link").status_code == 400   # already active


# TEMPORÁRIO — REMOVER JUNTO COM service.dev_activation_link.
def test_dev_only_link_display_never_exists_when_emails_are_really_sent(client, db, outbox, monkeypatch):
    from app.config import get_settings
    admin = client(make_account(db))
    pending_id = new_photographer(admin).json()["id"]
    emailed = outbox.link()
    monkeypatch.setattr(get_settings(), "email_sender", "outbox")      # development: e-mails become files
    assert admin.get(f"/api/v1/admin/accounts/{pending_id}").json()["dev_link_available"] is True
    url = admin.post(f"/api/v1/admin/accounts/{pending_id}/activation-link/dev").json()["url"]
    shown = url.split("token=")[1]
    anon = TestClient(app)
    first = lambda t: anon.post("/api/v1/auth/first-access", json={"token": t, "password": PASSWORD, "password_confirmation": PASSWORD})
    assert first(emailed).status_code == 400 and first(shown).status_code == 200   # single link alive at a time
    assert db.scalar(select(m.AuditLog).where(m.AuditLog.action == "account.activation_link_shown_dev"))
    assert admin.post(f"/api/v1/admin/accounts/{pending_id}/activation-link/dev").status_code == 400  # already active
    monkeypatch.setattr(get_settings(), "email_sender", "smtp")        # CESMAC server: real e-mail
    other = new_photographer(admin).json()
    assert other["dev_link_available"] is False
    assert admin.post(f"/api/v1/admin/accounts/{other['id']}/activation-link/dev").status_code == 404
    photographer = client(make_account(db, "Bruno Rocha", m.AccountRole.PHOTOGRAPHER))
    assert photographer.post(f"/api/v1/admin/accounts/{other['id']}/activation-link/dev").status_code == 403


# ----------------------------------------------------------------- edit and role

def test_role_change_is_logged_and_never_on_yourself(client, db):
    me = make_account(db)
    admin = client(me)
    target = make_account(db, "Bruno Rocha", m.AccountRole.PHOTOGRAPHER)
    r = admin.put(f"/api/v1/admin/accounts/{target.id}", json={"full_name": "Bruno Rocha", "role": "admin"})
    assert r.status_code == 200 and r.json()["role"] == "admin"
    log = db.scalar(select(m.AuditLog).where(m.AuditLog.action == "account.updated", m.AuditLog.target_id == str(target.id)))
    assert log.details["role"] == "photographer->admin" and log.actor_account_id == me.id
    assert admin.put(f"/api/v1/admin/accounts/{me.id}", json={"full_name": me.full_name, "role": "photographer",
                                                              "photographer_signature": "X"}).status_code == 403


# ----------------------------------------------------------------- status

def test_suspension_logs_emails_and_cuts_access_immediately(client, db, outbox):
    me = make_account(db)
    admin = client(me)
    target = make_account(db, "Bruno Rocha", m.AccountRole.PHOTOGRAPHER)
    photographer = client(target)
    assert photographer.get("/api/v1/dashboard").status_code == 200
    r = admin.post(f"/api/v1/admin/accounts/{target.id}/status", json={"status": "suspended"})
    assert r.status_code == 200 and r.json()["status_label"] == "Suspensa"
    assert photographer.get("/api/v1/dashboard").status_code == 401        # on every device, at once
    assert outbox.sent[-1].to == target.email and "suspensa" in outbox.sent[-1].body
    log = db.scalar(select(m.AuditLog).where(m.AuditLog.action == "account.status_changed"))
    assert log.actor_account_id == me.id and log.details == {"previous": "active", "current": "suspended"}
    # 31/10/2026: the right password enters ONLY the restricted screen (the generic error stays for a wrong one).
    restricted = TestClient(app)
    login = restricted.post("/api/v1/auth/login", json={"email": target.email, "password": PASSWORD})
    assert login.status_code == 200 and login.json()["status"] == "suspended"
    assert restricted.get("/api/v1/dashboard").status_code == 401
    admin.post(f"/api/v1/admin/accounts/{target.id}/status", json={"status": "active"})
    assert TestClient(app).post("/api/v1/auth/login", json={"email": target.email, "password": PASSWORD}).json()["status"] == "active"


def test_photos_and_events_stay_when_the_photographer_is_suspended(client, db, make_event, photographer):
    """Nothing is deleted; the administrator answers for the events."""
    me = make_account(db)
    admin = client(me)
    event = make_event()
    assert admin.post(f"/api/v1/admin/accounts/{photographer.id}/status", json={"status": "inactive"}).status_code == 200
    assert db.get(m.Event, event.id) is not None
    assert admin.get(f"/api/v1/events/{event.id}").json()["can_manage"] is True


def test_cannot_lock_yourself_out_or_leave_the_system_without_admin(client, db):
    me = make_account(db)
    admin = client(me)
    assert admin.post(f"/api/v1/admin/accounts/{me.id}/status", json={"status": "suspended"}).status_code == 403
    other = make_account(db, "Bruno Admin")
    assert admin.post(f"/api/v1/admin/accounts/{other.id}/status", json={"status": "inactive"}).status_code == 200
    assert admin.post(f"/api/v1/admin/accounts/{other.id}/status", json={"status": "pending"}).status_code == 400


def test_reactivating_an_account_that_never_had_a_password_waits_for_the_holder(client, db, outbox):
    admin = client(make_account(db))
    pending = make_account(db, "Bruno Rocha", m.AccountRole.PHOTOGRAPHER, m.AccountStatus.PENDING)
    admin.post(f"/api/v1/admin/accounts/{pending.id}/status", json={"status": "inactive"})
    r = admin.post(f"/api/v1/admin/accounts/{pending.id}/status", json={"status": "active"})
    assert r.json()["status"] == "pending"                                 # cannot be "Ativa" without a password
    assert "primeiro-acesso?token=" in outbox.sent[-1].body


# ----------------------------------------------------------------- unlock

def test_administrator_unlocks_after_five_wrong_passwords(client, db):
    admin = client(make_account(db))
    target = make_account(db, "Bruno Rocha", m.AccountRole.PHOTOGRAPHER)
    anon = TestClient(app)
    for _ in range(5):
        anon.post("/api/v1/auth/login", json={"email": target.email, "password": "Errada#123"})
    assert admin.get(f"/api/v1/admin/accounts/{target.id}").json()["locked"] is True
    assert anon.post("/api/v1/auth/login", json={"email": target.email, "password": PASSWORD}).status_code == 401
    assert admin.post(f"/api/v1/admin/accounts/{target.id}/unlock").json()["locked"] is False
    assert anon.post("/api/v1/auth/login", json={"email": target.email, "password": PASSWORD}).status_code == 200


def test_an_email_with_two_at_signs_is_refused():
    """28/10/2026: "nome@@cesmac.edu.br" had been accepted (only the presence of an "@" was checked)."""
    from app import email_address
    assert not email_address.valid("offsetGhap4897@@cesmac.edu.br")
    assert not email_address.valid("nome@cesmac")
    assert not email_address.valid("nome..x@cesmac.edu.br")
    assert email_address.valid("nome.sobrenome@academico.cesmac.edu.br")
    assert email_address.valid("pessoal+fotos@hotmail.com")


@pytest.mark.parametrize("email,message", [
    ("", "Informe o e-mail"),
    ("nome @cesmac.edu.br", "espaços"),
    ("nome.cesmac.edu.br", "Falta o @"),
    ("nome@@cesmac.edu.br", "mais de um @"),
    ("a@b@cesmac.edu.br", "mais de um @"),
    ("@cesmac.edu.br", "antes do @"),
    ("x" * 65 + "@cesmac.edu.br", "64 caracteres"),
    ("joão@cesmac.edu.br", "letras sem acento"),
    ("nome,x@cesmac.edu.br", "letras sem acento"),
    (".nome@cesmac.edu.br", "começar nem terminar com ponto"),
    ("nome.@cesmac.edu.br", "começar nem terminar com ponto"),
    ("no..me@cesmac.edu.br", "dois pontos seguidos"),
    ("nome@", "Falta o domínio"),
    ("nome@cesmac_edu.br", "hífen e ponto"),
    ("nome@.cesmac.edu.br", "domínio não pode começar"),
    ("nome@cesmac.edu.br.", "domínio não pode começar"),
    ("nome@cesmac", "precisa de um ponto"),
    ("nome@-cesmac.edu.br", "hífen"),
    ("nome@cesmac.b", "ao menos 2 letras"),
    ("nome@cesmac.123", "ao menos 2 letras"),
])
def test_each_broken_email_rule_says_what_to_fix(email, message):
    """31/10/2026: rules like a real site, each with its own message (the same in the browser)."""
    from app import email_address
    assert message in email_address.problem(email)


def test_the_screen_and_the_server_use_the_same_email_messages():
    """Every message of the server is also in frontend/src/auth/email-rules.ts (the form shows it before sending)."""
    import re
    from pathlib import Path

    from app import email_address
    server = set(re.findall(r'return f?"([^"]+)"', Path(email_address.__file__).read_text()))
    assert len(server) >= 17
    screen = Path(__file__).parents[2] / "frontend/src/auth/email-rules.ts"
    text = re.sub(r"\$\{[^}]*\}", "{}", screen.read_text())     # a number in the message: {} on both sides
    for message in server:
        assert re.sub(r"\{[^}]*\}", "{}", message) in text, message
