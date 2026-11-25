"""Everything that touches a video file, through FFmpeg (RF034). This is the only file that calls it.

FFmpeg reads many kinds of input, and some of them make it open other files or addresses. A file sent by a person
is untrusted, so every call here says: only local files, and only the reader chosen from the file's own first bytes,
never from its name. The paths are ours (a temporary folder), never the name the person gave the file.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import BinaryIO

from app.images.processing import FileRejected

FORMATS_TEXT = "MP4, MOV, M4V, 3GP, MKV, WEBM, AVI, WMV, MTS, M2TS, MPG e MXF"
# Boxes a MOV or MP4 can start with. "ftyp" is the usual one; old QuickTime files start with the others.
_FIRST_BOXES = {b"ftyp", b"moov", b"mdat", b"wide", b"free", b"skip"}
_HEAD_BYTES = 400                # enough for three packets of an MPEG-TS, the last signature that needs them
_PROBE_SECONDS = 120
_CLEAN_SECONDS = 900
_SCAN_BYTES = 64 * 1024 * 1024   # the metadata sits at the start of the file after +faststart
_FFMPEG = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
_LONGEST_SIDE = 1920
# Location as written by cameras and phones. Nothing here is read: finding any of them stops the upload.
_LOCATION_TAGS = ("location", "gps", "xyz")
_LONG_MARK, _SHORT_MARK = b"ISO6709", b"\xa9xyz"


@dataclass(frozen=True)
class VideoInfo:
    duration: float
    width: int
    height: int
    video_codec: str
    audio_codec: str | None
    pixel_format: str
    created_at: str | None   # as written in the file, ISO 8601
    video_index: int = 0     # a cover image can come first in the file
    color_primaries: str = ""


class VideoToolMissing(RuntimeError):
    """FFmpeg is not installed on this server."""


def available() -> bool:
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def _run(args: list[str], seconds: int) -> None:
    subprocess.run(args, check=True, capture_output=True, timeout=seconds)


def _reader(head: bytes) -> str | None:
    """Which FFmpeg reader this file needs, by its signature. MPEG-TS has none of its own: it is a mark repeated
    every 188 bytes (cameras add 4 bytes before each packet, in .m2ts and AVCHD .mts)."""
    if len(head) < 12:
        return None
    if head[4:8] in _FIRST_BOXES:
        return "mov"          # MP4, MOV, M4V and 3GP are the same family
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return "matroska"     # MKV and WEBM
    if head[:4] == b"RIFF" and head[8:12] == b"AVI ":
        return "avi"
    if head[:8] == b"\x30\x26\xb2\x75\x8e\x66\xcf\x11":
        return "asf"          # WMV
    if head[:4] == b"\x00\x00\x01\xba":
        return "mpeg"         # MPG and the VOB of a DVD
    if head[:4] == b"\x06\x0e\x2b\x34":
        return "mxf"          # professional cameras
    if len(head) >= _HEAD_BYTES and any(all(head[start + step * n] == 0x47 for n in range(3)) for start, step in ((0, 188), (4, 192))):
        return "mpegts"
    return None


def _head(path: Path) -> bytes:
    with open(path, "rb") as f:
        return f.read(_HEAD_BYTES)


def _read(path: Path) -> list[str]:
    reader = _reader(_head(path))
    if reader is None:
        raise FileRejected("format", f"Este arquivo não é um vídeo aceito. Formatos aceitos: {FORMATS_TEXT}.")
    return ["-protocol_whitelist", "file", "-f", reader]


def format_of(path: Path) -> str:
    """The format to store (RF034): mp4, mov, or mkv for everything else. The name of the file does not count, and
    a camera that writes .MTS gets the same picture and sound in a container this module can vouch for."""
    head = _head(path)
    reader = _reader(head)
    if reader is None:
        raise FileRejected("format", f"Este arquivo não é um vídeo aceito. Formatos aceitos: {FORMATS_TEXT}.")
    if reader != "mov":
        return "mkv"
    return "mp4" if head[4:8] == b"ftyp" and head[8:12] != b"qt  " else "mov"


def _duration(path: Path, data: dict, stream: dict | None) -> float:
    """Screen and browser recordings (WEBM) often end without the total written: the last timestamp gives it."""
    for source in (data.get("format", {}), stream or {}):
        try:
            if (value := float(source["duration"])) > 0:
                return value
        except (KeyError, ValueError):
            pass
    if stream is None:
        return 0.0
    times = subprocess.run(["ffprobe", "-v", "error", *_read(path), "-select_streams", str(stream["index"]), "-show_entries",
                            "packet=pts_time", "-of", "csv=p=0", str(path)], check=True, capture_output=True,
                           timeout=_PROBE_SECONDS, text=True).stdout.split()
    return max((float(t.strip(",")) for t in times if t.strip(",") not in ("", "N/A")), default=0.0)


def probe(path: Path) -> VideoInfo:
    try:
        out = subprocess.run(["ffprobe", "-v", "error", *_read(path), "-print_format", "json", "-show_format", "-show_streams",
                              str(path)], check=True, capture_output=True, timeout=_PROBE_SECONDS).stdout
        data = json.loads(out)
        streams = data.get("streams", [])
        video = next((s for s in streams if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")), None)
        duration = _duration(path, data, video)
    except (subprocess.SubprocessError, json.JSONDecodeError):
        raise FileRejected("corrupted", "O vídeo está corrompido e não pôde ser lido.") from None
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if video is None or duration <= 0:
        raise FileRejected("corrupted", "O arquivo não contém um vídeo que possa ser lido.")
    tags = {k.lower(): v for k, v in data.get("format", {}).get("tags", {}).items()}
    return VideoInfo(duration=duration, width=int(video.get("width", 0)), height=int(video.get("height", 0)),
                     video_codec=str(video.get("codec_name", ""))[:20], audio_codec=str(audio["codec_name"])[:20] if audio else None,
                     pixel_format=str(video.get("pix_fmt", "")),
                     # A file can carry the date twice, and the reader joins both with ";".
                     created_at=(tags.get("creation_time") or "").split(";")[0] or None,
                     video_index=int(video["index"]), color_primaries=str(video.get("color_primaries", "")))


def captured_at(info: VideoInfo) -> datetime | None:
    try:
        return datetime.fromisoformat(info.created_at.replace("Z", "+00:00")) if info.created_at else None
    except ValueError:
        return None


def _mark_in_boxes(f: BinaryIO, size: int) -> bool:
    """The short mark outside the "mdat" box, which holds the picture and the sound: compressed data contains any
    4 bytes by chance, about once in every 65 MB, and a clean video would be refused for it."""
    position = 0
    while position + 8 <= size:
        f.seek(position)
        header = f.read(16)
        length, kind = int.from_bytes(header[:4], "big"), header[4:8]
        if length == 1:
            length = int.from_bytes(header[8:16], "big")
        elif length == 0:
            length = size - position
        if length < 8:
            return False
        if kind != b"mdat":
            f.seek(position)
            if _SHORT_MARK in f.read(min(length, _SCAN_BYTES)):
                return True
        position += length
    return False


def has_location(path: Path) -> bool:
    """Looks at the tags and at the bytes themselves: a box the reader does not list would pass the first check."""
    data = json.loads(subprocess.run(["ffprobe", "-v", "error", *_read(path), "-print_format", "json", "-show_format", "-show_streams",
                                      str(path)], check=True, capture_output=True, timeout=_PROBE_SECONDS).stdout)
    tags = [*data.get("format", {}).get("tags", {})]
    for stream in data.get("streams", []):
        tags += [*stream.get("tags", {})]
    if any(word in tag.lower() for tag in tags for word in _LOCATION_TAGS):
        return True
    with open(path, "rb") as f:
        if _LONG_MARK in f.read(_SCAN_BYTES):
            return True
        return _reader(_head(path)) == "mov" and _mark_in_boxes(f, path.stat().st_size)


def clean(src: Path, folder: Path, info: VideoInfo, artist: str, notice: str, stored_as: str) -> tuple[Path, str]:
    """A copy without location, keeping the image, the sound, the date and the technical data (RF007, note 11).
    Picture and sound are copied, not re-encoded. Other tracks stay out: phones and action cameras can record the
    route in a data track of their own. Runs BEFORE storing, so no file with location ever reaches the storage.

    Not every container takes every codec (a camera's LPCM sound in MP4, for one), so it falls back to MKV, which takes
    nearly all, and last to rewriting only the sound as FLAC, which is lossless. Returns the file and its format."""
    keep = ["-metadata", f"creation_time={info.created_at}"] if info.created_at else []
    attempts = dict.fromkeys(((stored_as, "copy"), ("mkv", "copy"), ("mkv", "flac")))
    failure: subprocess.CalledProcessError | None = None
    for stored, sound in attempts:
        dst = folder / f"clean.{stored}"
        fast_start = ["-movflags", "+faststart"] if stored != "mkv" else []
        times = ["-fflags", "+genpts"] if stored == "mkv" else []   # MPG leaves frames without a time, which MKV requires
        try:
            _run([*_FFMPEG, *times, *_read(src), "-i", str(src), "-map", f"0:{info.video_index}", "-map", "0:a:0?", "-c:v", "copy", "-c:a", sound,
                  "-map_metadata", "-1", "-map_chapters", "-1", *keep, "-metadata", f"artist={artist}", "-metadata", f"copyright={notice}",
                  *fast_start, str(dst)], _CLEAN_SECONDS)
            return dst, stored
        except subprocess.CalledProcessError as exc:
            failure = exc
            dst.unlink(missing_ok=True)
    raise failure


def plays_everywhere(info: VideoInfo, source_format: str) -> bool:
    """Already H.264 with AAC (or silent) in MP4: any browser plays the original, and no second file is needed."""
    return (source_format == "mp4" and info.video_codec == "h264" and info.pixel_format == "yuv420p"
            and info.audio_codec in (None, "aac"))


def _standard_color(info: VideoInfo) -> str:
    """iPhones record HDR by default. Shown as if it were ordinary video, its colors come out washed."""
    return "colorspace=all=bt709:iall=bt2020:format=yuv420p" if info.color_primaries == "bt2020" else "format=yuv420p"


def to_web(src: Path, dst: Path, info: VideoInfo) -> None:
    """H.264 and AAC in MP4, at most 1080p on the longest side, so a video filmed upright counts the same. Two
    threads: the server keeps answering during a conversion. yadif only touches interlaced frames (1080i cameras)."""
    limit = max(1800, min(int(info.duration * 30), 14400))
    size = (f"scale='if(gte(iw,ih),min({_LONGEST_SIDE},iw),-2)':'if(gte(iw,ih),-2,min({_LONGEST_SIDE},ih))':flags=bicubic")
    tags = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"] if info.color_primaries == "bt2020" else []
    _run([*_FFMPEG, *_read(src), "-i", str(src), "-map", f"0:{info.video_index}", "-map", "0:a:0?", "-map_metadata", "-1", "-threads", "2",
          "-vf", f"yadif=deint=interlaced,{size},{_standard_color(info)}", "-c:v", "libx264", "-preset", "veryfast",
          "-crf", "23", *tags, "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(dst)], limit)


def thumbnail(src: Path, dst: Path, info: VideoInfo) -> None:
    """A frame from the first seconds: at 0 s many videos are still black."""
    at = min(1.0, info.duration / 2)
    _run([*_FFMPEG, *_read(src), "-ss", f"{at:.2f}", "-i", str(src), "-map", f"0:{info.video_index}", "-frames:v", "1",
          "-vf", f"scale=640:-2,{_standard_color(info)}", "-q:v", "4",
          "-map_metadata", "-1", str(dst)], _PROBE_SECONDS)


# ------------------------------------------------------------------ facial recognition in videos (RF035)

def sample_frames(src: Path, folder: Path, fps: float) -> list[tuple[float, Path]]:
    """`fps` frames per second of the video, as JPEG files in `folder` (a temporary directory the caller
    deletes), at most 1920 px on the longest side, as the photos are analysed. Returns (second, file)."""
    pattern = folder / "f%06d.jpg"
    size = f"scale='if(gte(iw,ih),min({_LONGEST_SIDE},iw),-2)':'if(gte(iw,ih),-2,min({_LONGEST_SIDE},ih))'"
    _run([*_FFMPEG, "-i", str(src), "-map", "0:v:0", "-vf", f"fps={fps},{size}", "-q:v", "3", "-threads", "2",
          str(pattern)], _CLEAN_SECONDS)
    files = sorted(folder.glob("f*.jpg"))
    return [((n + 0.5) / fps, path) for n, path in enumerate(files)]


def frame_at(src: Path, second: float, dst: Path) -> None:
    """The frame sample_frames() analysed at this second (same 1 per second, same size), so a face box found there
    falls on the same face. Written to `dst`, in a temporary folder the caller deletes."""
    size = f"scale='if(gte(iw,ih),min({_LONGEST_SIDE},iw),-2)':'if(gte(iw,ih),-2,min({_LONGEST_SIDE},ih))'"
    _run([*_FFMPEG, "-ss", f"{int(second)}", "-i", str(src), "-map", "0:v:0", "-vf", f"fps=1,{size}", "-frames:v", "1",
          "-q:v", "3", str(dst)], _PROBE_SECONDS)


def watermarked(src: Path, mark: Path, artist: str, notice: str):
    """The video with the mark of the photos (a transparent PNG of the video's size), re-encoded on the fly:
    the bytes come out while FFmpeg works (fragmented MP4), so the download starts at once and no second copy
    is stored. Yields chunks; FFmpeg is stopped if the person leaves halfway."""
    args = [*_FFMPEG, "-i", str(src), "-i", str(mark), "-filter_complex", "[0:v:0][1:v]overlay=0:0:format=auto,format=yuv420p",
            "-map", "0:a:0?", "-map_metadata", "-1", "-metadata", f"artist={artist}", "-metadata", f"copyright={notice}",
            "-metadata", f"comment={notice}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-threads", "2",
            "-c:a", "copy", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1"]
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        while chunk := proc.stdout.read(256 * 1024):
            yield chunk
        proc.wait(timeout=30)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def frame_size(src: Path, folder: Path) -> tuple[int, int]:
    """Width and height of the frames as FFmpeg delivers them (a phone video filmed upright is turned by its
    rotation tag), so the mark fits the picture the person sees."""
    import cv2
    first = folder / "size.png"
    _run([*_FFMPEG, "-i", str(src), "-map", "0:v:0", "-frames:v", "1", str(first)], _PROBE_SECONDS)
    h, w = cv2.imread(str(first)).shape[:2]
    first.unlink()
    return w, h
