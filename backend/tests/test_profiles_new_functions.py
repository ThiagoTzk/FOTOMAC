"""The functions of 04-05/11/2026 in every profile (05/11/2026: "certifique-se que TODAS as funções estão
funcionando para todas as contas"). He tests as administrator; here each profile goes through the same functions:
blurring faces, the people of a video, and the approval of a hired photographer's video.

Who manages decides: the responsible and the administrator manage everything in the event, a collaborator (photographer or
marketing) only what it sent, marketing outside the event only sees what is published, and the hired photographer never
changes a file (it sends a new one)."""
from __future__ import annotations

import subprocess
from pathlib import Path

import cv2
import pytest
from fastapi.testclient import TestClient

from app.api import public as public_api
from app.db import models as m
from app.db.session import get_session
from app.events import notifications
from app.face.factory import get_face_engine
from app.images import service as images
from app.main import app
from app.notifications.factory import get_email_sender
from app.security.rate_limit import login_limiter, password_link_limiter
from app.storage.factory import get_storage
from app.videos import media, recognition
from app.videos import service as videos
from tests.support import MemoryStorage, jpeg
from tests.test_profiles_v2 import Outbox, account, contractor, event_of, login
from tests.test_public import CREW, GROUP, engine, publish_and_index  # noqa: F401 (engine is a fixture)

BOX = {"boxes": [[0, 0, 40, 40]]}


@pytest.fixture
def env(db, engine):
    storage, outbox = MemoryStorage(), Outbox()
    for limiter in (login_limiter, password_link_limiter, public_api.search_limiter, public_api.download_limiter):
        limiter.reset()
    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[get_storage] = lambda: storage
    app.dependency_overrides[get_email_sender] = lambda: outbox
    app.dependency_overrides[get_face_engine] = lambda: engine
    yield storage, outbox
    app.dependency_overrides.clear()


def copy_of_group(n: int) -> bytes:
    """The group photo with another JPEG quality: another file, so it is not a duplicate in the same event."""
    return cv2.imencode(".jpg", CREW, [cv2.IMWRITE_JPEG_QUALITY, 80 + n])[1].tobytes()


def can_manage_in_list(client: TestClient, event: m.Event, image: m.Image) -> bool:
    """The flag the panel uses to show "Borrar rostos" (canBlur in BlurEditor.tsx)."""
    items = client.get(f"/api/v1/events/{event.id}/images").json()["items"]
    return next(i for i in items if i["id"] == str(image.id))["can_manage"]


def test_blurring_follows_who_manages_the_photo_in_every_profile(env, db):
    storage, _ = env
    owner = account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha")
    admin = account(db, m.AccountRole.ADMIN, "Adm Sistema")
    collab = account(db, m.AccountRole.PHOTOGRAPHER, "Clara Colaboradora")
    mkt = account(db, m.AccountRole.MARKETING, "Bia Marketing")
    mkt_outside = account(db, m.AccountRole.MARKETING, "Rui Marketing")
    stranger = account(db, m.AccountRole.PHOTOGRAPHER, "Outro Fotografo")
    e = event_of(db, owner, collaboration=True)
    by_owner = images.upload_image(db, storage, owner, e, GROUP)
    by_collab = images.upload_image(db, storage, collab, e, copy_of_group(1))
    by_mkt = images.upload_image(db, storage, mkt, e, copy_of_group(2))
    mkt_event = event_of(db, mkt)                       # marketing creates and runs its own events too
    in_mkt_event = images.upload_image(db, storage, mkt, mkt_event, copy_of_group(3))
    a = login(admin)
    hired, h = contractor(db, env, a, e)
    by_hired = images.upload_image(db, storage, hired, e, copy_of_group(4))
    o, c, k, s = login(owner), login(collab), login(mkt), login(stranger)

    def blur(client, image):
        return client.post(f"/api/v1/images/{image.id}/blur", json=BOX).status_code

    # The responsible and the administrator: every photo of the event, the collaborators' too.
    assert blur(o, by_owner) == 200 and blur(o, by_collab) == 200
    assert blur(a, by_mkt) == 200 and blur(a, in_mkt_event) == 200
    # A collaborator, photographer or marketing: its own photos only.
    assert blur(c, by_collab) == 200 and blur(c, by_owner) == 403
    assert can_manage_in_list(c, e, by_collab) and not can_manage_in_list(c, e, by_owner)
    assert blur(k, by_mkt) == 200 and blur(k, by_owner) == 403
    assert blur(k, in_mkt_event) == 200                 # the responsible for its own event
    # The hired photographer: not even its own photo (it sends a new one); the others it does not even see.
    assert blur(h, by_hired) == 403 and blur(h, by_owner) == 404
    assert h.get(f"/api/v1/images/{by_hired.id}/faces").status_code == 403
    # Someone outside the event.
    assert blur(s, by_owner) in (403, 404)
    # Marketing outside the event sees the published photos, and changes none.
    images.publish(db, storage, owner, e)
    outside = login(mkt_outside)
    assert outside.get(f"/api/v1/images/{by_owner.id}").status_code == 200
    assert blur(outside, by_owner) == 403 and not can_manage_in_list(outside, e, by_owner)


