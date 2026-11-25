"""The first administrator of a new installation (app/accounts/install.py, 24/11/2026)."""
from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.accounts.install import create_first_admin
from app.db import models as m
from app.db.session import get_session
from app.events.service import EventError
from app.main import app
from app.security.rate_limit import login_limiter, password_link_limiter

STRONG = "Fotomac#2026"


@pytest.fixture
def empty(db):
    """An installation without any account (inside the test transaction, rolled back at the end)."""
    if db.scalar(select(m.Account.id).where(m.Account.role == m.AccountRole.ADMIN).limit(1)):
        pytest.skip("the test database already has administrators outside the transaction")
    return db


def test_the_first_administrator_has_no_password_and_defines_it_by_the_printed_link(empty):
    db = empty
    link = create_first_admin(db, "administrador@cesmac.edu.br")
    admin = db.scalar(select(m.Account).where(m.Account.email == "administrador@cesmac.edu.br"))
    assert admin.role == m.AccountRole.ADMIN and admin.status == m.AccountStatus.PENDING and admin.password_hash is None
    assert admin.full_name == "Administrador FOTOMAC"
    token = re.search(r"/primeiro-acesso\?token=([\w-]+)$", link).group(1)

    login_limiter.reset()
    password_link_limiter.reset()
    app.dependency_overrides[get_session] = lambda: db
    try:
        r = TestClient(app).post("/api/v1/auth/first-access",
                                 json={"token": token, "password": STRONG, "password_confirmation": STRONG})
        assert r.status_code == 200
        db.refresh(admin)
        assert admin.status == m.AccountStatus.ACTIVE
        again = TestClient(app).post("/api/v1/auth/first-access",
                                     json={"token": token, "password": STRONG, "password_confirmation": STRONG})
        assert again.status_code != 200                                     # single use
    finally:
        app.dependency_overrides.clear()


def test_a_lost_or_expired_link_is_replaced_while_nobody_activated(empty):
    """The link expired unused: the same command, with the same e-mail, gives a new one; the old one stops working."""
    db = empty
    first = re.search(r"token=([\w-]+)$", create_first_admin(db, "administrador@cesmac.edu.br")).group(1)
    second = re.search(r"token=([\w-]+)$", create_first_admin(db, "administrador@cesmac.edu.br")).group(1)
    assert first != second
    assert db.scalar(select(func.count()).select_from(m.Account).where(m.Account.role == m.AccountRole.ADMIN)) == 1
    with pytest.raises(EventError, match="aguardando o primeiro acesso"):
        create_first_admin(db, "outro@cesmac.edu.br")                  # a second, different admin: no
    login_limiter.reset()
    password_link_limiter.reset()
    app.dependency_overrides[get_session] = lambda: db
    try:
        body = {"password": STRONG, "password_confirmation": STRONG}
        assert TestClient(app).post("/api/v1/auth/first-access", json={"token": first, **body}).status_code != 200
        assert TestClient(app).post("/api/v1/auth/first-access", json={"token": second, **body}).status_code == 200
    finally:
        app.dependency_overrides.clear()


def test_refused_once_an_administrator_is_active(empty):
    db = empty
    admin = m.Account(full_name="Ana Lima", email="ana@cesmac.edu.br", role=m.AccountRole.ADMIN,
                      password_hash="x", status=m.AccountStatus.ACTIVE)
    db.add(admin)
    db.flush()
    for email in ("administrador@cesmac.edu.br", "ana@cesmac.edu.br"):
        with pytest.raises(EventError, match="já tem administrador"):
            create_first_admin(db, email)


@pytest.mark.parametrize("email, name, says", [
    ("admin@gmail.com", "Administrador FOTOMAC", "institucional"),
    ("nao-e-email", "Administrador FOTOMAC", ""),
    ("administrador@cesmac.edu.br", "Administrador", "nome"),
])
def test_bad_data_is_refused(empty, email, name, says):
    with pytest.raises(EventError, match=says):
        create_first_admin(empty, email, name)
