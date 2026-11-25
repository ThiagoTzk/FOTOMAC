"""Videos in the collection (RF034): real files, made by FFmpeg, go through the real cleaning and conversion. The
location must leave the original and the copy, the visitor reaches nothing, and a video follows the rules of the
photos: review, approval, publication, retention and removal with every file."""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from sqlalchemy import select

from app import parameters
from app.db import models as m
from app.events import deletion
from app.events.expiry import expire_event
from app.images import service as images
from app.main import app
from app.videos import media
from app.videos import service as videos
from fastapi.testclient import TestClient
from tests.test_profiles_v2 import Outbox
from tests.test_profiles_v2 import account, contractor, env, event_of, login  # noqa: F401 (env is a fixture)

pytestmark = pytest.mark.skipif(not media.available(), reason="needs ffmpeg")
GPS = "+48.8584+002.2945/"
BASE = ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest"]


@pytest.fixture(scope="module")
def files(tmp_path_factory) -> dict[str, Path]:
    folder = tmp_path_factory.mktemp("videos")
    made = {"plain": folder / "plain.mp4", "iphone": folder / "iphone.mov", "gps_mp4": folder / "gps.mp4"}
    subprocess.run([*BASE, "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", str(made["plain"])], check=True)
    # What a phone records: HEVC in MOV, with the location written in the file.
    subprocess.run([*BASE, "-pix_fmt", "yuv420p", "-c:v", "libx265", "-tag:v", "hvc1", "-c:a", "aac", "-metadata", f"location={GPS}",
                    "-metadata", f"com.apple.quicktime.location.ISO6709={GPS}", "-metadata", "creation_time=2026-10-20T15:30:00Z",
                    "-movflags", "use_metadata_tags", str(made["iphone"])], check=True)
    subprocess.run([*BASE, "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-metadata", f"location={GPS}",
                    str(made["gps_mp4"])], check=True)
    return made


def send(client: TestClient, event, path: Path, name: str | None = None):
    return client.post(f"/api/v1/events/{event.id}/videos", files={"file": (name or path.name, path.read_bytes(), "video/mp4")})


def ready(db, storage, video_id: str) -> m.Video:
    assert videos.process_next(db, storage)
    db.expire_all()
    return db.get(m.Video, video_id)


def stored(tmp_path, storage, key: str) -> Path:
    path = tmp_path / key.rsplit("/", 1)[1]
    path.write_bytes(storage.objects[key])
    return path


def test_the_location_of_a_phone_video_never_reaches_the_storage(db, env, files, tmp_path):
    storage, _ = env
    assert media.has_location(files["iphone"])   # the test file really has it
    owner = account(db, m.AccountRole.PHOTOGRAPHER)
    event = event_of(db, owner)
    r = send(login(owner), event, files["iphone"])
    assert r.status_code == 201, r.text
    assert r.json()["processing_status"] == "pending" and r.json()["source_format"] == "mov"
    video = db.get(m.Video, r.json()["id"])
    assert video.captured_at is not None     # date and time stay (RF007, note 11)
    original = stored(tmp_path, storage, video.object_key)
    assert not media.has_location(original)
    assert media.probe(original).video_codec == "hevc"   # copied, not re-encoded

    video = ready(db, storage, video.id)
    assert video.processing_status == m.VideoProcessingStatus.READY
    assert video.web_key != video.object_key and video.web_key.endswith("_web.mp4")
    web = stored(tmp_path, storage, video.web_key)
    assert not media.has_location(web)
    info = media.probe(web)
    assert (info.video_codec, info.audio_codec, info.pixel_format) == ("h264", "aac", "yuv420p")
    assert storage.objects[video.thumb_key][:2] == b"\xff\xd8"


def test_a_video_every_browser_plays_is_not_stored_twice(db, env, files):
    storage, _ = env
    owner = account(db, m.AccountRole.PHOTOGRAPHER)
    video_id = send(login(owner), event_of(db, owner), files["plain"]).json()["id"]
    video = ready(db, storage, video_id)
    assert video.web_key == video.object_key and len(video.storage_keys) == 2


