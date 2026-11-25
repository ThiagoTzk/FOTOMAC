"""RF024 (atypical use, operations report) and RNF14 (compliance export), 11/11/2026."""
from __future__ import annotations

import csv
import io
import json
import zipfile
from datetime import date, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select

from app import audit
from app.api import public as public_api
from app.db import models as m
from app.main import app
from app.security import atypical
from tests.test_accounts import make_account
from tests.test_admin_config import login
from tests.test_profiles_v2 import account as team_account
from tests.support import jpeg
from tests.test_public import GROUP, _check, consent, engine, env, make_event, person_crop, photographer, publish_and_index, search  # noqa: F401

TODAY = date.today()


def alerts(db, kind=None):
    rows = db.scalars(select(m.AuditLog).where(m.AuditLog.action == atypical.ACTION)).all()
    return [r for r in rows if kind is None or r.details.get("kind") == kind]


def published_event(db, env, engine):
    storage, _ = env
    owner = photographer(db)
    e = make_event(db, owner)
    publish_and_index(db, storage, engine, owner, e, [GROUP])
    return e


def test_a_sequence_of_failed_liveness_checks_alerts_the_administrator(env, db, engine):
    atypical.reset()
    e = published_event(db, env, engine)
    c = TestClient(app)
    consent(c, e)
    for _ in range(atypical.LIVENESS_STREAK - 1):     # a photo held to the camera: no movement
        assert search(c, e, person_crop(), still=True).json()["detail"]["reason"] == "liveness"
    assert alerts(db, "liveness") == []                 # not yet: a real person may fail a few times
    search(c, e, person_crop(), still=True)
    [alert] = alerts(db, "liveness")
    assert alert.target_id == str(e.id) and alert.actor_account_id is None
    assert alert.details == {"kind": "liveness", "count": atypical.LIVENESS_STREAK, "minutes": atypical.LIVENESS_MINUTES}
    # The address is never written: not in the alert, not anywhere in the log (TestClient's address is "testclient").
    assert "testclient" not in json.dumps([r.details for r in db.scalars(select(m.AuditLog))])


def test_a_successful_search_ends_the_sequence(env, db, engine):
    atypical.reset()
    e = published_event(db, env, engine)
    for _ in range(atypical.LIVENESS_STREAK - 1):
        atypical.liveness_refused(db, "10.0.0.1", e.id)
    atypical.search_done("10.0.0.1")                    # got it right: the person was real
    atypical.liveness_refused(db, "10.0.0.1", e.id)
    atypical.liveness_refused(db, "10.0.0.2", e.id)     # another address counts on its own
    assert alerts(db, "liveness") == []


def test_too_many_searches_from_one_address_alert_once(env, db, engine, monkeypatch):
    atypical.reset()
    e = published_event(db, env, engine)
    monkeypatch.setattr(public_api.search_limiter, "max_requests", 2)
    c = TestClient(app)
    consent(c, e)
    codes = [search(c, e, person_crop()).status_code for _ in range(4)]
    assert codes[:2] == [200, 200] and codes[2:] == [429, 429]
    [alert] = alerts(db, "searches")                    # one alert per burst, not one per blocked request
    assert alert.details == {"kind": "searches", "count": 2, "minutes": 10} and alert.target_id == str(e.id)


def test_the_bell_shows_the_alert_to_the_administrator_only(env, db, engine):
    atypical.reset()
    e = published_event(db, env, engine)
    atypical.searches_blocked(db, "10.0.0.9", e.id, 20, 10)
    admin = login(make_account(db))
    notice = next(n for n in admin.get("/api/v1/notifications").json()["items"] if n["kind"] == "atypical")
    assert notice["href"] == "/registros" and "1 alerta" in notice["title"]
    other = login(make_account(db, "Bruno Rocha", m.AccountRole.PHOTOGRAPHER))
    assert all(n["kind"] != "atypical" for n in other.get("/api/v1/notifications").json()["items"])


def _sample(db, e, staff):
    """One of each kind of record the report reads."""
    audit.record(db, "public.search", None, "event", e.id, found=2, poses=3, videos=0)
    audit.record(db, "public.search", None, "event", e.id, found=0, poses=3, videos=0)
    audit.record(db, "public.search", None, "event", e.id, outcome="liveness")
    audit.record(db, "public.download", None, "image", "img-1", event_id=str(e.id))
    audit.record(db, "image.download", staff.id, "image", "img-2", event_id=str(e.id), publicity=True)
    audit.record(db, "image.download", staff.id, "image", "img-3", event_id=str(e.id), publicity=False)
    audit.record(db, "institutional.query", staff.id, "institutional_person", "p-1", date_from=None, date_to=None)
    db.add(m.ConsentRecord(event_id=e.id, text_version="2026-10"))
    db.commit()


