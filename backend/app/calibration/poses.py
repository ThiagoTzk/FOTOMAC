"""Picks, from many frames of a short video (or several photos), at most 5 — one per pose: front,
both sides, up, down.

Why not every frame: 3 seconds are ~90 nearly identical frames. Comparing each photo with all of
them and keeping the best multiplies the chances of a stranger matching ONE frame by luck; and
keeping them would be more biometric data than needed (LGPD Art. 6, III). One sharp frame per pose
gives the angles a single selfie lacks.

The pose comes from the 5 points the detector already returns (eyes, nose tip, mouth corners),
read through the face port — no model is touched here:
- turn (yaw): how far the nose is from the middle of the eyes, in eye-distances, compared with the frontal frame;
- tilt (pitch): where the nose sits between the eyes and the mouth (0 = at the eyes, 1 = at the mouth),
  compared with the frontal frame.
"""
from __future__ import annotations

import statistics
from dataclasses import dataclass

import cv2
import numpy as np

from app.face.port import DetectedFace, FaceEngine

MIN_SCORE = 0.6     # a frame whose face the detector doubts is not a reference
# Both measured RELATIVE to the person's own frontal frame: nobody's "front" is exactly 0 for every
# camera. A still video (16/10/2026) wobbled by ±0.04 in turn and ±0.035 in tilt; a real head turn of
# ~30° gives ~0.3. The limits sit well above that noise, so a still face never counts as a pose.
TURN = 0.20         # minimum turn to count as a side pose (eye-distances)
TILT = 0.08         # minimum tilt to count as up / down


@dataclass(frozen=True)
class Frame:
    index: int
    yaw: float
    pitch: float
    sharpness: float
    score: float


def describe(engine: FaceEngine, index: int, image: np.ndarray) -> Frame | None:
    """The pose of the largest face of one frame, or None (no face, or no landmarks)."""
    return frame_from_faces(index, image, engine.detect(image))


def frame_from_faces(index: int, image: np.ndarray, detected: list[DetectedFace]) -> Frame | None:
    """Same as describe(), for faces already detected (the public search detects each frame once
    and reuses the faces for the query)."""
    faces = [f for f in detected if f.landmarks]
    if not faces:
        return None
    face = max(faces, key=lambda f: f.bbox.area)
    (rex, rey), (lex, ley), (nx, ny), (rmx, rmy), (lmx, lmy) = face.landmarks
    eye_x, eye_y = (rex + lex) / 2, (rey + ley) / 2
    mouth_y = (rmy + lmy) / 2
    eyes = float(np.hypot(lex - rex, ley - rey)) or 1.0
    b = face.bbox
    crop = cv2.cvtColor(image[b.y:b.y + b.height, b.x:b.x + b.width], cv2.COLOR_BGR2GRAY) if b.width and b.height else None
    # Sharpness: variance of the Laplacian on the face, at a fixed size (a blurred frame scores low).
    sharp = float(cv2.Laplacian(cv2.resize(crop, (112, 112)), cv2.CV_64F).var()) if crop is not None and crop.size else 0.0
    return Frame(index=index, yaw=(nx - eye_x) / eyes, pitch=(ny - eye_y) / ((mouth_y - eye_y) or 1.0),
                 sharpness=sharp, score=face.detection_score)


def select(frames: list[Frame | None]) -> list[tuple[int, str]]:
    """[(frame index, pose label)], the frontal frame first. Empty when no frame has a usable face."""
    valid = [f for f in frames if f is not None and f.score >= MIN_SCORE]
    if not valid:
        return []
    floor = 0.5 * statistics.median(f.sharpness for f in valid)  # drop the blurred ones (moving head)
    valid = [f for f in valid if f.sharpness >= floor] or valid
    # The guided video starts and ends facing the camera: the median pose is the person's "front".
    yaw0, pitch0 = statistics.median(f.yaw for f in valid), statistics.median(f.pitch for f in valid)
    front = min(valid, key=lambda f: abs(f.yaw - yaw0) + abs(f.pitch - pitch0))
    chosen = [(front.index, "frente")]
    candidates = [
        ("lado 1", min(valid, key=lambda f: f.yaw), lambda f: f.yaw - front.yaw < -TURN),
        ("lado 2", max(valid, key=lambda f: f.yaw), lambda f: f.yaw - front.yaw > TURN),
        ("cima", min(valid, key=lambda f: f.pitch - front.pitch), lambda f: f.pitch - front.pitch < -TILT),
        ("baixo", max(valid, key=lambda f: f.pitch - front.pitch), lambda f: f.pitch - front.pitch > TILT),
    ]
    for label, frame, enough in candidates:
        if enough(frame) and frame.index not in {i for i, _ in chosen}:
            chosen.append((frame.index, label))
    return chosen


# ------------------------------------------------------------------ guided recording (liveness)

