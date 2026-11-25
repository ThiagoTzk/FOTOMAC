"""Facial recognition in videos (RF035, decision of 04/11/2026): a person found in a published video receives the
whole video, with the watermark. The real YuNet + SFace analyse a real video made by FFmpeg from the public-domain
NASA group photo of the other tests."""
from __future__ import annotations

import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.exc import DBAPIError

from app.db import models as m
from app.events import deletion
from app.indexing.worker import delete_due_removals
from app.main import app
from app.videos import media, recognition
from app.videos import service as videos
from tests.support import jpeg
from tests.test_public import (CREW, consent, engine, env, make_event, person_crop, photographer,  # noqa: F401
                               publish_and_index, search, stranger)

pytestmark = pytest.mark.skipif(not media.available(), reason="needs ffmpeg")


@pytest.fixture(scope="module")
def crew_video(tmp_path_factory) -> Path:
    """4 seconds of the group photo with a tone: the three astronauts on every frame."""
    folder = tmp_path_factory.mktemp("rf035")
    still = folder / "crew.jpg"
    cv2.imwrite(str(still), CREW)
    out = folder / "crew.mp4"
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-loop", "1", "-i", str(still), "-f", "lavfi",
                    "-i", "sine=frequency=440:duration=4", "-t", "4", "-r", "10", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                    "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", str(out)], check=True)
    return out


def published_video(db, storage, engine, path: Path, analyse: bool = True) -> tuple[m.Event, m.Video]:
    owner = photographer(db)
    e = make_event(db, owner)
    video = videos.upload_video(db, storage, owner, e, path)
    assert videos.process_next(db, storage)
    videos.publish(db, storage, owner, e)
    publish_and_index(db, storage, engine, owner, e, [jpeg(4, w=600, h=400)])   # an event is public with its photos
    db.refresh(video)
    assert video.indexing_status == "pending"   # publishing queues the recognition
    if analyse:
        assert recognition.index_next_video(db, storage, engine)
        db.refresh(video)
    return e, video


def vectors(db, video_id) -> int:
    return db.scalar(select(func.count()).select_from(m.VideoFaceEmbedding).where(m.VideoFaceEmbedding.video_id == video_id))


def test_a_published_video_is_analysed_second_by_second(env, db, engine, crew_video):
    storage, _ = env
    e, video = published_video(db, storage, engine, crew_video)
    assert video.indexing_status == "processed" and video.face_seconds == 4
    assert vectors(db, video.id) == 12   # 3 faces x 4 seconds
    assert video.face_people == 3        # 05/11/2026: the three astronauts, not 12 faces
    assert not recognition.index_next_video(db, storage, engine)   # queue empty


def test_the_database_refuses_a_vector_of_an_unpublished_video(env, db, engine, crew_video):
    storage, _ = env
    owner = photographer(db)
    e = make_event(db, owner)
    video = videos.upload_video(db, storage, owner, e, crew_video)
    db.add(m.VideoFaceEmbedding(video_id=video.id, event_id=e.id, model_version="x", dim=3,
                                embedding=np.ones(3, np.float32), second=0.5, detection_score=0.9))
    with pytest.raises(DBAPIError):
        db.flush()
    db.rollback()


def test_the_search_finds_the_person_in_the_video_and_not_a_stranger(env, db, engine, crew_video):
    storage, _ = env
    e, video = published_video(db, storage, engine, crew_video)
    c = TestClient(app)
    consent(c, e)
    found = search(c, e, person_crop()).json()
    assert [v["id"] for v in found["videos"]] == [str(video.id)]
    assert found["videos"][0]["credit"].startswith("Vídeo")
    assert search(c, e, stranger()).json()["videos"] == []


def test_the_video_is_watched_and_downloaded_only_from_this_sessions_result(env, db, engine, crew_video):
    storage, _ = env
    e, video = published_video(db, storage, engine, crew_video)
    other = TestClient(app)
    consent(other, e)
    assert other.get(f"/api/v1/public/videos/{video.id}/play").status_code == 404   # no search, no video
    c = TestClient(app)
    consent(c, e)
    search(c, e, person_crop())
    part = c.get(f"/api/v1/public/videos/{video.id}/play", headers={"Range": "bytes=0-99"})
    assert part.status_code == 206 and len(part.content) == 100
    assert c.get(f"/api/v1/public/videos/{video.id}/thumb").status_code == 200
    assert c.get(f"/api/v1/public/videos/{video.id}/download").status_code == 403   # needs the signed link
    url = c.post(f"/api/v1/public/videos/{video.id}/download-link").json()["url"]
    assert other.get(url).status_code == 404   # the link is bound to the session
    got = c.get(url)
    assert got.status_code == 200 and got.headers["content-type"] == "video/mp4" and len(got.content) > 10_000
    out = Path(storage_tmp := Path(__file__).parent / "_marked.mp4")
    try:
        out.write_bytes(got.content)
        info = media.probe(out)
        assert info.duration > 3   # the WHOLE video
        tags = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format_tags", "-of", "json", str(out)],
                              capture_output=True, text=True).stdout
        assert "CESMAC" in tags   # the ownership notice travels in the file
    finally:
        storage_tmp.unlink(missing_ok=True)
    actions = set(db.scalars(select(m.AuditLog.action).where(m.AuditLog.target_id == str(video.id))))
    assert {"public.video_view", "public.video_download"} <= actions


