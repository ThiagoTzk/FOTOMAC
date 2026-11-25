"""28/10/2026: the optional profile photo and the support page."""
from __future__ import annotations

import io
from datetime import datetime, timedelta, timezone

import cv2
import numpy as np
import piexif
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.accounts import photo
from app.api.support import reply_limiter, send_limiter
from app.db import models as m
from app.main import app
from app.support import service as support
from tests.support import jpeg
from tests.test_profiles_v2 import account, env, login  # noqa: F401  (env is a fixture)


def _with_gps(data: bytes) -> bytes:
    exif = piexif.dump({"0th": {}, "Exif": {}, "GPS": {piexif.GPSIFD.GPSLatitudeRef: b"S"}, "1st": {}, "thumbnail": None})
    out = io.BytesIO()
    piexif.insert(exif, data, out)
    return out.getvalue()


def test_the_profile_photo_is_optional_small_without_metadata_and_only_its_owner_sees_it(env, db):
    storage, _ = env
    a = account(db, m.AccountRole.PHOTOGRAPHER)
    c = login(a)
    assert c.get("/api/v1/auth/me").json()["photo_version"] is None                      # initials by default
    r = c.put("/api/v1/auth/me/photo", files={"file": ("eu.jpg", _with_gps(jpeg(7, 900, 600)), "image/jpeg")})
    assert r.status_code == 200 and r.json()["photo_version"]
    saved = storage.objects[a.photo_key]
    image = cv2.imdecode(np.frombuffer(saved, np.uint8), cv2.IMREAD_COLOR)
    assert image.shape[:2] == (photo.SIDE, photo.SIDE)                                    # square, small
    assert b"Exif" not in saved[:200]                                                     # no metadata, no GPS
    assert c.get("/api/v1/auth/me/photo").content == saved
    assert TestClient(app).get("/api/v1/auth/me/photo").status_code == 401
    bad = c.put("/api/v1/auth/me/photo", files={"file": ("x.jpg", b"not an image", "image/jpeg")})
    assert bad.status_code == 400 and "Formato" in bad.json()["detail"]
    assert c.delete("/api/v1/auth/me/photo").json()["photo_version"] is None
    assert a.photo_key is None and not storage.objects.get(f"accounts/{a.id}/photo.jpg")


def test_the_administrator_sees_the_photos_in_the_list_of_accounts_and_nobody_else_does(env, db):
    storage, _ = env
    a = account(db, m.AccountRole.PHOTOGRAPHER)
    photo.save(db, storage, a, jpeg(5, 400, 400))
    without = account(db, m.AccountRole.MARKETING)
    admin = login(account(db, m.AccountRole.ADMIN))
    rows = {r["id"]: r for r in admin.get("/api/v1/admin/accounts").json()["items"]}
    assert rows[str(a.id)]["photo_version"] and rows[str(without.id)]["photo_version"] is None   # None = initials
    assert admin.get(f"/api/v1/admin/accounts/{a.id}/photo").content == storage.objects[a.photo_key]
    assert admin.get(f"/api/v1/admin/accounts/{without.id}/photo").status_code == 404
    other = login(account(db, m.AccountRole.PHOTOGRAPHER))
    assert other.get(f"/api/v1/admin/accounts/{a.id}/photo").status_code == 403         # only the administrator
    assert TestClient(app).get(f"/api/v1/admin/accounts/{a.id}/photo").status_code == 401


def test_an_ended_temporary_account_keeps_no_photo(env, db):
    storage, _ = env
    a = account(db, m.AccountRole.PHOTOGRAPHER)
    photo.save(db, storage, a, jpeg(3, 400, 400))
    a.status = m.AccountStatus.EXPIRED
    db.flush()
    assert photo.remove_from_ended_accounts(db, storage) == 1
    assert a.photo_key is None and not any(k.startswith(f"accounts/{a.id}") for k in storage.objects)


