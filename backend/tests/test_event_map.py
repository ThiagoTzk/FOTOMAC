"""The event on a map (01/11/2026): a CEP finds the street, the pin and the note say where the entrance is. The
visitor sees them; only whoever created the event changes them. The outside services are replaced here: no test
depends on the internet."""
from __future__ import annotations

import io
import urllib.error

import pytest

from app.config import get_settings
from app.db import models as m
from app.geo import cep as geo
from tests.test_profiles_v2 import account, contractor, env, event_of, login  # noqa: F401 (env is a fixture)

VIACEP = {"cep": "57051-160", "logradouro": "Rua Cônego Machado", "bairro": "Farol", "localidade": "Maceió", "uf": "AL"}
HERE = {"lat": "-9.6556236", "lon": "-35.7381702", "display_name": "57051-160, Maceió, Alagoas, Brasil"}


@pytest.fixture
def outside(monkeypatch):
    """What each outside service answers, and what was asked."""
    state = {"viacep": VIACEP, "nominatim": [HERE], "awesome": {"city": "Maceió", "lat": "-9.65", "lng": "-35.73"}, "asked": []}

    def get(url):
        state["asked"].append(url)
        name = "viacep" if "viacep" in url else "nominatim" if "nominatim" in url else "awesome"
        if isinstance(state[name], Exception):
            raise state[name]
        return state[name]

    monkeypatch.setattr(geo, "_get_json", get)
    monkeypatch.setattr(geo, "NOMINATIM_GAP_SECONDS", 0)
    geo._cache.clear()
    yield state
    geo._cache.clear()


def event_with_theme(db, owner, **kwargs):
    e = event_of(db, owner, **kwargs)
    e.themes = [m.Theme(name=f"Tema {e.id.hex[:8]}", icon="tag")]
    db.flush()
    return e


def form(e, **extra):
    return {"name": e.name, "theme_ids": [t.id for t in e.themes], "date_precision": e.date_precision.value,
            "date_start": str(e.date_start), "location": e.location, "description": e.description, **extra}


def test_a_cep_finds_the_street_and_the_point_and_is_kept(env, db, outside):
    owner = account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha")
    c = login(owner)
    r = c.get("/api/v1/geo/cep/57051-160")
    assert r.status_code == 200, r.text
    assert r.json()["street"] == "Rua Cônego Machado" and r.json()["latitude"] == pytest.approx(-9.6556236)
    asked = len(outside["asked"])
    assert c.get("/api/v1/geo/cep/57051160").status_code == 200
    assert len(outside["asked"]) == asked     # kept: the free services are not asked twice


