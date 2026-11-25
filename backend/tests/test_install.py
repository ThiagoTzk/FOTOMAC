"""The first administrator of a new installation (app/accounts/install.py, 24/11/2026)."""
from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

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


def test_only_once_per_installation(empty):
    create_first_admin(empty, "administrador@cesmac.edu.br")
    with pytest.raises(EventError, match="já tem administrador"):
        create_first_admin(empty, "outro@cesmac.edu.br")


@pytest.mark.parametrize("email, name, says", [
    ("admin@gmail.com", "Administrador FOTOMAC", "institucional"),
    ("nao-e-email", "Administrador FOTOMAC", ""),
    ("administrador@cesmac.edu.br", "Administrador", "nome"),
])
def test_bad_data_is_refused(empty, email, name, says):
    with pytest.raises(EventError, match=says):
        create_first_admin(empty, email, name)
