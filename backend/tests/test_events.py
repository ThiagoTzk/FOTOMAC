"""Events through the real HTTP API, plus the profile."""
from __future__ import annotations

import io
import uuid
from datetime import date

import piexif
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.auth import passwords
from app.db import models as m
from app.db.session import get_session
from app.events import dates
from app.imaging_meta import has_gps
from app.main import app
from app.security.rate_limit import login_limiter, password_link_limiter
from app.storage.factory import get_storage

PASSWORD = "Fotomac#2026"


def jpeg_with_gps() -> bytes:
    """A real JPEG (encoded by OpenCV) carrying GPS coordinates in its EXIF block."""
    import cv2
    import numpy as np
    ok, buf = cv2.imencode(".jpg", np.full((40, 60, 3), 128, np.uint8))
    gps = {piexif.GPSIFD.GPSLatitudeRef: b"S", piexif.GPSIFD.GPSLatitude: ((9, 1), (39, 1), (0, 1))}
    exif = piexif.dump({"0th": {}, "Exif": {piexif.ExifIFD.DateTimeOriginal: b"2026:09:18 10:00:00"},
                        "GPS": gps, "1st": {}, "thumbnail": None})
    out = io.BytesIO()
    piexif.insert(exif, buf.tobytes(), out)
    return out.getvalue()


class MemoryStorage:
    def __init__(self):
        self.objects: dict[str, bytes] = {}

    def ensure_bucket(self): ...

    def put(self, key, data, content_type): self.objects[key] = data

    def get(self, key): return self.objects[key]

    def exists(self, key): return key in self.objects

    def delete(self, key): self.objects.pop(key, None)

    def stream(self, key, chunk_size=1024 * 1024):
        data = self.objects[key]
        return len(data), (data[i:i + chunk_size] for i in range(0, len(data), chunk_size))


@pytest.fixture
def storage():
    return MemoryStorage()


def make_account(db, name, role=m.AccountRole.PHOTOGRAPHER) -> m.Account:
    account = m.Account(full_name=name, email=f"{uuid.uuid4().hex[:8]}@cesmac.edu.br", role=role,
                        photographer_signature=name if role == m.AccountRole.PHOTOGRAPHER else None,
                        password_hash=passwords.hash_password(PASSWORD), status=m.AccountStatus.ACTIVE)
    db.add(account)
    db.flush()
    return account


@pytest.fixture
def api(db, storage):
    login_limiter.reset()
    password_link_limiter.reset()
    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[get_storage] = lambda: storage

    def client_for(account: m.Account) -> TestClient:
        c = TestClient(app)
        assert c.post("/api/v1/auth/login", json={"email": account.email, "password": PASSWORD}).status_code == 200
        return c
    yield client_for
    app.dependency_overrides.clear()


@pytest.fixture
def themes(db) -> list[m.Theme]:
    return db.scalars(select(m.Theme).order_by(m.Theme.name)).all()


def form(themes, **over):
    data = {"name": f"FECIAL 2026 {uuid.uuid4().hex[:4]}", "theme_ids": [str(themes[0].id), str(themes[1].id)],
            "date_precision": "day", "date_start": "2026-09-18", "location": "Campus I",
            "description": "Feira de Ciências do CESMAC."}
    data.update(over)
    return data


def create(client, themes, cover=None, **over):
    files = {"cover": ("capa.jpg", cover if cover is not None else jpeg_with_gps(), "image/jpeg")}
    return client.post("/api/v1/events", data=form(themes, **over), files=files)


# ----------------------------------------------------------------- dates

def test_date_precisions_and_labels():
    assert dates.normalize(m.DatePrecision.DAY, date(2026, 8, 21)) == (date(2026, 8, 21), date(2026, 8, 21))
    assert dates.normalize(m.DatePrecision.MONTH, date(2026, 2, 10)) == (date(2026, 2, 1), date(2026, 2, 28))
    start, end = dates.normalize(m.DatePrecision.MONTH_RANGE, date(2026, 6, 1), date(2026, 8, 1))
    assert (start, end) == (date(2026, 6, 1), date(2026, 8, 31))
    assert dates.label(m.DatePrecision.MONTH_RANGE, start, end) == "Junho a Agosto/2026"
    assert dates.label(m.DatePrecision.MONTH, date(2026, 8, 1), date(2026, 8, 31)) == "Agosto/2026"
    assert dates.label(m.DatePrecision.DAY, date(2026, 8, 21), date(2026, 8, 21)) == "21/08/2026"


