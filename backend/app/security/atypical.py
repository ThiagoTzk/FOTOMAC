"""Atypical use of the public search (RF024 note 5): signalled to the administrator.

Two signals, as the requirement names them:
- a disproportionate volume of searches from the same address: the search limiter blocked it;
- a sequence of failed liveness checks from the same address: someone trying photos or a screen on the camera.

A failed liveness check comes in two ways (11/11/2026, user test: 5 failures and no alert). The final search can
refuse the movements, but since 04/11 each movement is checked during the capture, and after CAPTURE_TRIES failed
tries in the same step the screen ends the capture: no search is ever sent. That ended capture is the usual failed
liveness check now, so it is counted here too, at the same point and by the same rule the screen uses to give up:
a step that must work (the front and the two turns) failed for any reason, including no face at all (a finger or a
hand over the camera, the author's second test), or up/down did a wrong movement (still, weak, sideways or the other way).

Privacy (LGPD Art. 6, III, necessity): the address is followed ONLY in memory, for the minutes the signal needs, and is
never written anywhere. The alert kept is anonymous: what happened, how many times, in how many minutes and in which
event. The block itself is automatic (the limiter), so the administrator does not need the address to act; the alert
is there to show that it happened and how often. The alert goes to the append-only operations log
("usage.atypical"), so it is also in the operations report (RF024 note 7) and nobody can erase it.

In memory, per process, like the limiter itself (single-server prototype; a shared store with several processes).
"""
from __future__ import annotations

import threading
import time
import uuid

from sqlalchemy.orm import Session

from app import audit

ACTION = "usage.atypical"
# A sequence of this many refused liveness checks from one address, with no successful search in between...
LIVENESS_STREAK = 5
# ...within this time. A real person who fails twice or three times and then gets it right is not atypical.
LIVENESS_MINUTES = 30
# After a "too many searches" alert, the same address does not raise another one for this long (one alert per burst).
QUIET_MINUTES = 10
# Wrong movements in a row in one step that end the guided capture: the same as MAX_TRIES in
# frontend/src/components/capture/GuidedCapture.tsx (change both together).
CAPTURE_TRIES = 3
# Steps that end the capture after CAPTURE_TRIES failures, whatever the reason (GuidedCapture.tsx: frente + REQUIRED).
MUST_PASS = ("frente", "esquerda", "direita")
# Up and down end the capture for a wrong movement, not for a lost face (GuidedCapture.tsx, the 09/11 rule).
ENDS_A_NOD = {"movement", "opposite", "sideways"}
CAPTURE_FAILED = "public.capture_failed"   # anonymous, like "public.search": only the event

_lock = threading.Lock()
_failures: dict[str, list[float]] = {}     # address -> moments of the refused liveness checks in a row
_last_block_alert: dict[str, float] = {}   # address -> moment of its last "too many searches" alert
_wrong_steps: dict[tuple[str, str], tuple[int, float]] = {}   # (address, step) -> wrong movements in a row, last moment


def _record(db: Session, kind: str, event_id: uuid.UUID | None, count: int, minutes: int) -> None:
    audit.record(db, ACTION, None, "event", event_id, kind=kind, count=count, minutes=minutes)
    db.commit()


def searches_blocked(db: Session, address: str, event_id: uuid.UUID | None, limit: int, minutes: int) -> None:
    """The search limiter refused this address: it went past `limit` searches in `minutes` minutes."""
    now = time.monotonic()
    with _lock:
        last = _last_block_alert.get(address)
        if last is not None and now - last < QUIET_MINUTES * 60:
            return
        _last_block_alert[address] = now
        _forget_old(now)
    _record(db, "searches", event_id, limit, minutes)


def liveness_refused(db: Session, address: str, event_id: uuid.UUID | None) -> None:
    now = time.monotonic()
    with _lock:
        streak = [t for t in _failures.get(address, []) if now - t < LIVENESS_MINUTES * 60] + [now]
        reached = len(streak) >= LIVENESS_STREAK
        _failures[address] = [] if reached else streak   # after an alert, the count starts again
        _forget_old(now)
    if reached:
        _record(db, "liveness", event_id, LIVENESS_STREAK, LIVENESS_MINUTES)


def capture_started(address: str) -> None:
    """A new guided capture ("Buscar minhas fotos" or "Tentar de novo"): its steps count from zero."""
    with _lock:
        for key in [k for k in _wrong_steps if k[0] == address]:
            del _wrong_steps[key]


def step_checked(db: Session, address: str, event_id: uuid.UUID, step: str, ok: bool, reason: str | None) -> None:
    """One try of a step checked during the capture, mirroring GuidedCapture.tsx: every failed try of the step counts,
    and at the CAPTURE_TRIES-th the LAST reason decides. A step that must work, or up/down gone the wrong way, ends
    the capture: a failed liveness check, counted (anonymously) and watched like a refused search. Up/down that only
    only without a face go on as a bonus: nothing ended."""
    now = time.monotonic()
    with _lock:
        if ok:
            _wrong_steps.pop((address, step), None)
            return
        count, last = _wrong_steps.get((address, step), (0, now))
        count = 1 if now - last >= LIVENESS_MINUTES * 60 else count + 1
        if count < CAPTURE_TRIES:
            _wrong_steps[(address, step)] = (count, now)
            return
        _wrong_steps.pop((address, step), None)   # the screen leaves this step either way
    if step in MUST_PASS or reason in ENDS_A_NOD:
        audit.record(db, CAPTURE_FAILED, None, "event", event_id, step=step)   # the aggregate count (RF024 note 3)
        db.commit()
        liveness_refused(db, address, event_id)


def search_done(address: str) -> None:
    """A search that passed the liveness check ends the sequence of failures of that address."""
    with _lock:
        _failures.pop(address, None)


def _forget_old(now: float) -> None:
    """Addresses are not kept past the time the signals need (called under the lock)."""
    for address in [a for a, ts in _failures.items() if not ts or now - ts[-1] >= LIVENESS_MINUTES * 60]:
        del _failures[address]
    for address in [a for a, t in _last_block_alert.items() if now - t >= QUIET_MINUTES * 60]:
        del _last_block_alert[address]
    for key in [k for k, (_, t) in _wrong_steps.items() if now - t >= LIVENESS_MINUTES * 60]:
        del _wrong_steps[key]


def reset() -> None:
    with _lock:
        _failures.clear()
        _last_block_alert.clear()
        _wrong_steps.clear()
