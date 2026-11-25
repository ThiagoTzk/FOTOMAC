"""Events with children and the blur tool (04/11/2026, answer of the coordinator and the advisor).

The switch "Este evento contém imagens com crianças" is turned on only with the declaration that the guardians'
authorisation was collected and where the signed terms are (LGPD Art. 8, § 2; Art. 14, § 1). Blurring hides a
face IN the file: the file with the face is not kept, and a blurred face gives no vector."""
from __future__ import annotations

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.db import models as m
from app.images import service as images
from app.indexing.worker import index_next
from app.main import app
from tests.test_accounts import make_account
from tests.test_admin_config import engine, env, login  # noqa: F401 (shared fixtures)
from tests.test_public import GROUP, make_event

REFERENCE = "Secretaria do curso, pasta OBR 2026"


def vectors(db, image_id):
    return db.scalar(select(func.count()).select_from(m.FaceEmbedding).where(m.FaceEmbedding.image_id == image_id))


def actions(db, target):
    return set(db.scalars(select(m.AuditLog.action).where(m.AuditLog.target_id == str(target))))


def _setup(env, db):
    storage, _ = env
    owner = make_account(db, "Bruno Rocha", m.AccountRole.PHOTOGRAPHER)
    owner.photographer_signature = "Bruno Rocha"
    e = make_event(db, owner)
    image = images.upload_image(db, storage, owner, e, GROUP)
    db.flush()
    return storage, owner, e, image, login(owner)


def _publish(c, db, storage, engine, e):
    assert c.post(f"/api/v1/events/{e.id}/publish").status_code == 200
    while index_next(db, storage, engine):
        pass


# ------------------------------------------------------------------ the switch

def test_the_switch_needs_the_declaration_and_where_the_terms_are(env, db):
    storage, owner, e, image, c = _setup(env, db)
    url = f"/api/v1/events/{e.id}/children"
    r = c.put(url, json={"enabled": True, "reference": REFERENCE, "declared": False})
    assert r.status_code == 400 and "declare" in r.json()["detail"]
    r = c.put(url, json={"enabled": True, "reference": "  ", "declared": True})
    assert r.status_code == 400 and "termos" in r.json()["detail"]
    out = c.put(url, json={"enabled": True, "reference": REFERENCE, "declared": True}).json()
    assert out["has_children"] and out["children_authorization_ref"] == REFERENCE
    assert out["children_declared_by"] == "Bruno Rocha" and out["children_declared_at"]
    assert "event.children_declared" in actions(db, e.id)
    # Turned off, the declaration goes with it; the audit keeps the history.
    out = c.put(url, json={"enabled": False}).json()
    assert not out["has_children"] and out["children_authorization_ref"] is None and out["children_declared_at"] is None
    assert "event.children_removed" in actions(db, e.id)


def test_the_database_refuses_children_without_the_declaration(env, db):
    storage, owner, e, image, c = _setup(env, db)
    e.has_children = True
    with pytest.raises(IntegrityError):
        db.flush()
    db.rollback()


def test_only_who_manages_the_event_turns_it_on(env, db):
    storage, owner, e, image, c = _setup(env, db)
    other = login(make_account(db, "Outra Pessoa", m.AccountRole.PHOTOGRAPHER))
    r = other.put(f"/api/v1/events/{e.id}/children", json={"enabled": True, "reference": REFERENCE, "declared": True})
    assert r.status_code in (403, 404)


def test_created_with_children_and_the_visitor_sees_only_the_notice(env, db, engine):
    storage, _ = env
    owner = make_account(db, "Bruno Rocha", m.AccountRole.PHOTOGRAPHER)
    c = login(owner)
    theme = db.scalar(select(m.Theme.id).limit(1))
    form = {"name": "OBR 2026", "theme_ids": [str(theme)], "date_precision": "day", "date_start": "2026-10-20",
            "location": "Ginásio", "description": "Olimpíada de robótica", "has_children": "true",
            "children_reference": REFERENCE}
    cover = {"cover": ("capa.jpg", GROUP, "image/jpeg")}
    r = c.post("/api/v1/events", data=form, files=cover)
    assert r.status_code == 400 and "declare" in r.json()["detail"]   # the declaration is not implied
    r = c.post("/api/v1/events", data={**form, "children_declared": "true"}, files=cover)
    assert r.status_code == 201 and r.json()["has_children"]
    e = db.get(m.Event, r.json()["id"])
    images.upload_image(db, storage, owner, e, GROUP)
    db.flush()
    _publish(c, db, storage, engine, e)
    public = TestClient(app).get(f"/api/v1/public/events/{e.id}").json()
    assert public["has_children"] is True
    assert REFERENCE not in str(public)   # where the terms are is for the team only


