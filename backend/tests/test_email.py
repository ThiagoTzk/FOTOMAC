"""E-mail (17/11/2026): the SMTP adapter for the CESMAC mail server and what happens when that server fails.

The SMTP server is simulated (smtplib replaced by a recorder): the tests prove what the adapter ASKS of the server
(encryption, login, the message), not that a real server delivers. The real delivery is checked at the
installation with scripts/send_test_email.py.
"""
from __future__ import annotations

import logging
import smtplib
import ssl
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.config import get_settings
from app.db import models as m
from app.db.session import get_session
from app.events.expiry import notify_expiring
from app.api import institutional as institutional_api
from app.main import app
from app.notifications.factory import get_email_sender
from app.notifications.port import EmailDeliveryError, EmailMessage, notify
from app.notifications.smtp_sender import SmtpEmailSender
from app.public.service import conclude_removals
from app.security.rate_limit import login_limiter, password_link_limiter
from tests import test_public as pub
from tests.test_accounts import Outbox, make_account, new_photographer
from tests.test_public import engine, env  # noqa: F401  (fixtures)

PASSWORD = "Fotomac#2026"
LINK = "http://localhost:8081/primeiro-acesso?token=abc-123"


def smtp_settings(**over):
    values = dict(email_sender="smtp", smtp_host="smtp.cesmac.test", smtp_port=587, smtp_security="starttls",
                  smtp_username="fotomac", smtp_password="segredo-do-smtp", smtp_timeout_seconds=7,
                  email_from="FOTOMAC <nao-responda@cesmac.edu.br>")
    values.update(over)
    return get_settings().model_validate({**get_settings().model_dump(), **values})


class FakeSmtp:
    """Records what the adapter asks of the server. `fail` = {step: exception} to simulate a refusal."""
    calls: list = []
    fail: dict = {}

    def __init__(self, host, port, timeout=None, context=None):
        FakeSmtp.calls.append(("connect", type(self).__name__, host, port, timeout, context))

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        FakeSmtp.calls.append(("quit",))

    def _step(self, name, *args):
        FakeSmtp.calls.append((name, *args))
        if name in FakeSmtp.fail:
            raise FakeSmtp.fail[name]

    def starttls(self, context=None):
        self._step("starttls", context)

    def login(self, user, password):
        self._step("login", user, password)

    def send_message(self, msg):
        self._step("send", msg)


class FakeSmtpSsl(FakeSmtp):
    pass


@pytest.fixture
def fake_smtp(monkeypatch):
    FakeSmtp.calls, FakeSmtp.fail = [], {}
    monkeypatch.setattr(smtplib, "SMTP", FakeSmtp)
    monkeypatch.setattr(smtplib, "SMTP_SSL", FakeSmtpSsl)
    return FakeSmtp


def message(to="pessoa@cesmac.edu.br"):
    return EmailMessage(to=to, subject="FOTOMAC: defina sua senha de acesso", body=f"Olá.\n\n{LINK}\n\nEquipe FOTOMAC")


class DownSender:
    """A mail server that is down."""
    def send(self, _message):
        raise EmailDeliveryError("the mail server did not accept the message (ConnectionRefusedError)")


# ----------------------------------------------------------------- the SMTP adapter

def test_starttls_checks_the_certificate_logs_in_and_sends_the_whole_message(fake_smtp):
    SmtpEmailSender(smtp_settings()).send(message())
    (connect, starttls, login, send, quit_) = fake_smtp.calls
    assert connect[1:5] == ("FakeSmtp", "smtp.cesmac.test", 587, 7)                  # with a time limit
    context = starttls[1]
    assert isinstance(context, ssl.SSLContext) and context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname
    assert login == ("login", "fotomac", "segredo-do-smtp")                           # only after encrypting
    msg = send[1]
    assert msg["From"] == "FOTOMAC <nao-responda@cesmac.edu.br>" and msg["To"] == "pessoa@cesmac.edu.br"
    assert msg["Subject"] == "FOTOMAC: defina sua senha de acesso"
    assert msg["Date"] and msg["Message-ID"].endswith("@cesmac.edu.br>")
    assert LINK in msg.get_content()                                                  # the link arrives intact
    assert quit_ == ("quit",)


def test_ssl_port_encrypts_from_the_first_byte(fake_smtp):
    SmtpEmailSender(smtp_settings(smtp_security="ssl", smtp_port=465)).send(message())
    connect = fake_smtp.calls[0]
    assert connect[1] == "FakeSmtpSsl" and connect[3] == 465 and connect[5].verify_mode == ssl.CERT_REQUIRED
    assert "starttls" not in [c[0] for c in fake_smtp.calls]