def test_location_in_mp4_is_removed_too(db, env, files, tmp_path):
    storage, _ = env
    owner = account(db, m.AccountRole.PHOTOGRAPHER)
    video_id = send(login(owner), event_of(db, owner), files["gps_mp4"]).json()["id"]
    assert not media.has_location(stored(tmp_path, storage, db.get(m.Video, video_id).object_key))


def test_a_file_is_refused_by_what_it_is(db, env, files, tmp_path):
    owner = account(db, m.AccountRole.PHOTOGRAPHER)
    client, event = login(owner), event_of(db, owner)
    fake = tmp_path / "foto.mp4"
    fake.write_bytes(b"\xff\xd8\xff\xe0" + b"0" * 2000)
    r = send(client, event, fake)
    assert r.status_code == 400 and r.json()["detail"]["reason"] == "format"
    damaged = tmp_path / "quebrado.mp4"
    damaged.write_bytes(files["plain"].read_bytes()[:400])
    assert send(client, event, damaged).json()["detail"]["reason"] == "corrupted"
    assert send(client, event, files["plain"]).status_code == 201
    r = send(client, event, files["plain"])
    assert r.status_code == 409 and r.json()["detail"]["reason"] == "duplicate"


def _sample(folder: Path, name: str, *codecs: str) -> Path:
    path = folder / name
    subprocess.run([*BASE, "-pix_fmt", "yuv420p", *codecs, str(path)], check=True)
    return path


# What cameras, phones and computers really write, with the sound each one uses.
SAMPLES = {
    "camera.mts": (["-c:v", "libx264", "-c:a", "ac3", "-f", "mpegts"], "mkv", "h264"),
    "avchd.m2ts": (["-c:v", "libx264", "-c:a", "pcm_bluray", "-ac", "2", "-mpegts_m2ts_mode", "1", "-f", "mpegts"], "mkv", "h264"),
    "obs.mkv": (["-c:v", "libx264", "-c:a", "aac"], "mkv", "h264"),
    "tela.webm": (["-c:v", "libvpx", "-b:v", "200k", "-c:a", "libopus"], "mkv", "vp8"),
    "antigo.avi": (["-c:v", "mpeg4", "-c:a", "libmp3lame"], "mkv", "mpeg4"),
    "windows.wmv": (["-c:v", "wmv2", "-c:a", "wmav2"], "mkv", "wmv2"),
    "dvd.mpg": (["-c:v", "mpeg2video", "-c:a", "mp2", "-f", "mpeg"], "mkv", "mpeg2video"),
    "profissional.mxf": (["-r", "25", "-c:v", "mpeg2video", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "1"], "mkv", "mpeg2video"),
    "android.3gp": (["-c:v", "libx264", "-c:a", "aac"], "mp4", "h264"),
    "apple.m4v": (["-c:v", "libx264", "-c:a", "aac"], "mp4", "h264"),
}


@pytest.mark.parametrize("name", SAMPLES)
def test_the_formats_people_really_record_are_accepted(db, env, tmp_path, name):
    codecs, stored_as, codec = SAMPLES[name]
    storage, _ = env
    owner = account(db, m.AccountRole.PHOTOGRAPHER)
    r = send(login(owner), event_of(db, owner), _sample(tmp_path, name, *codecs))
    assert r.status_code == 201, r.text
    assert r.json()["source_format"] == stored_as
    video = ready(db, storage, r.json()["id"])
    assert video.processing_status == m.VideoProcessingStatus.READY, video.last_error
    original = stored(tmp_path, storage, video.object_key)
    assert media.probe(original).video_codec == codec and not media.has_location(original)   # picture copied, not re-encoded
    assert media.probe(stored(tmp_path, storage, video.web_key)).video_codec == "h264"