STEPS = ("frente", "esquerda", "direita", "cima", "baixo")
# The steps that DECIDE the liveness check. Measured with real faces (17/10/2026, 3 captures): a turn
# gives 0.25-0.46 against a still-camera noise of ±0.04 — a clear signal; a nod gives only 0.03-0.10,
# the same size as the noise (the 5 landmarks barely move when the head tilts). Up/down are still asked
# and kept as poses when they show, but they never fail a real person. The order of the 4 movements is
# drawn per capture, so a recording made before still cannot know WHEN to turn to each side.
REQUIRED = ("esquerda", "direita")
# Up and down, the OPPOSITE way (08/11/2026: "forcei errar e passou"; option B, his choice). A nod in the right
# direction is too weak to demand, but a nod CLEARLY the other way is refused: looking up when "baixo" is asked. Measured
# on the 16 real nods in the server logs (17/10 to 08/11/2026): a nod the right way never went more than 0.045 the
# other way (the noise of a still face is about 0.035); the one that went 0.077 the other way had barely 0.011 the
# right way. Refused only when the other way reaches OPPOSITE AND is more than twice the move the right way, so a
# person who did nod right, even weakly, is never refused for a wobble.
OPPOSITE = 0.06
# Up and down, turned SIDEWAYS instead (09/11/2026: "baixo" was asked, he looked left and it passed). The tilt
# alone does not see a turn: a look to the left measured -0.007 of tilt, as still as a face that did not move. A turn
# as big as one that counts for "esquerda"/"direita" (TURN) during a nod step is refused, with the same care as above:
# only when it is more than twice the nod the right way. Staying still still passes (the 05/11 decision).
SIDEWAYS = TURN
# Up and down on the screen, the RIGHT way at least a little (09/11/2026: a weak look down passed when "cima" was
# asked; for him standing still must fail too). A nod must reach NOD_MIN the right way in the step check: half of his
# smallest right nod that day (0.043), and below every real nod measured since 17/10 (0.03 to 0.16). Far below TILT, so
# the 05/11 problem (real nods failing 0.08) does not come back. Used by the step check (public.service.check_step).
# 11/11/2026: changes to up and down were tried (go on after the tries, a higher minimum, a fresh centre) and
# The author chose to keep this 09/11 rule: a nod too subtle is "Movimento errado", and the person makes a bigger one.
NOD_MIN = 0.02


def _movement(step: str, frame: Frame, front: Frame) -> float:
    """How far the head went in the asked direction (positive = the right way). Frames are the
    camera's real image (not the mirrored preview): turning to the person's LEFT moves the nose to
    the image's right (yaw grows); looking UP brings the nose closer to the eyes (pitch shrinks)."""
    return {"esquerda": frame.yaw - front.yaw, "direita": front.yaw - frame.yaw,
            "cima": front.pitch - frame.pitch, "baixo": frame.pitch - front.pitch}[step]


def select_guided(frames: list[Frame | None], steps: list[str]) -> tuple[list[tuple[int, str]], dict]:
    """For a guided recording, where each frame carries the movement asked at that moment: one
    frame per pose (the most pronounced of its step) and the liveness check — did the head go the
    way it was asked, in the order asked? A photo held to the camera cannot turn in 3D, and a video
    recorded before does not follow an order drawn at random for this recording."""
    by_step: dict[str, list[Frame]] = {}
    for frame, step in zip(frames, steps):
        if frame is not None and frame.score >= MIN_SCORE:
            by_step.setdefault(step, []).append(frame)
    fronts = by_step.get("frente") or []
    if not fronts:
        return [], {"passed": False, "steps": [], "reason": "nenhum rosto de frente"}
    yaw0, pitch0 = statistics.median(f.yaw for f in fronts), statistics.median(f.pitch for f in fronts)
    front = min(fronts, key=lambda f: abs(f.yaw - yaw0) + abs(f.pitch - pitch0))
    chosen, report = [(front.index, "frente")], []
    order = [s for i, s in enumerate(steps) if s != "frente" and (i == 0 or steps[i - 1] != s)]
    for step in order:
        candidates = by_step.get(step) or []
        best = max(candidates, key=lambda f: _movement(step, f, front), default=None)
        moved = _movement(step, best, front) if best else None
        # The most pronounced move the OTHER way, only for the "inverted" diagnostic below.
        against = min((_movement(step, f, front) for f in candidates), default=None)
        limit = TURN if step in ("esquerda", "direita") else TILT
        nod = step not in REQUIRED
        # A side turn the WRONG way (11/11/2026: asked "direita", he looked left and it passed: 0.261 the right
        # way in one frame, 0.783 the other way). The turn counts only when the head went further the asked way than
        # the other way; a wrong turn as big as a real one refuses the step.
        wrong_turn = not nod and against is not None and -against >= TURN and -against > (moved or 0.0)
        ok = moved is not None and moved > limit and not wrong_turn
        opposite = wrong_turn or (nod and against is not None and -against >= OPPOSITE
                                  and -against > 2 * max(moved or 0.0, 0.0))
        # How far the head turned to a side during a nod step (any side), compared with the frontal frame.
        turned = max((abs(f.yaw - front.yaw) for f in candidates), default=None) if nod else None
        sideways = turned is not None and turned >= SIDEWAYS and turned > 2 * max(moved or 0.0, 0.0)
        report.append({"step": step, "movement": round(moved, 3) if moved is not None else None,
                       "against": round(against, 3) if against is not None else None, "limit": limit, "ok": ok,
                       "required": step in REQUIRED, "opposite": opposite,
                       "turned": round(turned, 3) if turned is not None else None, "sideways": sideways})
        if ok:
            chosen.append((best.index, step))
    required = [r for r in report if r["required"]]
    # Diagnostic: every required move clear but in the opposite direction = a sign convention to fix, not a fake.
    inverted = bool(required) and all(r["against"] is not None and -r["against"] > r["limit"] for r in required)
    passed = {r["step"] for r in required} == set(REQUIRED) and all(r["ok"] for r in required) \
        and not any(r["opposite"] or r["sideways"] for r in report)
    return chosen, {"passed": passed, "order": order, "steps": report, "inverted": inverted}
