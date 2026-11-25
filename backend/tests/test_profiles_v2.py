"""Marketing profile and temporary account of the hired photographer, through the real HTTP API."""
from __future__ import annotations

import re
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.accounts import service as accounts
from app.auth import passwords
from app.db import models as m
from app.db.session import get_session
from app.images import service as images
from app.main import app
from app.notifications.factory import get_email_sender
from app.security.rate_limit import login_limiter, password_link_limiter
from app.storage.factory import get_storage
from tests.support import MemoryStorage, jpeg

PASSWORD = "Fotomac#2026"
CPF = "529.982.247-25"   # a valid test CPF (check digits), not of a real person


class Outbox:
    def __init__(self):
        self.sent = []

    def send(self, message):
        self.sent.append(message)

    def link_for(self, email):
        body = next(msg.body for msg in reversed(self.sent) if msg.to == email)
        return re.search(r"primeiro-acesso\?token=([\w-]+)", body).group(1)


@pytest.fixture
def env(db):
    storage, outbox = MemoryStorage(), Outbox()
    login_limiter.reset()
    password_link_limiter.reset()
    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[get_storage] = lambda: storage
    app.dependency_overrides[get_email_sender] = lambda: outbox
    yield storage, outbox
    app.dependency_overrides.clear()


def account(db, role, name="Ana Lima", signature=True) -> m.Account:
    a = m.Account(full_name=name, email=f"{uuid.uuid4().hex[:8]}@cesmac.edu.br", role=role,
                  photographer_signature=name if signature and role != m.AccountRole.ADMIN else None,
                  password_hash=passwords.hash_password(PASSWORD), status=m.AccountStatus.ACTIVE)
    db.add(a)
    db.flush()
    return a


def login(a: m.Account) -> TestClient:
    c = TestClient(app)
    assert c.post("/api/v1/auth/login", json={"email": a.email, "password": PASSWORD}).status_code == 200
    return c


def event_of(db, owner, *, published=False, collaboration=False) -> m.Event:
    e = m.Event(name=f"Evento {uuid.uuid4().hex[:6]}", date_precision=m.DatePrecision.DAY, date_start=date(2026, 12, 19),
                date_end=date(2026, 12, 19), location="Campus I", description="Evento", owner_id=owner.id,
                expires_on=date(2027, 6, 19), collaboration_open=collaboration,
                status=m.EventStatus.PUBLISHED if published else m.EventStatus.EDITING)
    db.add(e)
    db.flush()
    return e


def contractor(db, env, admin_client, event) -> tuple[m.Account, TestClient]:
    """Created by the administrator, activated by the hired photographer with CPF and birth date."""
    _, outbox = env
    email = f"contratado.{uuid.uuid4().hex[:6]}@exemplo.com"   # personal e-mail allowed
    r = admin_client.post("/api/v1/admin/accounts", json={
        "full_name": "Eduardo Contratado", "email": email, "role": "contractor", "photographer_signature": "Eduardo C.",
        "bound_event_id": str(event.id), "contract_number": "CT-2026/045"})
    assert r.status_code == 201, r.text
    c = TestClient(app)
    token = outbox.link_for(email)
    check = c.post("/api/v1/auth/first-access/check", json={"token": token}).json()
    assert check == {"valid": True, "needs_identity": True, "full_name": "Eduardo Contratado"}
    r = c.post("/api/v1/auth/first-access", json={"token": token, "password": PASSWORD, "password_confirmation": PASSWORD,
                                                  "cpf": CPF, "birth_date": "1990-05-20"})
    assert r.status_code == 200, r.text
    return db.get(m.Account, r.json()["id"]), c


# ----------------------------------------------------------------- marketing

def test_marketing_produces_like_a_photographer_with_its_own_label(env, db):
    storage, _ = env
    mkt = account(db, m.AccountRole.MARKETING, "Lucas Bezerra")
    c = login(mkt)
    theme = c.post("/api/v1/themes", json={"name": f"Divulgação {uuid.uuid4().hex[:4]}"})
    assert theme.status_code == 201                                             # creates themes
    r = c.post("/api/v1/events", data={"name": "Semana de Marketing", "theme_ids": [str(theme.json()["id"])],
                                       "date_precision": "day", "date_start": "2026-09-18", "location": "Campus I",
                                       "description": "Cobertura da equipe."},
               files={"cover": ("capa.jpg", jpeg(1), "image/jpeg")})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["owner"]["team"] == "Equipe de marketing" and body["relation"] == "owner"
    up = c.post(f"/api/v1/events/{body['id']}/images", files={"file": ("f.jpg", jpeg(2, w=400, h=300), "image/jpeg")})
    assert up.status_code == 201 and up.json()["approval"] is None               # no approval for staff
    assert c.post(f"/api/v1/events/{body['id']}/publish").status_code == 200