def test_the_team_writes_to_support_and_both_sides_talk_until_it_is_solved(env, db):
    """28/10/2026, and 31/10/2026 (user test): a conversation — statuses between "Aberta" and "Resolvida", replies
    from both sides at any moment, and the bell tells each side what the other did."""
    send_limiter.reset()
    reply_limiter.reset()
    sender = account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha")
    admin = account(db, m.AccountRole.ADMIN, "Admin")
    s, ad = login(sender), login(admin)
    r = s.post("/api/v1/support", json={"kind": "problem", "subject": "Envio não termina",
                                        "message": "Quando envio 500 fotos no evento X, a barra para em 90%.",
                                        "page": "/eventos/abc/enviar"})
    assert r.status_code == 201 and r.json()["kind_label"] == "Problema" and r.json()["status_label"] == "Aberta"
    mid = r.json()["id"]
    assert s.post("/api/v1/support", json={"kind": "spam", "subject": "a", "message": "b"}).status_code == 400
    assert s.post("/api/v1/support", json={"kind": "question", "subject": " ", "message": "b"}).json()["detail"] == "Escreva o assunto."
    assert s.get("/api/v1/admin/support").status_code == 403                             # only the administration reads all
    listed = ad.get("/api/v1/admin/support?status=active").json()
    assert [x["author_name"] for x in listed] == ["Bruno Rocha"] and listed[0]["author_status"] == "active"
    assert listed[0]["unread"] is True

    def bell(client):
        return [n for n in client.get("/api/v1/notifications").json()["items"] if n["kind"] == "support"]

    assert bell(ad)[0]["title"] == "Suporte: nova mensagem de Bruno" and mid in bell(ad)[0]["href"]
    assert ad.post(f"/api/v1/admin/support/{mid}/seen").status_code == 204 and bell(ad) == []   # opened: read

    # The administration moves it to "Em análise" and asks something; the person is told, and answers.
    assert ad.post(f"/api/v1/admin/support/{mid}/status", json={"status": "analyzing"}).json()["status_label"] == "Em análise"
    assert ad.post(f"/api/v1/admin/support/{mid}/status", json={"status": "analyzing"}).status_code == 400
    ad.post(f"/api/v1/admin/support/{mid}/replies", json={"body": "Qual navegador você usa?"})
    assert bell(s)[0]["title"] == "Suporte: a administração respondeu"
    mine = s.get("/api/v1/support/mine").json()[0]
    assert mine["unread"] and [e["author_name"] for e in mine["entries"]] == ["Administração", "Administração"]
    assert mine["author_name"] is None                                                   # no author data on this side
    s.post(f"/api/v1/support/{mid}/seen")
    assert bell(s) == []
    assert s.post(f"/api/v1/support/{mid}/replies", json={"body": "Chrome, no Mac."}).status_code == 200
    assert bell(ad)[0]["title"] == "Suporte: nova resposta de Bruno"
    # Someone else's conversation does not exist for another account.
    other = login(account(db, m.AccountRole.MARKETING))
    assert other.post(f"/api/v1/support/{mid}/replies", json={"body": "oi"}).status_code == 404

    ad.post(f"/api/v1/admin/support/{mid}/status", json={"status": "fixing", "note": "Achamos a causa."})
    done = ad.post(f"/api/v1/admin/support/{mid}/status", json={"status": "resolved", "note": "Corrigido hoje."})
    assert done.json()["status"] == "resolved" and done.json()["resolved_at"]
    entries = s.get("/api/v1/support/mine").json()[0]["entries"]
    assert [(e["status"], e["body"]) for e in entries][-2:] == [("fixing", "Achamos a causa."), ("resolved", "Corrigido hoje.")]
    closed = s.post(f"/api/v1/support/{mid}/replies", json={"body": "Voltou a acontecer"})
    assert closed.status_code == 400 and "nova mensagem" in closed.json()["detail"]
    log = db.scalars(select(m.AuditLog).where(m.AuditLog.action.like("support.%"))).all()
    assert {x.action for x in log} >= {"support.sent", "support.reply", "support.status"}
    assert "500 fotos" not in str([x.details for x in log]) and "Chrome" not in str([x.details for x in log])   # never the text


def test_solved_messages_do_not_stay_forever(env, db):
    a = account(db, m.AccountRole.MARKETING)
    old = support.send(db, a, "suggestion", "Ideia", "Um filtro por cor.", None)
    new = support.send(db, a, "question", "Dúvida", "Como baixo o pacote?", None)
    for row in (old, new):
        row.status, row.resolved_at = "resolved", datetime.now(timezone.utc)
    old.resolved_at -= timedelta(days=support.KEEP_DAYS + 1)
    db.flush()
    assert support.delete_old(db) == 1
    assert [r.subject for r in support.mine(db, a)] == ["Dúvida"]