def test_a_file_written_by_apple_software_goes_through(db, env, tmp_path):
    """Written by AVFoundation, the same code an iPhone uses: "qt" brand, HEVC, a mebx data track carrying the
    location, Apple's metadata keys, the index at the end of the file, and a rotation that must survive."""
    storage, _ = env
    source = Path(__file__).parent / "fixtures" / "apple_writer.mov"
    assert media.has_location(source)
    owner = account(db, m.AccountRole.PHOTOGRAPHER)
    r = send(login(owner), event_of(db, owner), source, "IMG_0001.MOV")
    assert r.status_code == 201, r.text
    assert r.json()["source_format"] == "mov" and r.json()["video_codec"] == "hevc"
    video = ready(db, storage, r.json()["id"])
    assert video.processing_status == m.VideoProcessingStatus.READY, video.last_error
    original, web = stored(tmp_path, storage, video.object_key), stored(tmp_path, storage, video.web_key)
    assert not media.has_location(original) and not media.has_location(web)
    assert b"ISO6709" not in original.read_bytes() and b"iPhone" not in original.read_bytes()
    streams = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "csv=p=0", str(web)],
                             check=True, capture_output=True, text=True).stdout
    assert "video,360,640" in streams   # filmed upright, and upright it stays


def test_the_name_of_a_file_does_not_decide(db, env, files):
    owner = account(db, m.AccountRole.PHOTOGRAPHER)
    r = send(login(owner), event_of(db, owner), files["plain"], "IMG_0001.xyz")
    assert r.status_code == 201 and r.json()["source_format"] == "mp4"


def test_a_codec_the_container_refuses_falls_back_without_losing_the_picture(tmp_path):
    """Not every container takes every codec. The file must arrive, not be called corrupted."""
    source = _sample(tmp_path, "windows.wmv", "-c:v", "wmv2", "-c:a", "wmav2")
    cleaned, stored_as = media.clean(source, tmp_path, media.probe(source), "Autor", "Aviso", "mp4")
    assert stored_as == "mkv" and media.probe(cleaned).video_codec == "wmv2" and media.probe(cleaned).audio_codec == "wmav2"


def test_a_recording_without_a_total_time_still_has_a_duration(tmp_path):
    path = tmp_path / "navegador.webm"
    made = subprocess.run([*BASE, "-pix_fmt", "yuv420p", "-c:v", "libvpx", "-b:v", "200k", "-an", "-f", "webm", "-live", "1", "-"],
                          check=True, capture_output=True).stdout
    path.write_bytes(made)
    assert media.probe(path).duration > 1


def test_hdr_from_an_iphone_keeps_its_colors(tmp_path):
    source = tmp_path / "hdr.mov"
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x20A040:size=320x240:duration=1:rate=10,format=yuv420p",
                    "-vf", "colorspace=all=bt2020:iall=bt709:format=yuv420p10", "-c:v", "libx265", "-x265-params", "log-level=error",
                    "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1", "-colorspace", "bt2020nc", "-color_primaries", "bt2020",
                    "-color_trc", "arib-std-b67", "-movflags", "write_colr", str(source)], check=True)
    info = media.probe(source)
    assert info.color_primaries == "bt2020"
    web = tmp_path / "web.mp4"
    media.to_web(source, web, info)
    pixels = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", str(web), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                            check=True, capture_output=True).stdout
    red, green, _ = pixels[3000:3003]
    assert red < 50 and green > 120      # shown as ordinary video it comes out washed: red above 80


def test_a_video_filmed_upright_also_stops_at_1080p(tmp_path):
    base, upright = tmp_path / "base.mp4", tmp_path / "upright.mov"
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=3840x2160:duration=0.2:rate=10,format=yuv420p",
                    "-c:v", "libx264", "-preset", "ultrafast", str(base)], check=True)
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-display_rotation", "90", "-i", str(base), "-c", "copy", "-f", "mov", str(upright)], check=True)
    web = tmp_path / "web.mp4"
    media.to_web(upright, web, media.probe(upright))
    info = media.probe(web)
    assert (info.width, info.height) == (1080, 1920)


