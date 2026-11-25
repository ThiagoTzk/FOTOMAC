"""Collaboration by request (01/11/2026): every photographer finds every active event, but sees only the summary of
the ones it does not work on; it asks the responsible, who accepts or declines; each side is told on the bell."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.db import models as m
from app.events import collaboration
from tests.support import jpeg
from tests.test_profiles_v2 import account, contractor, env, event_of, login  # noqa: F401 (env is a fixture)


def notices(c) -> list[dict]:
    return c.get("/api/v1/notifications").json()["items"]


def test_an_outsider_finds_the_event_but_never_its_photos(env, db):
    storage, _ = env
    owner = account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha")
    rafael = account(db, m.AccountRole.PHOTOGRAPHER, "Rafael Costa")
    e = event_of(db, owner, published=True)
    from app.images import service as images
    images.upload_image(db, storage, owner, e, jpeg(50, w=400, h=300))
    c = login(rafael)

    listed = {x["id"]: x for x in c.get("/api/v1/events").json()["items"]}
    assert str(e.id) in listed and listed[str(e.id)]["relation"] == "outsider"
    assert listed[str(e.id)]["collaborators"] == []                      # nobody's credit list, only the summary
    assert str(e.id) not in {x["id"] for x in c.get("/api/v1/events", params={"scope": "enabled"}).json()["items"]}
    assert c.get(f"/api/v1/events/{e.id}/images").status_code == 404     # the photos stay with who works there
    assert c.post(f"/api/v1/events/{e.id}/images", files={"file": ("f.jpg", jpeg(51), "image/jpeg")}).status_code in (403, 404)
    assert c.get(f"/api/v1/events/{e.id}/members").status_code == 404
    assert c.get(f"/api/v1/events/{e.id}/collaboration-requests").status_code == 404

    expired = event_of(db, owner)
    expired.status = m.EventStatus.EXPIRED
    db.flush()
    assert c.get(f"/api/v1/events/{expired.id}").status_code == 404     # only the active ones are found


def test_ask_accept_and_both_sides_are_told(env, db):
    owner = account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha")
    rafael = account(db, m.AccountRole.PHOTOGRAPHER, "Rafael Costa")
    e = event_of(db, owner)
    c_owner, c_rafael = login(owner), login(rafael)
    url = f"/api/v1/events/{e.id}/collaboration-requests"

    assert c_rafael.post(url, json={}).status_code == 400                 # nothing chosen
    asked = c_rafael.post(url, json={"wants_upload": True, "wants_raw": True,
                                     "message": "Quero enviar 24 imagens deste evento."})
    assert asked.status_code == 201, asked.text
    mine = asked.json()["my_request"]
    assert mine["status"] == "pending" and mine["message"] == "Quero enviar 24 imagens deste evento."
    assert c_rafael.post(url, json={"wants_upload": True}).status_code == 400   # one waiting request at a time

    told = [n for n in notices(c_owner) if n["kind"] == "collab_request"]
    assert len(told) == 1 and "Rafael pediu para enviar imagens e usar arquivos RAW" in told[0]["title"]
    assert "Quero enviar 24 imagens" in told[0]["description"] and told[0]["href"].endswith("?aba=configuracao")
    assert c_owner.get(f"/api/v1/events/{e.id}").json()["requests_waiting"] == 1

    rid = mine["id"]
    # Somebody else (not the responsible) cannot answer it; nor can the requester.
    stranger = login(account(db, m.AccountRole.PHOTOGRAPHER, "Rui Costa"))
    assert stranger.post(f"{url}/{rid}/decision", json={"accept": True}).status_code == 404
    assert c_rafael.post(f"{url}/{rid}/decision", json={"accept": True}).status_code == 404

    done = c_owner.post(f"{url}/{rid}/decision", json={"accept": True, "reply": "Aceitei, pode enviar.", "turn_raw_on": False})
    assert done.status_code == 200 and done.json()["status"] == "accepted" and done.json()["raw_turned_on"] is False
    db.expire_all()
    assert db.get(m.Event, e.id).raw_enabled is False                     # RAW only when ticked
    assert not [n for n in notices(c_owner) if n["kind"] == "collab_request"]

    me = c_rafael.get(f"/api/v1/events/{e.id}").json()
    assert me["relation"] == "collaborator" and me["can_upload"] is True and me["ask_upload"] is False
    assert me["ask_raw"] is True                                          # RAW can still be asked later
    answer = [n for n in notices(c_rafael) if n["kind"] == "collab_answer"]
    assert len(answer) == 1 and answer[0]["title"].startswith("Bruno Rocha aceitou a sua participação")
    assert "Aceitei, pode enviar." in answer[0]["description"]
    assert c_rafael.post(f"/api/v1/events/{e.id}/images", files={"file": ("f.jpg", jpeg(52), "image/jpeg")}).status_code == 201
    assert c_rafael.post(f"{url}/{rid}/seen").status_code == 204
    assert not [n for n in notices(c_rafael) if n["kind"] == "collab_answer"]

    people = {p["full_name"]: p for p in c_owner.get(f"/api/v1/events/{e.id}/members").json()}
    assert people["Rafael Costa"]["allowed"] is True                      # in "Quem trabalha", to switch off later
    actions = set(db.scalars(select(m.AuditLog.action).where(m.AuditLog.target_id == str(e.id))))
    assert {"event.collaboration_requested", "event.collaboration_request_accepted"} <= actions


def test_raw_request_turns_raw_on_only_when_ticked_and_decline_is_told(env, db):
    owner = account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha")
    ana = account(db, m.AccountRole.MARKETING, "Ana Souza")
    e = event_of(db, owner, collaboration=True)                          # Ana already sends: she only asks for RAW
    c_owner, c_ana = login(owner), login(ana)
    url = f"/api/v1/events/{e.id}/collaboration-requests"
    assert c_ana.post(url, json={"wants_upload": True}).status_code == 400   # she already can
    rid = c_ana.post(url, json={"wants_raw": True}).json()["my_request"]["id"]
    assert c_owner.post(f"{url}/{rid}/decision", json={"accept": True, "turn_raw_on": True}).json()["raw_turned_on"] is True
    db.expire_all()
    assert db.get(m.Event, e.id).raw_enabled is True
    assert c_ana.get(f"/api/v1/events/{e.id}").json()["ask_raw"] is False

    e2 = event_of(db, owner)
    url2 = f"/api/v1/events/{e2.id}/collaboration-requests"
    rid2 = c_ana.post(url2, json={"wants_upload": True}).json()["my_request"]["id"]
    assert c_owner.post(f"{url2}/{rid2}/decision", json={"accept": True, "turn_raw_on": True}).status_code == 400
    assert c_owner.post(f"{url2}/{rid2}/decision", json={"accept": False, "reply": "Já temos fotógrafos."}).status_code == 200
    told = [n for n in notices(c_ana) if n["kind"] == "collab_answer" and e2.name in n["description"]]
    assert told and told[0]["title"].startswith("Bruno Rocha recusou") and told[0]["tone"] == "warning"
    assert c_ana.get(f"/api/v1/events/{e2.id}").json()["can_upload"] is False
    assert c_owner.post(f"{url2}/{rid2}/decision", json={"accept": True}).status_code == 400   # answered already


def test_cancel_blocked_and_who_cannot_ask(env, db):
    owner = account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha")
    joao = account(db, m.AccountRole.PHOTOGRAPHER, "João Lima")
    e = event_of(db, owner)
    c_owner, c_joao = login(owner), login(joao)
    url = f"/api/v1/events/{e.id}/collaboration-requests"
    rid = c_joao.post(url, json={"wants_upload": True}).json()["my_request"]["id"]
    assert login(owner).delete(f"{url}/{rid}").status_code == 404        # only who asked cancels
    cancelled = c_joao.delete(f"{url}/{rid}")
    assert cancelled.status_code == 200 and cancelled.json()["my_request"] is None
    assert not [n for n in notices(c_owner) if n["kind"] == "collab_request"]

    # The responsible ended João's access: he does not ask again.
    db.add(m.EventAccessBlock(event_id=e.id, account_id=joao.id, blocked_by=owner.id))
    db.flush()
    db.expire_all()
    assert c_joao.post(url, json={"wants_raw": True}).status_code == 403
    assert c_joao.get(f"/api/v1/events/{e.id}").json()["ask_raw"] is False

    # The responsible and the administrator never ask; nor a hired photographer.
    me = c_owner.get(f"/api/v1/events/{e.id}").json()
    assert me["ask_upload"] is False and me["ask_raw"] is False
    assert c_owner.post(url, json={"wants_raw": True}).status_code == 400


def test_the_administrator_is_told_only_when_the_responsible_is_not_active(env, db):
    admin = account(db, m.AccountRole.ADMIN, "Administração")
    owner = account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha")
    rafael = account(db, m.AccountRole.PHOTOGRAPHER, "Rafael Costa")
    e = event_of(db, owner)
    c_admin = login(admin)
    login(rafael).post(f"/api/v1/events/{e.id}/collaboration-requests", json={"wants_upload": True})
    assert not [n for n in notices(c_admin) if n["kind"] == "collab_request"]
    owner.status = m.AccountStatus.SUSPENDED
    db.flush()
    assert [n for n in notices(c_admin) if n["kind"] == "collab_request"]


def test_old_answered_requests_are_deleted(env, db):
    owner = account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha")
    rafael = account(db, m.AccountRole.PHOTOGRAPHER, "Rafael Costa")
    e = event_of(db, owner)
    old = m.CollaborationRequest(event_id=e.id, requester_id=rafael.id, wants_upload=True, wants_raw=False,
                                 status="declined", decided_at=datetime.now(timezone.utc) - timedelta(days=91))
    recent = m.CollaborationRequest(event_id=e.id, requester_id=rafael.id, wants_upload=True, wants_raw=False,
                                    status="declined", decided_at=datetime.now(timezone.utc) - timedelta(days=10))
    db.add_all([old, recent])
    db.flush()
    assert collaboration.delete_old(db) == 1
    assert db.get(m.CollaborationRequest, recent.id) is not None


def test_the_conversation_is_saved_between_the_two_and_told_on_the_bell(env, db):
    admin = account(db, m.AccountRole.ADMIN, "Administração")
    owner = account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha")
    rafael = account(db, m.AccountRole.PHOTOGRAPHER, "Rafael Costa")
    e = event_of(db, owner)
    c_owner, c_rafael, c_admin = login(owner), login(rafael), login(admin)
    url = f"/api/v1/events/{e.id}/collaboration-requests"
    rid = c_rafael.post(url, json={"wants_upload": True, "message": "Quero enviar 24 imagens."}).json()["my_request"]["id"]
    chat = f"{url}/{rid}/messages"

    assert c_rafael.post(chat, json={"body": "   "}).status_code == 400
    sent = c_rafael.post(chat, json={"body": "Posso mandar ainda hoje?"})
    assert sent.status_code == 201, sent.text
    kinds = [(i["kind"], i["mine"]) for i in sent.json()["items"]]
    assert kinds == [("request", True), ("message", True)]                # the request opens the conversation

    told = [n for n in notices(c_owner) if n["kind"] == "collab_chat"]
    assert len(told) == 1 and told[0]["title"].endswith("mensagem de Rafael")
    assert "Posso mandar ainda hoje?" in told[0]["description"] and f"conversa={rid}" in told[0]["href"]
    assert not [n for n in notices(c_rafael) if n["kind"] == "collab_chat"]   # one's own message is not news
    row = c_owner.get(url).json()[0]
    assert row["messages"] == 1 and row["unread"] is True and row["can_chat"] is True

    # Only the two of them: the administrator (the responsible is active) and anyone else get "does not exist".
    assert c_admin.get(chat).status_code == 404
    assert c_admin.get(url).json()[0]["can_chat"] is False
    assert login(account(db, m.AccountRole.PHOTOGRAPHER, "Rui Costa")).get(chat).status_code == 404

    assert c_owner.post(f"{url}/{rid}/read").status_code == 204
    assert not [n for n in notices(c_owner) if n["kind"] == "collab_chat"]
    c_owner.post(f"{url}/{rid}/decision", json={"accept": True, "reply": "Aceitei."})
    c_owner.post(chat, json={"body": "Pode mandar, sim."})
    items = c_rafael.get(chat).json()["items"]
    assert [i["kind"] for i in items] == ["request", "message", "answer", "message"]
    assert items[2]["note"] == "aceitou o pedido" and items[2]["text"] == "Aceitei." and items[3]["author_name"] == "Bruno Rocha"
    assert [n for n in notices(c_rafael) if n["kind"] == "collab_chat"]
    assert c_rafael.get(f"/api/v1/events/{e.id}").json()["my_request"]["unread"] is True

    # The responsible ends the access: the requester only reads now. The audit keeps the fact, not the text.
    assert c_owner.put(f"/api/v1/events/{e.id}/members/{rafael.id}", json={"allowed": False}).status_code == 200
    closed = c_rafael.get(chat).json()["closed"]
    assert closed and "só para leitura" in closed
    assert c_rafael.post(chat, json={"body": "Por quê?"}).status_code == 400
    logged = db.scalars(select(m.AuditLog).where(m.AuditLog.action == "event.collaboration_message")).all()
    assert len(logged) == 2 and all("Pode mandar" not in str(a.details) for a in logged)

    # The responsible's account stops being active: the administrator takes over, conversation included.
    owner.status = m.AccountStatus.SUSPENDED
    db.flush()
    assert c_admin.get(chat).status_code == 200


def test_a_conversation_keeps_the_request_while_it_goes_on(env, db):
    owner = account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha")
    rafael = account(db, m.AccountRole.PHOTOGRAPHER, "Rafael Costa")
    e = event_of(db, owner)
    long_ago = datetime.now(timezone.utc) - timedelta(days=120)
    talking = m.CollaborationRequest(event_id=e.id, requester_id=rafael.id, wants_upload=True, wants_raw=False,
                                     status="accepted", decided_at=long_ago)
    silent = m.CollaborationRequest(event_id=e.id, requester_id=rafael.id, wants_upload=True, wants_raw=False,
                                    status="declined", decided_at=long_ago)
    db.add_all([talking, silent])
    db.flush()
    db.add_all([m.CollaborationMessage(request_id=talking.id, author_id=rafael.id, body="Antiga", created_at=long_ago),
                m.CollaborationMessage(request_id=talking.id, author_id=owner.id, body="Recente",
                                       created_at=datetime.now(timezone.utc) - timedelta(days=5))])
    db.flush()
    assert collaboration.delete_old(db) == 1                               # the silent one
    assert db.get(m.CollaborationRequest, talking.id) is not None