def test_marketing_sees_only_the_published_photos_of_other_events(env, db):
    storage, _ = env
    photographer, mkt = account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha"), account(db, m.AccountRole.MARKETING)
    e = event_of(db, photographer, published=True)
    published = images.upload_image(db, storage, photographer, e, jpeg(3, w=400, h=300))
    images.publish(db, storage, photographer, e)
    in_review = images.upload_image(db, storage, photographer, e, jpeg(4, w=400, h=300))
    hidden = event_of(db, photographer)                                       # still being edited
    c = login(mkt)
    listed = {x["name"]: x for x in c.get("/api/v1/events").json()["items"]}
    # Since 01/11/2026 the event still being edited is FOUND (to ask to collaborate), as a summary only.
    assert listed[e.name]["relation"] == "viewer" and listed[hidden.name]["relation"] == "outsider"
    assert c.get(f"/api/v1/events/{hidden.id}/images").status_code == 404
    detail = c.get(f"/api/v1/events/{e.id}").json()
    assert detail["relation"] == "viewer" and not detail["can_manage"] and detail["photos"] == 1
    listed = c.get(f"/api/v1/events/{e.id}/images").json()
    assert [i["id"] for i in listed["items"]] == [str(published.id)] and listed["counts"]["all"] == 1
    assert c.get(f"/api/v1/images/{in_review.id}").status_code == 404           # under review: not for viewers
    assert c.post(f"/api/v1/events/{e.id}/images", files={"file": ("f.jpg", jpeg(5), "image/jpeg")}).status_code == 403
    assert c.post(f"/api/v1/events/{e.id}/publish").status_code == 403


# ----------------------------------------------------------------- hired photographer

