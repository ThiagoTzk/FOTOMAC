"""Development adapter: each e-mail becomes a .eml file in backend/outbox/.

The folder is git-ignored: the messages contain e-mail addresses (personal data) and
single-use links. Never use this adapter in production.
"""
from __future__ import annotations

from datetime import datetime
from pathlib import Path

from app.config import BACKEND_DIR, get_settings
from app.notifications.port import EmailMessage, to_mime

OUTBOX_DIR = BACKEND_DIR / "outbox"


class OutboxEmailSender:
    def __init__(self, directory: Path = OUTBOX_DIR):
        self.directory = directory

    def send(self, message: EmailMessage) -> Path:
        self.directory.mkdir(exist_ok=True)
        mime = to_mime(message, get_settings().email_from)   # the same message the SMTP adapter sends
        # Local time in the file name: the person looking for the newest e-mail reads their own clock.
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        path = self.directory / f"{stamp}.eml"
        path.write_bytes(bytes(mime))
        path.chmod(0o600)
        return path