def test_the_downloaded_video_carries_the_watermark(env, db, engine, crew_video, tmp_path):
    storage, _ = env
    e, video = published_video(db, storage, engine, crew_video)
    c = TestClient(app)
    consent(c, e)
    search(c, e, person_crop())
    marked = tmp_path / "marked.mp4"
    marked.write_bytes(c.get(c.post(f"/api/v1/public/videos/{video.id}/download-link").json()["url"]).content)
    original = tmp_path / "original.mp4"
    original.write_bytes(storage.objects[video.web_key])
    frames = []
    for path in (original, marked):
        png = tmp_path / f"{path.stem}.png"
        subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-ss", "1", "-i", str(path), "-frames:v", "1",
                        str(png)], check=True)
        frames.append(cv2.imread(str(png)).astype(int))
    h, w = frames[0].shape[:2]
    corner = (slice(int(h * 0.85), h), slice(int(w * 0.6), w))   # bottom right, where the mark goes
    assert np.abs(frames[0][corner] - frames[1][corner]).mean() > 3
    assert np.abs(frames[0][: h // 2] - frames[1][: h // 2]).mean() < 3   # the rest of the picture is the same


def test_removal_takes_the_whole_video_out_at_once_and_deletes_it_after_72h(env, db, engine, crew_video):
    storage, outbox = env
    e, video = published_video(db, storage, engine, crew_video)
    c = TestClient(app)
    consent(c, e)
    search(c, e, person_crop())
    r = c.post(f"/api/v1/public/videos/{video.id}/removal", json={"contact_email": "eu@exemplo.com"})
    assert r.status_code == 200
    assert c.get(f"/api/v1/public/videos/{video.id}/play").status_code == 404   # out at once
    assert vectors(db, video.id) == 0
    assert search(c, e, person_crop()).json()["videos"] == []
    assert "FOTOMAC: solicitação de remoção de vídeo" in {msg.subject for msg in outbox.sent}
    keys = video.storage_keys
    video.removal_requested_at = datetime.now(timezone.utc) - timedelta(hours=73)
    db.flush()
    assert delete_due_removals(db, storage, outbox) == 1
    assert db.get(m.Video, video.id) is None and not [k for k in keys if k in storage.objects]
    req = db.scalar(select(m.RemovalRequest).where(m.RemovalRequest.video_id.is_(None), m.RemovalRequest.event_id == e.id))
    assert req.status == m.RemovalStatus.DELETED_AUTOMATICALLY and req.contact_email is None
    assert outbox.sent[-1].subject == "FOTOMAC: vídeo removido"


def test_deleting_the_event_erases_the_video_vectors_at_once(env, db, engine, crew_video):
    storage, _ = env
    e, video = published_video(db, storage, engine, crew_video)
    assert vectors(db, video.id) > 0
    deletion.request_deletion(db, e.owner, e)
    db.refresh(video)
    assert vectors(db, video.id) == 0 and video.indexing_status == "not_queued"


def test_a_short_appearance_is_not_enough(env, db, engine, tmp_path):
    """One second of the person in a long video: one lucky frame is not a match."""
    still, other = tmp_path / "crew.jpg", tmp_path / "empty.jpg"
    cv2.imwrite(str(still), CREW)
    cv2.imwrite(str(other), np.full_like(CREW, 90))
    out = tmp_path / "short.mp4"
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-loop", "1", "-t", "1", "-i", str(still),
                    "-loop", "1", "-t", "5", "-i", str(other), "-filter_complex",
                    "[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1[a];[1:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1[b];"
                    "[a][b]concat=n=2:v=1[v]", "-map", "[v]", "-r", "10", "-pix_fmt", "yuv420p", "-c:v", "libx264", str(out)],
                   check=True)
    storage, _ = env
    e, video = published_video(db, storage, engine, out)
    assert video.face_seconds == 1 and video.face_people == 0   # seen in passing: not counted as a person
    c = TestClient(app)
    consent(c, e)
    assert search(c, e, person_crop()).json()["videos"] == []