def test_the_second_service_answers_when_the_first_fails_or_points_to_another_city(env, db, outside):
    c = login(account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha"))
    outside["nominatim"] = OSError("fora do ar")
    assert c.get("/api/v1/geo/cep/57051160").json()["latitude"] == -9.65
    geo._cache.clear()
    outside["nominatim"] = [{**HERE, "display_name": "57051-160, Recife, Pernambuco, Brasil"}]
    assert c.get("/api/v1/geo/cep/57051160").json()["latitude"] == -9.65


def test_a_street_without_a_point_still_answers_and_the_pin_is_placed_by_hand(env, db, outside):
    c = login(account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha"))
    outside["nominatim"], outside["awesome"] = [], OSError("fora do ar")
    body = c.get("/api/v1/geo/cep/57051160").json()
    assert body["street"] == "Rua Cônego Machado" and body["latitude"] is None


def test_wrong_missing_and_unavailable_ceps_are_told_apart(env, db, outside):
    c = login(account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha"))
    assert c.get("/api/v1/geo/cep/123").status_code == 400
    assert not [u for u in outside["asked"]]               # nothing goes out for a malformed CEP
    outside["viacep"] = {"erro": "true"}
    assert c.get("/api/v1/geo/cep/99999999").status_code == 404
    outside["viacep"] = urllib.error.HTTPError("u", 400, "bad", {}, io.BytesIO())
    assert c.get("/api/v1/geo/cep/99999998").status_code == 404
    outside["viacep"] = OSError("fora do ar")
    assert c.get("/api/v1/geo/cep/57051161").status_code == 503


def test_only_accounts_that_create_events_look_up_a_cep(env, db, outside):
    admin = account(db, m.AccountRole.ADMIN, "Pessoa Administradora")
    e = event_of(db, account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha"))
    _, hired = contractor(db, env, login(admin), e)
    assert hired.get("/api/v1/geo/cep/57051160").status_code == 403
    assert env_client().get("/api/v1/geo/cep/57051160").status_code == 401    # a visitor never reaches it


def test_the_creator_saves_the_map_and_the_visitor_sees_it(env, db):
    owner = account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha")
    e = event_with_theme(db, owner, published=True)
    c = login(owner)
    r = c.put(f"/api/v1/events/{e.id}", data=form(e, postal_code="57051-160", latitude="-9.6557", longitude="-35.7375",
                                                  location_note="  Entrada vermelha com a logo do ginásio  "))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["postal_code"] == "57051160" and body["can_edit_map"] is True
    assert body["location_note"] == "Entrada vermelha com a logo do ginásio"
    logged = db.query(m.AuditLog).filter_by(action="event.update", target_id=str(e.id)).all()
    assert logged and "pin" in logged[-1].details["changes"]

    public = env_client().get(f"/api/v1/public/events/{e.id}").json()
    assert public["latitude"] == -9.6557 and public["longitude"] == -35.7375
    assert public["location_note"] == "Entrada vermelha com a logo do ginásio"
    assert "postal_code" not in public

    cleared = c.put(f"/api/v1/events/{e.id}", data=form(e)).json()     # "Remover o pin": nothing is left behind
    assert cleared["latitude"] is None and cleared["postal_code"] is None and cleared["location_note"] is None


def env_client():
    from fastapi.testclient import TestClient

    from app.main import app
    return TestClient(app)


def test_half_a_pin_or_a_bad_cep_is_refused_by_the_server(env, db):
    owner = account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha")
    e = event_with_theme(db, owner)
    c = login(owner)
    assert c.put(f"/api/v1/events/{e.id}", data=form(e, latitude="-9.6")).status_code == 400
    assert c.put(f"/api/v1/events/{e.id}", data=form(e, latitude="-99", longitude="-35")).status_code == 400
    assert c.put(f"/api/v1/events/{e.id}", data=form(e, postal_code="123")).status_code == 400
    assert c.put(f"/api/v1/events/{e.id}", data=form(e, location_note="x" * 301)).status_code == 400


def test_only_the_creator_changes_the_map(env, db):
    owner = account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha")
    other = account(db, m.AccountRole.PHOTOGRAPHER, "Rafael Costa")
    admin = account(db, m.AccountRole.ADMIN, "Pessoa Administradora")
    e = event_with_theme(db, owner)
    e.latitude, e.longitude, e.location_note = -9.6557, -35.7375, "Entrada vermelha"
    db.flush()

    assert login(other).put(f"/api/v1/events/{e.id}", data=form(e, latitude="1", longitude="1")).status_code in (403, 404)

    # The administrator edits the event, and the map stays the creator's.
    c_admin = login(admin)
    body = c_admin.put(f"/api/v1/events/{e.id}", data=form(e, latitude="1", longitude="1", location_note="Outro lugar")).json()
    assert body["can_edit_map"] is False and body["latitude"] == -9.6557 and body["location_note"] == "Entrada vermelha"

    # With the creator's account no longer active, the administrator takes over.
    owner.status = m.AccountStatus.SUSPENDED
    db.flush()
    body = c_admin.put(f"/api/v1/events/{e.id}", data=form(e, latitude="1", longitude="1", location_note="Outro lugar")).json()
    assert body["can_edit_map"] is True and body["latitude"] == 1 and body["location_note"] == "Outro lugar"


def test_the_map_file_is_public_and_read_in_pieces(env, tmp_path, monkeypatch):
    """The browser asks for pieces of the file: no account, no outside service (RNF34)."""
    path = tmp_path / "brasil.pmtiles"
    path.write_bytes(bytes(range(256)))
    monkeypatch.setattr(get_settings(), "map_file", path)
    piece = env_client().get("/api/v1/map/brasil.pmtiles", headers={"Range": "bytes=10-19"})
    assert piece.status_code == 206
    assert piece.content == bytes(range(10, 20))


def test_without_the_map_file_the_server_says_so(env, tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "map_file", tmp_path / "missing.pmtiles")
    assert env_client().get("/api/v1/map/brasil.pmtiles").status_code == 404
