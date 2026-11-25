"""'Configuração do evento' (24/10/2026): RAW on/off after creation and each person's access, through the API."""
from __future__ import annotations

from sqlalchemy import select

from app.db import models as m
from app.images import service as images
from tests.support import jpeg
from tests.test_profiles_v2 import account, contractor, env, event_of, login  # noqa: F401 (env is a fixture)


def test_raw_is_switched_on_and_off_after_creation_and_the_edit_leaves_it_alone(env, db):
    owner = account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha")
    e = event_of(db, owner)
    c = login(owner)
    assert c.put(f"/api/v1/events/{e.id}/raw", json={"enabled": True}).json()["raw_enabled"] is True
    edit = c.put(f"/api/v1/events/{e.id}", data={"name": e.name, "theme_ids": [str(t.id) for t in e.themes] or ["1"],
                                                 "date_precision": "day", "date_start": "2026-12-19",
                                                 "location": "Campus II", "description": "Evento"})
    assert edit.status_code == 200, edit.text
    assert edit.json()["raw_enabled"] is True                         # the edit form no longer turns RAW off
    assert c.put(f"/api/v1/events/{e.id}/raw", json={"enabled": False}).json()["raw_enabled"] is False
    other = login(account(db, m.AccountRole.PHOTOGRAPHER, "Rui Costa"))
    e.collaboration_open = True
    db.flush()
    assert other.put(f"/api/v1/events/{e.id}/raw", json={"enabled": True}).status_code == 403
    actions = set(db.scalars(select(m.AuditLog.action).where(m.AuditLog.target_id == str(e.id))))
    assert {"event.raw_enabled", "event.raw_disabled"} <= actions


def test_turning_off_a_persons_access_keeps_their_photos_and_stops_them_working(env, db):
    storage, _ = env
    owner = account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha")
    joao = account(db, m.AccountRole.PHOTOGRAPHER, "João Lima")
    e = event_of(db, owner, collaboration=True)
    photo = images.upload_image(db, storage, joao, e, jpeg(40, w=400, h=300))
    c_owner, c_joao = login(owner), login(joao)

    people = c_owner.get(f"/api/v1/events/{e.id}/members").json()
    assert [(p["full_name"], p["owner"], p["photos"], p["allowed"]) for p in people] == [
        ("Bruno Rocha", True, 0, True), ("João Lima", False, 1, True)]
    assert c_joao.get(f"/api/v1/events/{e.id}/members").status_code == 403      # only who manages the event

    url = f"/api/v1/events/{e.id}/members/{joao.id}"
    assert c_owner.put(url, json={"allowed": False}).json()["allowed"] is False
    me = c_joao.get(f"/api/v1/events/{e.id}").json()
    assert me["access_blocked"] is True and me["can_upload"] is False
    assert c_joao.post(f"/api/v1/events/{e.id}/images", files={"file": ("f.jpg", jpeg(41), "image/jpeg")}).status_code == 403
    assert c_joao.post(f"/api/v1/images/{photo.id}/discard").status_code in (403, 404)
    kept = db.get(m.Image, photo.id)
    assert kept is not None and kept.uploaded_by == joao.id                    # the photo and its credit stay
    assert c_joao.post(f"/api/v1/images/{photo.id}/download-link").status_code == 200   # its own work, still

    assert c_owner.put(url, json={"allowed": True}).json()["allowed"] is True
    assert c_joao.get(f"/api/v1/events/{e.id}").json()["can_upload"] is True
    actions = [a for a in db.scalars(select(m.AuditLog.action).where(m.AuditLog.target_id == str(e.id)))]
    assert "event.access_blocked" in actions and "event.access_restored" in actions


def test_the_responsible_is_never_blocked_and_a_hired_photographer_can_be(env, db):
    admin_account = account(db, m.AccountRole.ADMIN)
    admin = login(admin_account)
    owner = account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha")
    e = event_of(db, owner)
    hired, c_hired = contractor(db, env, admin, e)
    names = [p["full_name"] for p in admin.get(f"/api/v1/events/{e.id}/members").json()]
    assert names == ["Bruno Rocha", "Eduardo Contratado"]                       # admins are not listed
    assert admin.put(f"/api/v1/events/{e.id}/members/{owner.id}", json={"allowed": False}).status_code == 400
    stranger = account(db, m.AccountRole.PHOTOGRAPHER, "Rui Costa")
    assert admin.put(f"/api/v1/events/{e.id}/members/{stranger.id}", json={"allowed": False}).status_code == 404
    assert admin.put(f"/api/v1/events/{e.id}/members/{hired.id}", json={"allowed": False}).status_code == 200
    assert c_hired.post(f"/api/v1/events/{e.id}/images", files={"file": ("f.jpg", jpeg(42), "image/jpeg")}).status_code == 403