def test_the_location_mark_in_the_picture_data_is_not_a_false_alarm(files, tmp_path):
    """Those 4 bytes appear by chance about once in 65 MB of video: a clean file must not be refused for it."""
    data = files["plain"].read_bytes()
    assert not media.has_location(files["plain"])
    inside_picture = bytearray(data)
    start = data.find(b"mdat") + 200
    inside_picture[start:start + 4] = b"\xa9xyz"
    path = tmp_path / "acaso.mp4"
    path.write_bytes(inside_picture)
    assert not media.has_location(path)
    inside_metadata = bytearray(data)
    start = data.find(b"moov") + 40
    inside_metadata[start:start + 4] = b"\xa9xyz"
    path.write_bytes(inside_metadata)
    assert media.has_location(path)


def test_limits_come_from_the_administrator(db, env, files, monkeypatch):
    owner = account(db, m.AccountRole.PHOTOGRAPHER)
    client, event = login(owner), event_of(db, owner)
    assert parameters.get(db, "max_video_mb") == 1024 and parameters.get(db, "max_video_minutes") == 10
    monkeypatch.setattr(parameters, "video_max_seconds", lambda _db: 1)
    assert send(client, event, files["plain"]).json()["detail"]["reason"] == "too_long"
    monkeypatch.setattr(parameters, "video_max_bytes", lambda _db: 1000)
    assert send(client, event, files["plain"]).json()["detail"]["reason"] == "too_large"


def test_the_server_refuses_before_reading_the_body(db, env):
    owner = account(db, m.AccountRole.PHOTOGRAPHER)
    event = event_of(db, owner)
    url = f"/api/v1/events/{event.id}/videos"
    big = {"content-length": str(10 * 1024 ** 3)}
    assert TestClient(app).post(url, headers=big).status_code == 401      # without a session, nothing goes to disk
    assert login(owner).post(url, headers=big).status_code == 413


def test_photos_and_videos_share_the_limit_of_the_event(db, env, files, monkeypatch):
    owner = account(db, m.AccountRole.PHOTOGRAPHER)
    client, event = login(owner), event_of(db, owner)
    assert send(client, event, files["plain"]).status_code == 201
    assert images.media_count(db, event) == 1 and images.capacity_left(db, event) == 999
    monkeypatch.setattr(videos, "MAX_PER_EVENT", 1)
    assert send(client, event, files["gps_mp4"]).json()["detail"]["reason"] == "event_limit"


def test_a_visitor_reaches_no_video(db, env, files):
    storage, _ = env
    owner = account(db, m.AccountRole.PHOTOGRAPHER)
    event = event_of(db, owner, published=True)
    client = login(owner)
    video_id = send(client, event, files["plain"]).json()["id"]
    ready(db, storage, video_id)
    client.post(f"/api/v1/events/{event.id}/videos/publish")
    visitor = TestClient(app)
    for path in (f"/events/{event.id}/videos", f"/videos/{video_id}", f"/videos/{video_id}/thumb", f"/videos/{video_id}/play",
                 f"/videos/{video_id}/download"):
        assert visitor.get(f"/api/v1{path}").status_code == 401, path
    assert "video" not in visitor.get(f"/api/v1/public/events/{event.id}").text.lower().replace("videos_", "")


def test_it_plays_in_parts_and_each_part_checks_the_session(db, env, files):
    storage, _ = env
    owner = account(db, m.AccountRole.PHOTOGRAPHER)
    client = login(owner)
    video_id = send(client, event_of(db, owner), files["plain"]).json()["id"]
    assert client.get(f"/api/v1/videos/{video_id}/play").status_code == 404    # still converting
    video = ready(db, storage, video_id)
    whole = storage.objects[video.web_key]
    r = client.get(f"/api/v1/videos/{video_id}/play", headers={"Range": "bytes=10-19"})
    assert r.status_code == 206 and r.content == whole[10:20]
    assert r.headers["content-range"] == f"bytes 10-19/{len(whole)}" and r.headers["accept-ranges"] == "bytes"
    assert "no-store" in r.headers["cache-control"]
    assert client.get(f"/api/v1/videos/{video_id}/play", headers={"Range": "bytes=-5"}).content == whole[-5:]
    assert client.get(f"/api/v1/videos/{video_id}/play", headers={"Range": f"bytes={len(whole)}-"}).status_code == 416
    assert client.get(f"/api/v1/videos/{video_id}/play").content == whole
    logged = db.scalars(select(m.AuditLog).where(m.AuditLog.action == "video.view", m.AuditLog.target_id == video_id)).all()
    assert len(logged) == 1   # the viewing, not each part