def test_summary_counts_the_period_without_naming_anyone(env, db, engine):
    e = published_event(db, env, engine)
    admin_account = make_account(db)
    admin = login(admin_account)
    before = admin.get("/api/v1/admin/reports/summary", params={"start": TODAY.isoformat(), "end": TODAY.isoformat()}).json()
    _sample(db, e, admin_account)
    s = admin.get("/api/v1/admin/reports/summary", params={"start": TODAY.isoformat(), "end": TODAY.isoformat()}).json()
    assert s["public"]["searches"] - before["public"]["searches"] == 3
    assert s["public"]["found"] - before["public"]["found"] == 1
    assert s["public"]["no_result"] - before["public"]["no_result"] == 1
    assert s["public"]["liveness_refused"] - before["public"]["liveness_refused"] == 1
    assert s["publicity_downloads"] - before["publicity_downloads"] == 1      # only marketing on someone's work
    assert s["institutional_queries"] - before["institutional_queries"] == 1
    assert s["consents"] - before["consents"] == 1
    old = admin.get("/api/v1/admin/reports/summary", params={"start": "2026-01-01", "end": "2026-01-02"}).json()
    assert old["public"]["searches"] == 0                                       # outside the period
    bad = admin.get("/api/v1/admin/reports/summary", params={"start": TODAY.isoformat(),
                                                              "end": (TODAY - timedelta(days=1)).isoformat()})
    assert bad.status_code == 400


def test_export_has_every_record_rnf14_asks_for_and_is_itself_recorded(env, db, engine):
    e = published_event(db, env, engine)
    admin_account = make_account(db)
    admin = login(admin_account)
    _sample(db, e, admin_account)
    atypical.reset()
    atypical.searches_blocked(db, "10.0.0.7", e.id, 20, 10)
    r = admin.get("/api/v1/admin/reports/export.zip", params={"start": TODAY.isoformat(), "end": TODAY.isoformat()})
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert sorted(z.namelist()) == ["1-operacoes.csv", "2-consultas-institucionais.csv", "3-autorizacoes-institucionais.csv",
                                    "4-ciencia-dos-visitantes.csv", "5-downloads-para-divulgacao.csv",
                                    "6-consultas-publicas-por-dia.csv", "7-uso-atipico.csv", "LEIA-ME.txt"]

    def table(name):
        text = z.read(name).decode("utf-8")
        assert text.startswith("﻿")                                       # opens right in a spreadsheet
        return list(csv.reader(io.StringIO(text[1:]), delimiter=";"))

    publicity = table("5-downloads-para-divulgacao.csv")
    assert len(publicity) == 2 and publicity[1][3] == "Foto" and publicity[1][4] == e.name
    day = [row for row in table("6-consultas-publicas-por-dia.csv") if row[1] == e.name]
    assert day and day[0][2:7] == ["3", "1", "1", "1", "0"]                    # searches, found, none, liveness, other
    assert any(row[1] == "Buscas demais do mesmo endereço" for row in table("7-uso-atipico.csv"))
    assert any(row[1] == e.name for row in table("4-ciencia-dos-visitantes.csv"))
    visitors = [row for row in table("1-operacoes.csv") if row[4] == "public.search"]
    assert visitors and {row[1] for row in visitors} == {"Visitante (anônimo)"}
    everything = b"".join(z.read(n) for n in z.namelist()).decode("utf-8")
    assert "10.0.0.7" not in everything and "testclient" not in everything   # no address, ever
    # Taking the records out is an operation too.
    done = db.scalars(select(m.AuditLog).where(m.AuditLog.action == "report.exported")).all()[-1]
    assert done.actor_account_id == admin_account.id and done.details["start"] == TODAY.isoformat()


def test_only_the_administrator_reads_the_records(env, db, engine):
    for role in (m.AccountRole.PHOTOGRAPHER, m.AccountRole.MARKETING):
        c = login(team_account(db, role, "Equipe"))
        assert c.get("/api/v1/admin/reports/summary").status_code == 403
        assert c.get("/api/v1/admin/reports/export.zip").status_code == 403
    assert TestClient(app).get("/api/v1/admin/reports/export.zip").status_code == 401