# ------------------------------------------------------------------ the blur tool

def test_blur_is_in_the_file_and_the_blurred_face_gives_no_vector(env, db, engine):
    storage, owner, e, image, c = _setup(env, db)
    before = storage.get(image.object_key)
    found = c.get(f"/api/v1/images/{image.id}/faces").json()
    assert len(found["faces"]) == 3 and vectors(db, image.id) == 0   # boxes only, no vector (RNF13)
    child = found["faces"][0]
    version = c.get(f"/api/v1/images/{image.id}").json()["version"]
    out = c.post(f"/api/v1/images/{image.id}/blur", json={"boxes": [child]}).json()
    assert out["faces_blurred"] == 1
    assert out["version"] != version   # the browser fetches the new thumbnail, never the cached one with the face
    after = storage.get(image.object_key)
    assert after != before   # the file with the face is gone
    x, y, w, h = child
    a, b = (cv2.imdecode(np.frombuffer(d, np.uint8), 1)[y:y + h, x:x + w].astype(int) for d in (before, after))
    assert np.abs(a - b).mean() > 10   # that face really changed
    _publish(c, db, storage, engine, e)
    assert vectors(db, image.id) == 2   # the blurred face is not indexed
    log = db.scalar(select(m.AuditLog).where(m.AuditLog.action == "image.faces_blurred",
                                             m.AuditLog.target_id == str(image.id)))
    assert log.details["faces"] == 1


def test_blurring_a_published_photo_takes_it_out_of_the_search_and_reindexes(env, db, engine):
    storage, owner, e, image, c = _setup(env, db)
    _publish(c, db, storage, engine, e)
    assert vectors(db, image.id) == 3
    child = c.get(f"/api/v1/images/{image.id}/faces").json()["faces"][1]
    out = c.post(f"/api/v1/images/{image.id}/blur", json={"boxes": [child]}).json()
    assert out["indexing_status"] == "pending" and vectors(db, image.id) == 0   # out of the search at once
    while index_next(db, storage, engine):
        pass
    assert vectors(db, image.id) == 2


def test_the_original_in_another_format_goes_too(env, db):
    storage, owner, e, image, c = _setup(env, db)
    image.source_key, image.source_format, image.source_bytes = f"{image.object_key}_original.png", "png", 10
    storage.put(image.source_key, b"face", "image/png")
    db.flush()
    child = c.get(f"/api/v1/images/{image.id}/faces").json()["faces"][0]
    out = c.post(f"/api/v1/images/{image.id}/blur", json={"boxes": [child]}).json()
    assert out["source_format"] is None and "_original.png" not in " ".join(storage.objects)


def test_only_whoever_manages_the_photo_blurs_it(env, db):
    storage, owner, e, image, c = _setup(env, db)
    other = login(make_account(db, "Outra Pessoa", m.AccountRole.PHOTOGRAPHER))
    assert other.post(f"/api/v1/images/{image.id}/blur", json={"boxes": [[0, 0, 10, 10]]}).status_code in (403, 404)
    assert c.post(f"/api/v1/images/{image.id}/blur", json={"boxes": [[0, 0, 99999, 10]]}).status_code == 400


def test_two_copies_of_one_photo_blurred_alike_do_not_clash(env, db):
    """05/11/2026, found in the log of the author's test: the same photo sent twice (different metadata, so two images)
    and blurred at the same place gave the same file, and the unique checksum made the blur fail. The checksum
    stays the one of the file as sent; sending the unblurred original again is still a duplicate."""
    storage, owner, e, image, c = _setup(env, db)
    pixels = cv2.imdecode(np.frombuffer(GROUP, np.uint8), 1)
    twin = images.upload_image(db, storage, owner, e, cv2.imencode(".jpg", pixels, [cv2.IMWRITE_JPEG_QUALITY, 99])[1].tobytes())
    face = c.get(f"/api/v1/images/{image.id}/faces").json()["faces"][0]
    for target in (image, twin):
        assert c.post(f"/api/v1/images/{target.id}/blur", json={"boxes": [face]}).status_code == 200
    with pytest.raises(images.DuplicateImage):
        images.upload_image(db, storage, owner, e, GROUP)