def test_publication_needs_a_converted_video_and_discarding_is_definitive(db, env, files):
    storage, _ = env
    owner = account(db, m.AccountRole.PHOTOGRAPHER)
    client, event = login(owner), event_of(db, owner)
    keep = send(client, event, files["plain"]).json()["id"]
    assert client.post(f"/api/v1/events/{event.id}/videos/publish").status_code == 400   # not converted yet
    drop = send(client, event, files["gps_mp4"]).json()["id"]
    ready(db, storage, keep), ready(db, storage, drop)
    assert client.post(f"/api/v1/videos/{drop}/discard").json()["review_status"] == "discarded"
    assert client.post(f"/api/v1/videos/{drop}/restore").json()["review_status"] == "in_review"
    client.post(f"/api/v1/videos/{drop}/discard")
    dropped_keys = db.get(m.Video, drop).storage_keys
    assert client.post(f"/api/v1/events/{event.id}/videos/publish").json() == {"published": 1, "discarded": 1}
    db.expire_all()
    assert db.get(m.Video, drop) is None and not set(dropped_keys) & set(storage.objects)
    assert db.get(m.Event, event.id).status == m.EventStatus.EDITING    # nothing reached the public site
    assert client.post(f"/api/v1/videos/{keep}/discard").status_code == 400


def test_only_the_manager_publishes_and_the_author_manages_its_own(db, env, files):
    storage, _ = env
    owner, other = account(db, m.AccountRole.PHOTOGRAPHER), account(db, m.AccountRole.PHOTOGRAPHER, "Outro")
    event = event_of(db, owner, collaboration=True)
    collaborator = login(other)
    video_id = send(collaborator, event, files["plain"]).json()["id"]
    ready(db, storage, video_id)
    assert collaborator.post(f"/api/v1/events/{event.id}/videos/publish").status_code == 403
    assert login(owner).post(f"/api/v1/events/{event.id}/videos/publish").json()["published"] == 1
    assert collaborator.delete(f"/api/v1/videos/{video_id}").status_code == 204


def test_marketing_sees_only_the_published_and_downloads_with_a_record(db, env, files):
    storage, _ = env
    owner, marketing = account(db, m.AccountRole.PHOTOGRAPHER), account(db, m.AccountRole.MARKETING, "Bia Marketing")
    client, team = login(owner), login(marketing)
    event = event_of(db, owner, published=True)
    video_id = send(client, event, files["plain"]).json()["id"]
    video = ready(db, storage, video_id)
    assert team.get(f"/api/v1/videos/{video_id}").status_code == 404      # under review
    assert team.get(f"/api/v1/events/{event.id}/videos").json()["items"] == []
    client.post(f"/api/v1/events/{event.id}/videos/publish")
    link = team.post(f"/api/v1/videos/{video_id}/download-link").json()["url"]
    file = team.get(link)
    assert file.status_code == 200 and file.content == storage.objects[video.object_key]
    assert team.get(f"/api/v1/videos/{video_id}/download?t=errado").status_code == 403
    assert db.scalar(select(m.AuditLog).where(m.AuditLog.action == "video.download", m.AuditLog.actor_account_id == marketing.id))


def test_marketing_reaches_an_event_that_has_only_videos(db, env, files):
    """Publishing a video does not put the event on the site, and the event must not stay out of marketing's reach."""
    storage, _ = env
    owner, marketing = account(db, m.AccountRole.PHOTOGRAPHER), account(db, m.AccountRole.MARKETING, "Bia Marketing")
    client, team = login(owner), login(marketing)
    event = event_of(db, owner)
    video_id = send(client, event, files["plain"]).json()["id"]
    ready(db, storage, video_id)
    assert team.get(f"/api/v1/events/{event.id}/videos").status_code == 404
    client.post(f"/api/v1/events/{event.id}/videos/publish")
    assert [v["id"] for v in team.get(f"/api/v1/events/{event.id}/videos").json()["items"]] == [video_id]
    assert TestClient(app).get(f"/api/v1/public/events/{event.id}").status_code == 404   # still not on the site