def test_the_temporary_account_is_created_for_one_event_and_one_contract(env, db):
    admin = login(account(db, m.AccountRole.ADMIN))
    base = {"full_name": "Eduardo Contratado", "email": "eduardo@exemplo.com", "role": "contractor",
            "photographer_signature": "Eduardo C."}
    assert "evento" in admin.post("/api/v1/admin/accounts", json=base).json()["detail"]
    e = event_of(db, account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha"))
    no_contract = admin.post("/api/v1/admin/accounts", json={**base, "bound_event_id": str(e.id)})
    assert "contrato" in no_contract.json()["detail"]
    ok = admin.post("/api/v1/admin/accounts", json={**base, "bound_event_id": str(e.id), "contract_number": "CT-1"})
    assert ok.status_code == 201 and ok.json()["contractor"]["event_name"] == e.name
    created = db.get(m.Account, ok.json()["id"])
    assert admin.put(f"/api/v1/admin/accounts/{created.id}", json={
        "full_name": created.full_name, "role": "photographer", "photographer_signature": "Eduardo C."}).status_code == 400


def test_first_access_requires_a_valid_cpf_and_starts_the_24_hours(env, db):
    _, outbox = env
    admin = login(account(db, m.AccountRole.ADMIN))
    e = event_of(db, account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha"))
    admin.post("/api/v1/admin/accounts", json={"full_name": "Eduardo Contratado", "email": "c2@exemplo.com",
                                              "role": "contractor", "photographer_signature": "Eduardo C.",
                                              "bound_event_id": str(e.id), "contract_number": "CT-2"})
    c, token = TestClient(app), outbox.link_for("c2@exemplo.com")
    base = {"token": token, "password": PASSWORD, "password_confirmation": PASSWORD, "birth_date": "1990-05-20"}
    assert c.post("/api/v1/auth/first-access", json=base).json()["detail"]["message"] == "Informe um CPF válido."
    assert c.post("/api/v1/auth/first-access", json={**base, "cpf": "111.111.111-11"}).status_code == 400
    assert c.post("/api/v1/auth/first-access", json={**base, "cpf": "529.982.247-24"}).status_code == 400  # wrong digit
    r = c.post("/api/v1/auth/first-access", json={**base, "cpf": CPF})
    assert r.status_code == 200 and r.json()["role_label"] == "Fotógrafo contratado"
    a = db.get(m.Account, r.json()["id"])
    assert a.status == m.AccountStatus.ACTIVE
    assert timedelta(hours=23, minutes=59) < a.valid_until - datetime.now(timezone.utc) <= timedelta(hours=24)
    assert b"52998224725" not in a.cpf_encrypted and b"1990" not in a.birth_date_encrypted      # encrypted at rest
    detail = admin.get(f"/api/v1/admin/accounts/{a.id}").json()["contractor"]
    assert detail["cpf"] == "***.***.***-25" and detail["birth_date"] == "1990-05-20"          # masked


def test_contractor_works_only_on_its_event_and_its_photos_wait_for_approval(env, db):
    storage, _ = env
    owner = account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha")
    admin_account = account(db, m.AccountRole.ADMIN)
    admin = login(admin_account)
    e = event_of(db, owner)
    other = event_of(db, owner, collaboration=True)                            # open, but not its event
    own_photo = images.upload_image(db, storage, owner, e, jpeg(10, w=400, h=300))
    hired, c = contractor(db, env, admin, e)

    assert [x["id"] for x in c.get("/api/v1/events").json()["items"]] == [str(e.id)]
    assert c.get(f"/api/v1/events/{other.id}").status_code == 404
    assert c.post(f"/api/v1/events/{other.id}/images", files={"file": ("f.jpg", jpeg(11), "image/jpeg")}).status_code == 404
    assert c.post("/api/v1/themes", json={"name": "Tema do contratado"}).status_code == 403
    assert c.post("/api/v1/events", data={"name": "x"}).status_code in (403, 422)
    up = c.post(f"/api/v1/events/{e.id}/images", files={"file": ("f.jpg", jpeg(12, w=400, h=300), "image/jpeg")})
    assert up.status_code == 201 and up.json()["approval"] == "pending"
    mine = c.get(f"/api/v1/events/{e.id}/images").json()["items"]
    assert [i["id"] for i in mine] == [up.json()["id"]]                       # only its own photos
    assert c.get(f"/api/v1/images/{own_photo.id}").status_code == 404
    assert c.post(f"/api/v1/events/{e.id}/publish").status_code == 403         # never publishes

    owner_client = login(owner)
    assert owner_client.post(f"/api/v1/events/{e.id}/publish").json()["published"] == 1   # its photo waits
    waiting = db.get(m.Image, up.json()["id"])
    assert waiting.review_status == m.ImageReviewStatus.IN_REVIEW
    assert owner_client.post(f"/api/v1/images/{waiting.id}/approval", json={"approve": True}).status_code == 403
    assert admin.post(f"/api/v1/images/{waiting.id}/approval", json={"approve": True}).json()["image"]["approval"] == "approved"
    assert owner_client.post(f"/api/v1/events/{e.id}/publish").json()["published"] == 1
    assert db.get(m.Image, waiting.id).review_status == m.ImageReviewStatus.PUBLISHED

    rejected = c.post(f"/api/v1/events/{e.id}/images", files={"file": ("g.jpg", jpeg(13, w=400, h=300), "image/jpeg")}).json()
    url = f"/api/v1/images/{rejected['id']}/approval"
    assert admin.post(url, json={"approve": False}).status_code == 400                   # 22/10/2026: a reason is required
    out = admin.post(url, json={"approve": False, "reason": "Foto tremida, fora de foco."}).json()["image"]
    assert out["approval"] == "rejected" and out["rejection_reason"] == "Foto tremida, fora de foco."
    seen = c.get(f"/api/v1/events/{e.id}/images?filter=rejected").json()["items"]
    assert [i["rejection_reason"] for i in seen] == ["Foto tremida, fora de foco."]       # the sender reads the reason
    assert any(n["kind"] == "own_rejected" for n in c.get("/api/v1/notifications").json()["items"])
    # Bug seen on 24/10/2026: the owner's bell said "1 imagem pronta para publicação" for a
    # rejected photo, and the event counted it as in review.
    assert not [n for n in owner_client.get("/api/v1/notifications").json()["items"] if n["kind"] == "ready"]
    assert owner_client.get(f"/api/v1/events/{e.id}").json()["photos"] == 2              # own photo + approved one
    assert owner_client.post(f"/api/v1/events/{e.id}/publish").status_code == 400        # never published...
    assert db.get(m.Image, rejected["id"]).review_status == m.ImageReviewStatus.IN_REVIEW
    assert not db.scalar(select(func.count()).select_from(m.FaceEmbedding).where(m.FaceEmbedding.image_id == rejected["id"]))
    image = db.get(m.Image, rejected["id"])
    image.rejected_at -= timedelta(days=8)                                               # ...and gone after 7 days
    db.flush()
    assert images.eliminate_rejected(db, storage) == 1
    assert db.get(m.Image, rejected["id"]) is None
    assert not [k for k in storage.objects if rejected["id"] in k]
    actions = set(db.scalars(select(m.AuditLog.action).where(m.AuditLog.target_id.in_([str(waiting.id), rejected["id"]]))))
    assert {"image.approved", "image.rejected"} <= actions


def test_the_account_expires_at_the_end_of_its_period_and_is_kept(env, db):
    _, outbox = env
    admin_account = account(db, m.AccountRole.ADMIN)
    admin = login(admin_account)
    e = event_of(db, account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha"))
    hired, c = contractor(db, env, admin, e)
    assert c.get("/api/v1/auth/me").status_code == 200
    hired.valid_until = datetime.now(timezone.utc) - timedelta(minutes=1)
    db.flush()
    # Mid-session (31/10/2026): only the restricted screen is left — why it stopped, and the Support page.
    assert c.get("/api/v1/auth/me").json()["status"] == "expired"
    assert c.get(f"/api/v1/events/{e.id}").status_code == 401
    assert hired.status == m.AccountStatus.EXPIRED
    again = TestClient(app).post("/api/v1/auth/login", json={"email": hired.email, "password": PASSWORD})
    assert again.status_code == 200 and again.json()["status"] == "expired"
    r = admin.post(f"/api/v1/admin/accounts/{hired.id}/status", json={"status": "active"})
    assert r.status_code == 400 and "Renovar acesso" in r.json()["detail"]      # the way back is the renewal
    assert db.get(m.Account, hired.id) is not None                              # kept, never deleted
    sent = len(outbox.sent)
    TestClient(app).post("/api/v1/auth/password/forgot", json={"email": hired.email})
    assert len(outbox.sent) == sent                                              # no self-service reset


def _create_contractor(admin, email, event, **extra):
    return admin.post("/api/v1/admin/accounts", json={
        "full_name": "Jonas Fotógrafo", "email": email, "role": "contractor", "photographer_signature": "Jonas F.",
        "bound_event_id": str(event.id), "contract_number": "CT-9", **extra})


def test_the_administrator_chooses_how_long_the_temporary_account_works(env, db):
    _, outbox = env
    admin = login(account(db, m.AccountRole.ADMIN))
    e = event_of(db, account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha"))
    for wrong in (0, 721):
        assert "prazo" in _create_contractor(admin, f"j{wrong}@exemplo.com", e, contract_hours=wrong).json()["detail"]
    r = _create_contractor(admin, "jonas@exemplo.com", e, contract_hours=72)
    assert r.status_code == 201 and r.json()["contractor"]["contract_hours"] == 72
    c = TestClient(app)
    r = c.post("/api/v1/auth/first-access", json={"token": outbox.link_for("jonas@exemplo.com"), "password": PASSWORD,
                                                  "password_confirmation": PASSWORD, "cpf": CPF, "birth_date": "1990-05-20"})
    left = db.get(m.Account, r.json()["id"]).valid_until - datetime.now(timezone.utc)
    assert timedelta(hours=71, minutes=59) < left <= timedelta(hours=72)        # the 72 h start at the first access


def test_an_expired_temporary_account_is_renewed_for_a_new_coverage(env, db):
    storage, outbox = env
    admin_account = account(db, m.AccountRole.ADMIN)
    admin = login(admin_account)
    owner = account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha")
    first, second = event_of(db, owner), event_of(db, owner)
    hired, c = contractor(db, env, admin, first)
    photo = c.post(f"/api/v1/events/{first.id}/images", files={"file": ("f.jpg", jpeg(30, w=400, h=300), "image/jpeg")}).json()
    hired.valid_until = datetime.now(timezone.utc) - timedelta(minutes=1)
    db.flush()
    assert accounts.expire_contractors(db) == 1

    url = f"/api/v1/admin/accounts/{hired.id}/contract"
    assert admin.post(url, json={"event_id": str(second.id), "contract_number": "CT-10", "hours": 0}).status_code == 400
    r = admin.post(url, json={"event_id": str(second.id), "contract_number": "CT-10", "hours": 72})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "active" and body["contractor"]["event_name"] == second.name
    assert body["contractor"]["contract_number"] == "CT-10" and body["contractor"]["contract_hours"] == 72
    left = db.get(m.Account, hired.id).valid_until - datetime.now(timezone.utc)
    assert timedelta(hours=71, minutes=59) < left <= timedelta(hours=72)
    assert "renovado" in outbox.sent[-1].subject and second.name in outbox.sent[-1].body

    again = login(hired)                                                         # same e-mail, same password
    assert [x["id"] for x in again.get("/api/v1/events").json()["items"]] == [str(second.id)]   # the new event only
    assert db.get(m.Image, photo["id"]).uploaded_by == hired.id                  # earlier photos keep the credit
    audit = db.scalars(select(m.AuditLog).where(m.AuditLog.action == "account.contract_renewed")).all()[-1]
    assert audit.actor_account_id == admin_account.id and audit.details["previous"]["status"] == "expired"

    # Still working: the hours are ADDED to what is left.
    before = db.get(m.Account, hired.id).valid_until
    admin.post(url, json={"event_id": str(second.id), "contract_number": "CT-10", "hours": 24})
    db.refresh(hired)
    assert hired.valid_until - before == timedelta(hours=24)


def test_renewing_after_the_identification_was_erased_asks_for_it_again(env, db):
    _, outbox = env
    admin = login(account(db, m.AccountRole.ADMIN))
    e = event_of(db, account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha"))
    hired, _ = contractor(db, env, admin, e)
    hired.status, hired.valid_until = m.AccountStatus.EXPIRED, datetime.now(timezone.utc) - timedelta(days=200)
    hired.cpf_encrypted = hired.birth_date_encrypted = None
    hired.identity_erased_at = datetime.now(timezone.utc)
    db.flush()
    r = admin.post(f"/api/v1/admin/accounts/{hired.id}/contract",
                   json={"event_id": str(e.id), "contract_number": "CT-11", "hours": 48})
    assert r.status_code == 200 and r.json()["status"] == "pending"
    c, token = TestClient(app), outbox.link_for(hired.email)
    assert c.post("/api/v1/auth/first-access/check", json={"token": token}).json()["needs_identity"] is True
    r = c.post("/api/v1/auth/first-access", json={"token": token, "password": PASSWORD, "password_confirmation": PASSWORD,
                                                  "cpf": CPF, "birth_date": "1990-05-20"})
    assert r.status_code == 200
    db.refresh(hired)
    assert hired.identity_erased_at is None and hired.cpf_encrypted is not None
    assert timedelta(hours=47) < hired.valid_until - datetime.now(timezone.utc) <= timedelta(hours=48)


def test_only_a_working_temporary_account_is_renewed(env, db):
    admin = login(account(db, m.AccountRole.ADMIN))
    e = event_of(db, account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha"))
    staff = account(db, m.AccountRole.PHOTOGRAPHER, "Paula Reis")
    body = {"event_id": str(e.id), "contract_number": "CT-12", "hours": 24}
    assert admin.post(f"/api/v1/admin/accounts/{staff.id}/contract", json=body).status_code == 400
    hired, _ = contractor(db, env, admin, e)
    hired.status = m.AccountStatus.SUSPENDED
    db.flush()
    assert "Reative" in admin.post(f"/api/v1/admin/accounts/{hired.id}/contract", json=body).json()["detail"]
    assert login(account(db, m.AccountRole.PHOTOGRAPHER, "Rui Costa")).post(
        f"/api/v1/admin/accounts/{hired.id}/contract", json=body).status_code == 403


def test_identity_is_erased_after_the_retention(env, db):
    storage, _ = env
    admin = login(account(db, m.AccountRole.ADMIN))
    e = event_of(db, account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha"))
    hired, c = contractor(db, env, admin, e)
    photo = c.post(f"/api/v1/events/{e.id}/images", files={"file": ("f.jpg", jpeg(20, w=400, h=300), "image/jpeg")}).json()
    hired.valid_until = datetime.now(timezone.utc) - timedelta(minutes=1)
    db.flush()
    assert accounts.expire_contractors(db) == 1
    assert accounts.erase_contractor_identities(db) == 0 and hired.media_gone_at is None   # its photo is in the collection
    images.delete_image(db, storage, None, db.get(m.Image, photo["id"]))
    accounts.erase_contractor_identities(db)
    assert hired.media_gone_at is not None and hired.cpf_encrypted is not None              # the period starts now
    hired.media_gone_at -= timedelta(days=30 * 36 + 1)                                     # provisional: 36 months
    db.flush()
    assert accounts.erase_contractor_identities(db) == 1
    assert hired.cpf_encrypted is None and hired.birth_date_encrypted is None and hired.identity_erased_at
    assert hired.full_name == "Eduardo Contratado"                                          # the name stays
    assert db.scalar(select(func.count()).select_from(m.AuditLog).where(
        m.AuditLog.action == "account.identity_erased", m.AuditLog.target_id == str(hired.id))) == 1


@pytest.mark.parametrize("email, role, ok", [
    ("bruno@gmail.com", "photographer", False),
    ("lucas@hotmail.com", "marketing", False),
    ("chefe@exemplo.com", "admin", False),
    ("bruno@cesmac.edu.br", "photographer", True),
    ("aluno@academico.cesmac.edu.br", "marketing", True),     # a subdomain of the institution
    ("falso@cesmac.edu.br.exemplo.com", "photographer", False),
])
def test_only_the_hired_photographer_may_use_a_personal_email(env, db, email, role, ok):
    """Decision of 17/10/2026: whoever works for the CESMAC has an institutional e-mail."""
    admin = login(account(db, m.AccountRole.ADMIN))
    r = admin.post("/api/v1/admin/accounts", json={"full_name": "Pessoa de Teste", "email": email, "role": role,
                                                   "photographer_signature": "Pessoa"})
    assert (r.status_code == 201) is ok, r.text
    if not ok:
        assert "e-mail institucional" in r.json()["detail"]


def test_batch_approval_records_who_approved_and_the_dashboard_points_to_the_event(env, db):
    """17/10/2026: approving 200 photos one by one is not a safety requirement — the record is. Each
    approved photo says who sent it and who approved it; the overview shows where photos wait."""
    storage, _ = env
    owner = account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha")
    admin_account = account(db, m.AccountRole.ADMIN, "Ana Lima")
    admin = login(admin_account)
    e = event_of(db, owner)
    hired, c = contractor(db, env, admin, e)
    ids = [c.post(f"/api/v1/events/{e.id}/images", files={"file": (f"{n}.jpg", jpeg(30 + n, w=400, h=300), "image/jpeg")}).json()["id"]
           for n in range(3)]
    board = admin.get("/api/v1/dashboard").json()
    assert board["approvals_pending"] == [{"event_id": str(e.id), "event_name": e.name, "photos": 3}]
    assert board["attention"] >= 1 and board["approvals_total"] == 3        # one situation, three photos
    bell = admin.get("/api/v1/notifications").json()
    assert any(n["kind"] == "approval" and n["urgent"] and "3 imagens aguardam" in n["title"] for n in bell["items"])
    assert bell["urgent"] == board["attention"]
    assert login(owner).post(f"/api/v1/events/{e.id}/images/approval", json={"image_ids": ids, "approve": True}).status_code == 403
    assert admin.post(f"/api/v1/events/{e.id}/images/approval", json={"image_ids": ids[:2], "approve": True}).json() == {"decided": 2}
    detail = admin.get(f"/api/v1/images/{ids[0]}").json()
    assert detail["approval"] == "approved" and detail["approved_by_name"] == "Ana Lima"
    assert detail["uploaded_by_name"] == "Eduardo Contratado" and detail["approved_at"]
    assert admin.post(f"/api/v1/events/{e.id}/images/approval", json={"image_ids": ids, "approve": False}).status_code == 400
    assert admin.post(f"/api/v1/events/{e.id}/images/approval",
                      json={"image_ids": ids, "approve": False, "reason": "Fora do contrato."}).json() == {"decided": 1}
    assert db.get(m.Image, ids[2]).approval == "rejected"                        # only the pending one was rejected
    assert admin.get("/api/v1/dashboard").json()["approvals_pending"] == []


def test_the_hired_photographer_does_not_replace_files(env, db):
    """A new version is a new image, reviewed like any other. This removes the case of a photo
    approved and then swapped, at its root."""
    owner = account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha")
    admin = login(account(db, m.AccountRole.ADMIN, "Ana Lima"))
    e = event_of(db, owner)
    _, c = contractor(db, env, admin, e)
    image_id = c.post(f"/api/v1/events/{e.id}/images", files={"file": ("a.jpg", jpeg(40, w=400, h=300), "image/jpeg")}).json()["id"]
    for _ in range(2):   # before and after the approval
        r = c.put(f"/api/v1/images/{image_id}/file", files={"file": ("b.jpg", jpeg(41, w=400, h=300), "image/jpeg")})
        assert r.status_code == 403
        admin.post(f"/api/v1/images/{image_id}/approval", json={"approve": True})
    # The administrator may still replace a hired photographer's photo — and then it waits for approval again.
    r = admin.put(f"/api/v1/images/{image_id}/file", files={"file": ("c.jpg", jpeg(42, w=400, h=300), "image/jpeg")})
    assert r.status_code == 200 and r.json()["approval"] == "pending" and r.json()["approved_by_name"] is None
    log = db.scalar(select(m.AuditLog).where(m.AuditLog.action == "image.replace", m.AuditLog.target_id == image_id))
    assert log.details["approval_reset"] is True


# ----------------------------------------------------------------- themes (RF027)

def test_team_maintains_themes_and_only_the_author_changes_each_one(env, db):
    """RF027 (11/11/2026, Rafael after the stakeholder meeting): photographers and marketing have the Temas
    screen too. One list for all, with the author; only the author (or the administrator) changes a theme."""
    admin = login(account(db, m.AccountRole.ADMIN))
    author = login(account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha"))
    other = login(account(db, m.AccountRole.MARKETING, "Lucas Bezerra"))
    t = author.post("/api/v1/themes", json={"name": f"Ensaio {uuid.uuid4().hex[:4]}", "icon": "camera"}).json()

    row = next(r for r in other.get("/api/v1/themes/manage").json() if r["id"] == t["id"])
    assert row["author"] == "Bruno Rocha" and row["mine"] is False and row["can_change"] is False   # sees it, as read-only
    mine = next(r for r in author.get("/api/v1/themes/manage").json() if r["id"] == t["id"])
    assert mine["mine"] is True and mine["can_change"] is True

    # Somebody else's theme: refused on the server, whatever the screen shows.
    assert other.put(f"/api/v1/themes/{t['id']}", json={"name": "Trocado"}).status_code == 403
    assert other.post(f"/api/v1/themes/{t['id']}/status", json={"active": False}).status_code == 403
    assert other.delete(f"/api/v1/themes/{t['id']}").status_code == 403
    assert db.get(m.Theme, t["id"]).name == t["name"]

    # The author changes it; the administrator may change any theme.
    assert author.put(f"/api/v1/themes/{t['id']}", json={"name": t["name"] + " II"}).json()["name"] == t["name"] + " II"
    assert author.post(f"/api/v1/themes/{t['id']}/status", json={"active": False}).json()["active"] is False
    assert admin.post(f"/api/v1/themes/{t['id']}/status", json={"active": True}).json()["can_change"] is True

    # A theme without an author (the account is gone, or it came with the system) is left to the administrator.
    orphan = m.Theme(name=f"Sem autor {uuid.uuid4().hex[:4]}", active=True, icon="tag", created_by=None)
    db.add(orphan)
    db.flush()
    assert next(r for r in author.get("/api/v1/themes/manage").json() if r["id"] == orphan.id)["author"] is None
    assert author.put(f"/api/v1/themes/{orphan.id}", json={"name": "Meu agora"}).status_code == 403
    assert admin.delete(f"/api/v1/themes/{orphan.id}").status_code == 204

    # The author deletes an unused theme of their own.
    assert author.delete(f"/api/v1/themes/{t['id']}").status_code == 204


def test_the_temporary_account_has_no_themes_screen(env, db):
    admin = login(account(db, m.AccountRole.ADMIN))
    _, hired = contractor(db, env, admin, event_of(db, account(db, m.AccountRole.PHOTOGRAPHER)))
    assert hired.get("/api/v1/themes/manage").status_code == 403
    theme = db.scalars(select(m.Theme)).first() or m.Theme(name="Qualquer", active=True, icon="tag")
    db.add(theme)
    db.flush()
    assert hired.put(f"/api/v1/themes/{theme.id}", json={"name": "Do contratado"}).status_code == 403
    assert hired.delete(f"/api/v1/themes/{theme.id}").status_code == 403