def test_relay_by_address_sends_without_login_but_still_encrypted(fake_smtp):
    SmtpEmailSender(smtp_settings(smtp_username=None, smtp_password=None)).send(message())
    steps = [c[0] for c in fake_smtp.calls]
    assert steps == ["connect", "starttls", "send", "quit"]


@pytest.mark.parametrize("over, wrong", [
    ({"smtp_host": None}, "FOTOMAC_SMTP_HOST"),
    ({"smtp_security": "none"}, "never unencrypted"),
    ({"smtp_password": None}, "FOTOMAC_SMTP_PASSWORD"),
])
def test_an_incomplete_or_unencrypted_configuration_is_refused(over, wrong):
    with pytest.raises(ValueError, match=wrong):
        SmtpEmailSender(smtp_settings(**over))


@pytest.mark.parametrize("step, error, says", [
    ("login", smtplib.SMTPAuthenticationError(535, b"5.7.8 fotomac segredo-do-smtp rejected for pessoa@cesmac.edu.br"),
     "refused the FOTOMAC login (code 535)"),
    ("starttls", smtplib.SMTPNotSupportedError("STARTTLS extension not supported by server."), "does not offer encryption"),
    ("send", smtplib.SMTPRecipientsRefused({"pessoa@cesmac.edu.br": (550, b"no such user")}), "refused the recipient"),
    ("send", ConnectionResetError("reset by peer"), "did not accept the message (ConnectionResetError)"),
])
def test_server_refusals_become_safe_errors(fake_smtp, step, error, says):
    fake_smtp.fail[step] = error
    with pytest.raises(EmailDeliveryError) as caught:
        SmtpEmailSender(smtp_settings()).send(message())
    text = str(caught.value)
    assert says in text
    # Never the address, the password or the server's own reply (which may echo them).
    assert "pessoa" not in text and "segredo" not in text and caught.value.__cause__ is None


def test_the_password_never_shows_in_the_settings_printout():
    s = smtp_settings()
    assert "segredo-do-smtp" not in repr(s) and "segredo-do-smtp" not in str(s.model_dump())


def test_the_factory_offers_smtp_and_the_outbox_writes_the_same_message(tmp_path):
    from app.notifications.factory import SENDERS
    from app.notifications.outbox_sender import OutboxEmailSender
    assert set(SENDERS) == {"outbox", "smtp"}
    written = OutboxEmailSender(tmp_path).send(message()).read_text()
    assert "From: FOTOMAC <nao-responda@cesmac.edu.br>" in written and "Message-ID:" in written and LINK in written


# ----------------------------------------------------------------- an informative e-mail never stops anything

def test_notify_logs_only_the_domain_and_goes_on(caplog):
    with caplog.at_level(logging.WARNING, logger="fotomac.email"):
        assert notify(DownSender(), message(to="eu.mesmo@exemplo.com")) is False
    logged = caplog.text
    assert "*@exemplo.com" in logged and "eu.mesmo" not in logged and LINK not in logged


def test_the_removal_deletion_goes_on_with_the_mail_server_down(db, make_event, make_image):
    """LGPD: the image is deleted in 72 h whatever happens to the e-mail; the contact address is erased anyway."""
    image = make_image(make_event(), m.ImageReviewStatus.PUBLISHED)
    req = m.RemovalRequest(id=uuid.uuid4(), image_id=image.id, event_id=image.event_id, contact_email="eu@exemplo.com",
                           deadline_at=datetime.now(timezone.utc) + timedelta(hours=72))
    db.add(req)
    db.flush()
    conclude_removals(db, DownSender(), image.id, m.RemovalStatus.DELETED_AUTOMATICALLY)
    assert req.status == m.RemovalStatus.DELETED_AUTOMATICALLY and req.contact_email is None


def test_the_expiry_notice_is_tried_again_while_the_mail_server_is_down(db, make_event):
    event = make_event()
    event.expires_on = date.today() + timedelta(days=10)
    db.flush()
    notify_expiring(db, DownSender())
    assert event.expiry_notice_sent_at is None                     # not marked: the next round tries again
    outbox = Outbox()
    notify_expiring(db, outbox)
    assert event.expiry_notice_sent_at is not None and outbox.sent[-1].subject.startswith("FOTOMAC: o evento")