def test_a_hired_photographer_waits_for_the_administrator(db, env, files):
    storage, _ = env
    admin = login(account(db, m.AccountRole.ADMIN))
    owner = account(db, m.AccountRole.PHOTOGRAPHER)
    event = event_of(db, owner)
    hired, client = contractor(db, env, admin, event)
    video_id = send(client, event, files["plain"]).json()["id"]
    video = ready(db, storage, video_id)
    assert video.approval == "pending"
    manager = login(owner)
    assert manager.post(f"/api/v1/events/{event.id}/videos/publish").status_code == 400
    assert manager.post(f"/api/v1/videos/{video_id}/approval", json={"approve": True}).status_code == 403
    assert admin.post(f"/api/v1/videos/{video_id}/approval", json={"approve": False, "reason": "x"}).status_code == 400
    assert admin.post(f"/api/v1/videos/{video_id}/approval", json={"approve": True}).json()["approval"] == "approved"
    assert manager.post(f"/api/v1/events/{event.id}/videos/publish").json()["published"] == 1


def test_a_failed_conversion_stops_and_can_be_tried_again(db, env, files, monkeypatch):
    storage, _ = env
    owner = account(db, m.AccountRole.PHOTOGRAPHER)
    client = login(owner)
    video_id = send(client, event_of(db, owner), files["plain"]).json()["id"]
    monkeypatch.setattr(media, "thumbnail", lambda *_: (_ for _ in ()).throw(OSError("disk")))
    for _ in range(videos.MAX_ATTEMPTS):
        db.query(m.Video).filter(m.Video.id == video_id).update({m.Video.next_attempt_at: None})
        videos.process_next(db, storage)
        db.expire_all()
    video = db.get(m.Video, video_id)
    assert video.processing_status == m.VideoProcessingStatus.FAILED and video.last_error == "OSError"
    assert "Tentar de novo" in client.get(f"/api/v1/videos/{video_id}").json()["failure"]
    monkeypatch.undo()
    assert client.post(f"/api/v1/videos/{video_id}/retry").json()["processing_status"] == "pending"
    assert ready(db, storage, video_id).processing_status == m.VideoProcessingStatus.READY


def test_retention_and_removal_take_every_file(db, env, files):
    storage, _ = env
    owner = account(db, m.AccountRole.PHOTOGRAPHER)
    client, event = login(owner), event_of(db, owner, published=True)
    gone = ready(db, storage, send(client, event, files["iphone"]).json()["id"])
    keys = gone.storage_keys
    assert len(keys) == 3 and set(keys) <= set(storage.objects)
    assert client.delete(f"/api/v1/videos/{gone.id}").status_code == 204
    assert not set(keys) & set(storage.objects)

    kept = ready(db, storage, send(client, event, files["iphone"]).json()["id"])
    client.post(f"/api/v1/events/{event.id}/videos/publish")
    deletion.request_deletion(db, owner, event)
    db.expire_all()
    assert db.get(m.Video, kept.id).review_status == m.ImageReviewStatus.IN_REVIEW  # out at once, can be undone
    keys = kept.storage_keys
    expire_event(db, storage, Outbox(), event)
    db.expire_all()
    assert db.get(m.Video, kept.id) is None and not set(keys) & set(storage.objects)


def test_a_rejected_video_is_eliminated_with_its_files(db, env, files):
    from datetime import datetime, timedelta, timezone
    storage, _ = env
    owner = account(db, m.AccountRole.PHOTOGRAPHER)
    video = ready(db, storage, send(login(owner), event_of(db, owner), files["plain"]).json()["id"])
    video.approval, video.rejected_at = "rejected", datetime.now(timezone.utc) - timedelta(days=8)
    keys = video.storage_keys
    db.commit()
    assert videos.eliminate_rejected(db, storage) == 1
    assert not set(keys) & set(storage.objects)
