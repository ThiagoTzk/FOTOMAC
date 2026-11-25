"""The mobile app's sessions (06/11/2026): no browser cookies; the session goes in headers.

Staff: "Authorization: Bearer" with the token the login gives ONLY to the app. Visitor: "X-Fotomac-Visit" with the
token the "Estou ciente" gives ONLY to the app. The site keeps its HttpOnly cookies and never sees a token.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.api.deps import SESSION_COOKIE
from app.main import app
from tests.test_auth import STRONG, active, client, login, pending, sender  # noqa: F401 (fixtures)
from tests.support import jpeg
from tests.test_public import GROUP, consent, env, engine, make_event, person_crop, photographer, publish_and_index, search  # noqa: F401

APP = {"X-Fotomac-Client": "app"}


def bearer(token: str) -> dict:
    return {**APP, "Authorization": f"Bearer {token}"}


def test_the_site_gets_a_cookie_and_never_a_token(client, active):
    r = login(client)
    assert r.status_code == 200 and "session_token" not in r.json()
    assert SESSION_COOKIE in r.cookies
    assert r.json()["valid_until"] is None and "idle_minutes" in r.json()   # the other fields as before


def test_the_app_gets_a_token_and_no_cookie(client, active):
    r = client.post("/api/v1/auth/login", headers=APP, json={"email": active.email, "password": STRONG, "remember": False})
    assert r.status_code == 200 and r.json()["session_token"]
    assert SESSION_COOKIE not in r.cookies          # a cookie left in the phone would outlive "Sair"
    client.cookies.clear()
    me = client.get("/api/v1/auth/me", headers=bearer(r.json()["session_token"]))
    assert me.status_code == 200 and me.json()["email"] == active.email


def test_without_a_token_the_app_is_refused_and_a_wrong_one_too(client, active):
    assert client.get("/api/v1/auth/me", headers=APP).status_code == 401
    assert client.get("/api/v1/auth/me", headers=bearer("inventado")).status_code == 401


def test_logout_ends_the_app_session_on_the_server(client, active):
    token = client.post("/api/v1/auth/login", headers=APP, json={"email": active.email, "password": STRONG}).json()["session_token"]
    assert client.post("/api/v1/auth/logout", headers=bearer(token)).status_code == 204
    assert client.get("/api/v1/auth/me", headers=bearer(token)).status_code == 401


def test_the_app_session_keeps_the_idle_rule(client, active, db):
    """Same 15 minutes as the site: the app has no tabs, so only the idle limit (or "Manter conectado") applies."""
    token = client.post("/api/v1/auth/login", headers=APP, json={"email": active.email, "password": STRONG}).json()["session_token"]
    me = client.get("/api/v1/auth/me", headers=bearer(token)).json()
    assert me["idle_minutes"] == 15 and me["idle_left_seconds"] > 0
    kept = client.post("/api/v1/auth/login", headers=APP, json={"email": active.email, "password": STRONG, "remember": True}).json()
    assert client.get("/api/v1/auth/me", headers=bearer(kept["session_token"])).json()["idle_minutes"] is None


def test_the_visitor_app_gets_a_visit_token_and_sees_only_its_result(env, db, engine):
    storage, _ = env
    owner = photographer(db)
    e = make_event(db, owner)
    publish_and_index(db, storage, engine, owner, e, [GROUP, jpeg(4, w=600, h=400)])
    app_client = TestClient(app)
    r = app_client.post(f"/api/v1/public/events/{e.id}/consent", headers=APP)
    assert r.status_code == 200 and r.json()["visit_token"]
    assert "fotomac_visit" not in r.cookies
    visit = {**APP, "X-Fotomac-Visit": r.json()["visit_token"]}
    app_client.headers.update(visit)
    found = search(app_client, e, person_crop())
    assert found.status_code == 200 and found.json()["items"]
    shown = found.json()["items"][0]["id"]
    assert app_client.get(f"/api/v1/public/images/{shown}/thumb").status_code == 200
    # Another phone, without this visit, sees nothing.
    assert TestClient(app).get(f"/api/v1/public/images/{shown}/thumb", headers=APP).status_code == 404
    # Leaving the event ends the visit: the token is worthless after it.
    assert app_client.post("/api/v1/public/session/end").status_code == 204
    assert app_client.get(f"/api/v1/public/images/{shown}/thumb").status_code == 404


def test_the_site_consent_is_unchanged(env, db, engine):
    storage, _ = env
    owner = photographer(db)
    e = make_event(db, owner)
    publish_and_index(db, storage, engine, owner, e, [GROUP])
    c = TestClient(app)
    consent(c, e)   # 204 and the HttpOnly cookie, as before
    assert "fotomac_visit" in c.cookies