def test_a_removal_request_is_registered_with_the_mail_server_down(env, db, engine):  # noqa: F811
    storage, _ = env
    app.dependency_overrides[get_email_sender] = lambda: DownSender()
    owner = pub.photographer(db)
    e = pub.make_event(db, owner)
    (group_id,) = pub.publish_and_index(db, storage, engine, owner, e, [pub.GROUP])
    c = TestClient(app)
    pub.consent(c, e)
    pub.search(c, e, pub.person_crop())
    r = c.post(f"/api/v1/public/images/{group_id}/removal", json={"contact_email": "eu@exemplo.com"})
    assert r.status_code == 200                                    # the visitor's request is not lost
    assert db.get(m.Image, group_id).removal_requested_at is not None


# ----------------------------------------------------------------- a link the person needs: whoever acted is told

@pytest.fixture
def admin_client(db):
    login_limiter.reset()
    password_link_limiter.reset()
    app.dependency_overrides[get_session] = lambda: db
    admin = make_account(db)
    c = TestClient(app)
    assert c.post("/api/v1/auth/login", json={"email": admin.email, "password": PASSWORD}).status_code == 200
    yield c
    app.dependency_overrides.clear()


def test_account_created_with_the_mail_server_down_is_saved_and_the_link_resent_later(admin_client, db):
    """Creation: the account opens with the warning (a 503 would keep the form, and a second try says "já
    cadastrado"). Resending while the server is still down: the screen is told (503)."""
    app.dependency_overrides[get_email_sender] = lambda: DownSender()
    email = f"{uuid.uuid4().hex[:8]}@cesmac.edu.br"
    r = new_photographer(admin_client, email=email)
    assert r.status_code == 201 and r.json()["link_sent"] is False and r.json()["email"] == email
    account = db.scalar(select(m.Account).where(m.Account.email == email))
    assert account is not None and account.status == m.AccountStatus.PENDING

    again = admin_client.post(f"/api/v1/admin/accounts/{account.id}/activation-link")
    assert again.status_code == 503 and again.json()["detail"]["reason"] == "email_not_sent"
    assert "foi salvo" in again.json()["detail"]["message"] and "ConnectionRefused" not in again.text

    outbox = Outbox()
    app.dependency_overrides[get_email_sender] = lambda: outbox    # the server is back
    assert admin_client.post(f"/api/v1/admin/accounts/{account.id}/activation-link").status_code == 204
    assert outbox.sent[-1].to == email and "primeiro-acesso?token=" in outbox.sent[-1].body


def test_a_normal_creation_says_the_link_left(admin_client, db):
    outbox = Outbox()
    app.dependency_overrides[get_email_sender] = lambda: outbox
    r = new_photographer(admin_client)
    assert r.status_code == 201 and r.json()["link_sent"] is True and len(outbox.sent) == 1


def test_institutional_person_registered_with_the_mail_server_down_opens_with_the_warning(env, db):  # noqa: F811
    from tests import test_institutional as inst
    institutional_api.link_limiter.reset()
    login_limiter.reset()
    app.dependency_overrides[get_email_sender] = lambda: DownSender()
    admin = inst.client_for(inst.account(db, m.AccountRole.ADMIN))
    email = f"m.collins.{uuid.uuid4().hex[:4]}@cesmac.edu.br"
    r = inst.register(admin, email=email)
    assert r.status_code == 201 and r.json()["link_sent"] is False
    person = db.scalar(select(m.InstitutionalPerson).where(m.InstitutionalPerson.email == email))
    assert person.status == m.InstitutionalStatus.AWAITING
    outbox = Outbox()
    app.dependency_overrides[get_email_sender] = lambda: outbox     # the server is back
    assert admin.post(f"/api/v1/admin/institutional/{person.id}/link").status_code in (200, 204)
    assert "/autorizacao?token=" in outbox.sent[-1].body


def test_forgot_password_with_the_mail_server_down_answers_as_always(admin_client, db):
    """Telling that the e-mail failed would tell that the address has an account (enumeration)."""
    app.dependency_overrides[get_email_sender] = lambda: DownSender()
    active = make_account(db, "Bruno Rocha", m.AccountRole.PHOTOGRAPHER)
    known = TestClient(app).post("/api/v1/auth/password/forgot", json={"email": active.email})
    unknown = TestClient(app).post("/api/v1/auth/password/forgot", json={"email": "ninguem@cesmac.edu.br"})
    assert known.status_code == unknown.status_code == 202 and known.json() == unknown.json()