@pytest.mark.parametrize("start,end,msg", [
    (date(2026, 8, 1), date(2026, 6, 1), "anterior"),
    (date(2026, 1, 1), date(2027, 1, 1), "12 meses"),
])
def test_invalid_month_ranges(start, end, msg):
    with pytest.raises(dates.EventDateError, match=msg):
        dates.normalize(m.DatePrecision.MONTH_RANGE, start, end)


def test_expiry_is_six_months_after_the_end_of_the_event():
    assert dates.expiry_date(date(2026, 9, 18), 6) == date(2027, 3, 18)
    assert dates.expiry_date(date(2026, 8, 31), 6) == date(2027, 2, 28)   # no 31 Feb


# ----------------------------------------------------------------- create / edit

def test_create_event_owner_expiry_and_audit(api, db, themes, storage):
    bruno = make_account(db, "Bruno Rocha")
    r = create(api(bruno), themes)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["owner"]["full_name"] == "Bruno Rocha" and body["relation"] == "owner"
    assert body["status"] == "editing" and body["expires_on"] == "2027-03-18"   # 6 months
    assert body["collaboration_open"] is False
    assert db.scalar(select(m.AuditLog).where(m.AuditLog.action == "event.create",
                                              m.AuditLog.target_id == body["id"])) is not None


def test_cover_is_stored_without_gps(api, db, themes, storage):
    """GPS removal applied to the cover: it is the only image shown publicly."""
    original = jpeg_with_gps()
    assert has_gps(original)
    create(api(make_account(db, "Bruno Rocha")), themes, cover=original)
    (stored,) = storage.objects.values()
    assert not has_gps(stored)
    assert stored[-2:] == original[-2:]                     # same compressed image data, not re-encoded


def test_cover_is_served_by_the_api(api, db, themes, storage):
    """The panel gets the cover from the API itself, never a link to the storage."""
    client = api(make_account(db, "Bruno Rocha"))
    event_id = create(client, themes).json()["id"]
    r = client.get(f"/api/v1/events/{event_id}/cover")
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    assert r.content == next(iter(storage.objects.values()))


@pytest.mark.parametrize("cover,msg", [(b"\x89PNG\r\n\x1a\nfake", "JPEG"), (b"", "capa")])
def test_cover_must_be_jpeg_by_signature(api, db, themes, cover, msg):
    r = create(api(make_account(db, "Bruno Rocha")), themes, cover=cover)
    assert r.status_code == 400 and msg in r.json()["detail"]


def test_same_name_same_date_is_refused(api, db, themes):
    client = api(make_account(db, "Bruno Rocha"))
    assert create(client, themes, name="Mostra Cultural").status_code == 201
    r = create(client, themes, name="Mostra Cultural")
    assert r.status_code == 400 and "Já existe" in r.json()["detail"]


def test_only_owner_or_admin_edits_and_changes_are_audited(api, db, themes):
    owner, other = make_account(db, "Bruno Rocha"), make_account(db, "Ana Souza")
    admin = make_account(db, "Admin Geral", m.AccountRole.ADMIN)
    event_id = create(api(owner), themes).json()["id"]
    api(owner).put(f"/api/v1/events/{event_id}/collaboration", json={"open": True})

    changed = form(themes, name="Novo nome", date_precision="month", date_start="2026-10-01")
    assert api(other).put(f"/api/v1/events/{event_id}", data=changed).status_code == 403   # collaborator
    r = api(admin).put(f"/api/v1/events/{event_id}", data=changed)
    assert r.status_code == 200 and r.json()["date_label"] == "Outubro/2026"
    assert r.json()["expires_on"] == "2027-04-30"            # recalculated
    entry = db.scalar(select(m.AuditLog).where(m.AuditLog.action == "event.update"))
    assert entry.details["changes"]["name"]["para"] == "Novo nome"


def test_expiry_preview(api, db, themes):
    r = api(make_account(db, "Bruno Rocha")).get(
        "/api/v1/events/expiry-preview", params={"date_precision": "day", "date_start": "2026-09-18"})
    assert r.json()["expires_on"] == "2027-03-18" and r.json()["retention_months"] == 6


# ----------------------------------------------------------------- visibility / collaboration