def test_a_capture_ended_by_wrong_movements_is_a_failed_liveness_check(env, db, engine):
    """11/11/2026: 5 failures and no alert. Each capture ended on the screen after 3 wrong movements in one
    step, so no search was ever sent. The server now counts the capture where the screen gives up."""
    atypical.reset()
    e = published_event(db, env, engine)
    ended = lambda: db.scalars(select(m.AuditLog).where(m.AuditLog.action == atypical.CAPTURE_FAILED,
                                                         m.AuditLog.target_id == str(e.id))).all()
    a = "10.0.0.5"
    atypical.capture_started(a)
    atypical.step_checked(db, a, e.id, "direita", False, "no_face")
    atypical.step_checked(db, a, e.id, "direita", False, "movement")
    atypical.step_checked(db, a, e.id, "direita", True, None)             # got it right: the step starts over
    atypical.step_checked(db, a, e.id, "direita", False, "movement")
    atypical.step_checked(db, a, e.id, "direita", False, "opposite")
    for _ in range(atypical.CAPTURE_TRIES):                                # up or down only losing the face: the
        atypical.step_checked(db, a, e.id, "cima", False, "no_face")       # screen goes on, nothing ended
    assert ended() == []
    for _ in range(atypical.CAPTURE_TRIES):                                # a wrong movement (still, weak, sideways or
        atypical.step_checked(db, a, e.id, "baixo", False, "movement")     # the other way) ends the capture (09/11)
    assert len(ended()) == 1 and ended()[0].details == {"step": "baixo"}
    atypical.reset()
    for capture in range(atypical.LIVENESS_STREAK):
        atypical.capture_started(a)                                        # "Tentar de novo"
        for _ in range(atypical.CAPTURE_TRIES):
            atypical.step_checked(db, a, e.id, "esquerda", False, "movement")
        assert len(ended()) == capture + 2                                 # one per capture, with the event only
    assert ended()[1].details == {"step": "esquerda"} and ended()[1].actor_account_id is None
    [alert] = alerts(db, "liveness")                                       # the 5th ended capture raises it
    assert alert.target_id == str(e.id)
    admin = login(make_account(db))
    s = admin.get("/api/v1/admin/reports/summary", params={"start": TODAY.isoformat(), "end": TODAY.isoformat()}).json()
    assert s["public"]["liveness_refused"] >= atypical.LIVENESS_STREAK


def test_the_real_route_counts_the_ended_capture(env, db, engine):
    """The same, through the route the phone and the site call: a photo held still never does the movement."""
    atypical.reset()
    e = published_event(db, env, engine)
    c = TestClient(app)
    consent(c, e)
    assert c.post(f"/api/v1/public/events/{e.id}/capture").status_code == 200
    for _ in range(atypical.CAPTURE_TRIES):
        assert _check(c, e, "direita", "frente").json() == {"ok": False, "reason": "movement"}
    [row] = db.scalars(select(m.AuditLog).where(m.AuditLog.action == atypical.CAPTURE_FAILED,
                                                 m.AuditLog.target_id == str(e.id))).all()
    assert row.details == {"step": "direita"}


def test_a_covered_camera_ends_the_capture_and_counts(env, db, engine):
    """11/11/2026, the author's second test: a finger over the camera the whole time. The front step fails 3 times, the
    screen ends the capture, and that is a failed liveness check too (before, "no face" was not counted)."""
    atypical.reset()
    e = published_event(db, env, engine)
    c = TestClient(app)
    consent(c, e)
    covered = [("fronts", ("f.jpg", jpeg(1, w=640, h=480), "image/jpeg"))]
    covered += [("frames", (f"m{n}.jpg", jpeg(n + 2, w=640, h=480), "image/jpeg")) for n in range(3)]
    for capture in range(atypical.LIVENESS_STREAK):
        assert c.post(f"/api/v1/public/events/{e.id}/capture").status_code == 200
        for _ in range(atypical.CAPTURE_TRIES):
            r = c.post(f"/api/v1/public/events/{e.id}/capture/check", files=covered, data={"step": "frente"})
            assert r.json() == {"ok": False, "reason": "no_face"}
    rows = db.scalars(select(m.AuditLog).where(m.AuditLog.action == atypical.CAPTURE_FAILED,
                                                m.AuditLog.target_id == str(e.id))).all()
    assert [r.details for r in rows] == [{"step": "frente"}] * atypical.LIVENESS_STREAK
    assert len(alerts(db, "liveness")) == 1                                  # the 5th covered capture raises the alert