def _unit(*values: float) -> np.ndarray:
    v = np.zeros(8, np.float32)
    v[:len(values)] = values
    return v / np.linalg.norm(v)


def test_people_are_counted_through_a_turning_head():
    """05/11/2026, Rafael alone in an 18-second video: he expected "1". A head turning little by little changes the
    vector a lot from the first to the last second, but little from one second to the next: still one person."""
    # The vector turns 0.25 rad a second: neighbours 0.97 alike, the first and the last seconds not alike at all.
    turning = [(float(s), _unit(np.cos(0.25 * s), np.sin(0.25 * s))) for s in range(8)]
    assert float(turning[0][1] @ turning[-1][1]) < 0.37
    assert recognition.count_people(turning, 0.37, 8) == 1
    other = [(float(s), _unit(0.0, 0.0, 1.0)) for s in range(3)]
    assert recognition.count_people(turning + other, 0.37, 8) == 2
    # Two alike faces in ONE frame are two people (twins), never joined.
    assert recognition.count_people([(0.0, _unit(1.0)), (0.0, _unit(1.0, 0.01)), (1.0, _unit(1.0))], 0.37, 2) == 1
    assert recognition.count_people([(0.0, _unit(1.0)), (0.0, _unit(1.0, 0.01)), (1.0, _unit(1.0)), (1.0, _unit(1.0, 0.01))], 0.37, 2) == 2
    assert recognition.count_people([], 0.37, 5) == 0


def test_the_same_video_goes_to_two_events_but_once_to_each(env, db, crew_video):
    """05/11/2026: each event has its own copy; only a second copy in the SAME event is refused."""
    storage, _ = env
    owner = photographer(db)
    first, second = make_event(db, owner, "Colação"), make_event(db, owner, "Outro evento")
    a = videos.upload_video(db, storage, owner, first, crew_video)
    b = videos.upload_video(db, storage, owner, second, crew_video)
    assert a.sha256 == b.sha256 and a.object_key != b.object_key
    with pytest.raises(videos.DuplicateVideo):
        videos.upload_video(db, storage, owner, first, crew_video)


def test_pending_video_work_shows_in_the_overview(env, db, engine, crew_video):
    """05/11/2026: a converted video waiting for "Publicar" and a video removal are pending work, like the photos'."""
    from app.events import notifications
    from app.events import service as events
    storage, _ = env
    owner = photographer(db)
    e = make_event(db, owner)
    video = videos.upload_video(db, storage, owner, e, crew_video)
    assert videos.process_next(db, storage)
    kinds = {n["kind"]: n for n in notifications.for_account(db, owner)}
    assert "videos_ready" in kinds and kinds["videos_ready"]["href"] == f"/eventos/{e.id}/videos"
    assert events.stats_for(db, [e.id])[e.id].videos_ready == 1
    videos.publish(db, storage, owner, e)
    assert "videos_ready" not in {n["kind"] for n in notifications.for_account(db, owner)}
    video.removal_requested_at = datetime.now(timezone.utc)
    db.flush()
    assert "video_removal" in {n["kind"] for n in notifications.for_account(db, owner)}
    assert events.stats_for(db, [e.id])[e.id].removals == 1
    assert events.dashboard(db, owner)["removal_requests"] == 1


def test_the_team_sees_one_face_per_person_cut_now_and_never_stored(env, db, engine, crew_video):
    """05/11/2026: below the player of the panel, a picture of each person found in the video. Only the box is
    kept; the picture is cut from the video when asked, and only whoever manages the video gets it."""
    import base64 as b64
    from tests.test_admin_config import login
    storage, _ = env
    e, video = published_video(db, storage, engine, crew_video)
    stored = set(storage.objects)
    c = login(e.owner)
    r = c.get(f"/api/v1/videos/{video.id}/people")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    faces = r.json()["people"]
    assert len(faces) == video.face_people == 3
    picture = cv2.imdecode(np.frombuffer(b64.b64decode(faces[0]["image"].split(",", 1)[1]), np.uint8), 1)
    assert picture.shape[1] == 160 and len(engine.detect(picture)) == 1   # really a face, one per picture
    assert set(storage.objects) == stored                                 # nothing new kept
    assert db.scalar(select(func.count()).select_from(m.AuditLog).where(m.AuditLog.action == "video.people_viewed")) == 1
    other = photographer(db)
    assert login(other).get(f"/api/v1/videos/{video.id}/people").status_code in (403, 404)