def test_collaboration_controls_visibility(api, db, themes):
    owner, other = make_account(db, "Bruno Rocha"), make_account(db, "Ana Souza")
    event_id = create(api(owner), themes).json()["id"]
    # Not released: since 01/11/2026 the event is FOUND (summary only, to ask to collaborate), never its photos.
    found = api(other).get(f"/api/v1/events/{event_id}").json()
    assert found["relation"] == "outsider" and found["can_upload"] is False and found["ask_upload"] is True
    assert api(other).get(f"/api/v1/events/{event_id}/images").status_code == 404
    assert api(other).put(f"/api/v1/events/{event_id}/collaboration", json={"open": True}).status_code == 404

    api(owner).put(f"/api/v1/events/{event_id}/collaboration", json={"open": True})
    seen = api(other).get(f"/api/v1/events/{event_id}").json()
    assert seen["relation"] == "collaborator" and seen["can_manage"] is False
    assert api(other).put(f"/api/v1/events/{event_id}/collaboration", json={"open": False}).status_code == 403
    actions = db.scalars(select(m.AuditLog.action).where(m.AuditLog.target_id == event_id)).all()
    assert "event.collaboration_opened" in actions


def test_list_filters_scope_and_accent_insensitive_search(api, db, themes):
    owner, other = make_account(db, "Bruno Rocha"), make_account(db, "Ana Souza")
    c_owner, c_other = api(owner), api(other)
    create(c_owner, themes, name="FeCiAL Edição 2026")
    shared = create(c_other, themes, name="Mostra de Ciência").json()["id"]
    c_other.put(f"/api/v1/events/{shared}/collaboration", json={"open": True})
    create(c_other, themes, name="Evento privado da Ana")

    names = lambda r: sorted(e["name"] for e in r.json()["items"])  # noqa: E731
    # "Todos os eventos" lists every active event (01/11/2026); "Habilitados para mim", the ones it may work on.
    assert names(c_owner.get("/api/v1/events")) == ["Evento privado da Ana", "FeCiAL Edição 2026", "Mostra de Ciência"]
    assert names(c_owner.get("/api/v1/events", params={"scope": "enabled"})) == ["FeCiAL Edição 2026", "Mostra de Ciência"]
    assert names(c_owner.get("/api/v1/events", params={"scope": "mine"})) == ["FeCiAL Edição 2026"]
    assert names(c_owner.get("/api/v1/events", params={"scope": "collaborations"})) == ["Mostra de Ciência"]
    assert names(c_owner.get("/api/v1/events", params={"q": "fecial edicao"})) == ["FeCiAL Edição 2026"]
    assert names(c_owner.get("/api/v1/events", params={"period_start": "2026-10-01"})) == []


def test_routes_require_login(db):
    c = TestClient(app)
    assert c.get("/api/v1/events").status_code == 401
    assert c.post("/api/v1/events", data={}).status_code in (401, 422)
    assert c.get("/api/v1/dashboard").status_code == 401


def test_dashboard_counts(api, db, themes):
    bruno = make_account(db, "Bruno Rocha")
    c = api(bruno)
    create(c, themes)
    create(c, themes)
    d = c.get("/api/v1/dashboard").json()
    assert d["events_owned"] == 2 and d["processing"] == 0 and d["attention"] == 0 and d["photos_published"] == 0


# ----------------------------------------------------------------- profile

def test_signature_change_is_audited_and_name_is_not_editable(api, db):
    bruno = make_account(db, "Bruno Rocha")
    c = api(bruno)
    r = c.patch("/api/v1/auth/me", json={"photographer_signature": "Bruno B. Fotografia",
                                         "full_name": "Hacker"})
    assert r.status_code == 200 and r.json()["photographer_signature"] == "Bruno B. Fotografia"
    assert r.json()["full_name"] == "Bruno Rocha"                 # extra field ignored
    assert db.scalar(select(m.AuditLog).where(m.AuditLog.action == "account.signature_changed")) is not None


def test_change_password_keeps_this_session_and_ends_the_others(api, db):
    bruno = make_account(db, "Bruno Rocha")
    laptop, phone = api(bruno), api(bruno)
    wrong = laptop.post("/api/v1/auth/password/change", json={
        "current_password": "Errada#1", "password": "Nova#Senha9", "password_confirmation": "Nova#Senha9"})
    assert wrong.status_code == 400 and "atual" in wrong.json()["detail"]["message"]
    ok = laptop.post("/api/v1/auth/password/change", json={
        "current_password": PASSWORD, "password": "Nova#Senha9", "password_confirmation": "Nova#Senha9"})
    assert ok.status_code == 204
    assert laptop.get("/api/v1/auth/me").status_code == 200        # this device stays logged in
    assert phone.get("/api/v1/auth/me").status_code == 401         # other device logged out