@pytest.fixture(scope="module")
def two_videos(tmp_path_factory) -> tuple[Path, Path]:
    """Two different files (3 and 4 seconds) of the group photo: the three astronauts on every frame."""
    folder = tmp_path_factory.mktemp("profiles")
    still = folder / "crew.jpg"
    cv2.imwrite(str(still), CREW)
    out = []
    for seconds in (3, 4):
        path = folder / f"crew{seconds}.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-loop", "1", "-i", str(still), "-t", str(seconds),
                        "-r", "10", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p", "-c:v", "libx264",
                        str(path)], check=True)
        out.append(path)
    return out[0], out[1]


@pytest.mark.skipif(not media.available(), reason="needs ffmpeg")
def test_video_approval_and_the_people_of_a_video_in_every_profile(env, db, engine, two_videos):
    storage, _ = env
    owner = account(db, m.AccountRole.PHOTOGRAPHER, "Bruno Rocha")
    admin = account(db, m.AccountRole.ADMIN, "Adm Sistema")
    collab = account(db, m.AccountRole.PHOTOGRAPHER, "Clara Colaboradora")
    mkt_outside = account(db, m.AccountRole.MARKETING, "Rui Marketing")
    stranger = account(db, m.AccountRole.PHOTOGRAPHER, "Outro Fotografo")
    e = event_of(db, owner, collaboration=True)
    a = login(admin)
    hired, h = contractor(db, env, a, e)
    by_collab = videos.upload_video(db, storage, collab, e, two_videos[0])
    by_hired = videos.upload_video(db, storage, hired, e, two_videos[1])
    while videos.process_next(db, storage):
        pass
    assert by_hired.approval == "pending"

    # 05/11/2026: the hired photographer's video waited and nobody was told. Now the administrator's bell, the event,
    # the overview and the hired photographer's own bell say it.
    notice = next(n for n in notifications.for_account(db, admin) if n["kind"] == "video_approval")
    assert notice["href"] == f"/eventos/{e.id}/videos?filtro=pending_approval" and notice["urgent"]
    assert a.get(f"/api/v1/events/{e.id}").json()["video_approvals_pending"] == 1
    assert a.get("/api/v1/dashboard").json()["approvals_total"] == 1
    assert any(n["kind"] == "own_pending" and "vídeo" in n["title"] for n in notifications.for_account(db, hired))
    assert h.post(f"/api/v1/videos/{by_hired.id}/approval", json={"approve": True}).status_code == 403
    assert login(owner).post(f"/api/v1/videos/{by_hired.id}/approval", json={"approve": True}).status_code == 403
    assert a.post(f"/api/v1/videos/{by_hired.id}/approval", json={"approve": True}).status_code == 200
    assert not [n for n in notifications.for_account(db, admin) if n["kind"] == "video_approval"]
    assert a.get("/api/v1/dashboard").json()["approvals_total"] == 0

    # Publish (only the responsible or the administrator) and let the recognition analyse both videos.
    o, c = login(owner), login(collab)
    assert c.post(f"/api/v1/events/{e.id}/videos/publish").status_code == 403
    assert o.post(f"/api/v1/events/{e.id}/videos/publish").json()["published"] == 2
    publish_and_index(db, storage, engine, owner, e, [jpeg(4, w=600, h=400)])
    while recognition.index_next_video(db, storage, engine):
        pass

    def people(client, video):
        r = client.get(f"/api/v1/videos/{video.id}/people")
        return len(r.json()["people"]) if r.status_code == 200 else r.status_code

    assert people(o, by_collab) == people(o, by_hired) == 3       # the responsible: every video of the event
    assert people(a, by_hired) == 3                               # the administrator too
    assert people(c, by_collab) == 3 and people(c, by_hired) == 403   # a collaborator: its own video
    assert people(h, by_hired) == 3                               # the hired photographer: what it filmed itself
    assert people(login(mkt_outside), by_collab) == 403           # marketing sees the video, not the people in it
    assert people(login(stranger), by_collab) in (403, 404)
