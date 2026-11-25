"""E-mail PORT. Same ports & adapters idea as face recognition and storage.

Adapters (chosen by FOTOMAC_EMAIL_SENDER, see factory.py):
- "outbox": development; writes each message to backend/outbox/ so the flows can be tested end to end.
- "smtp": the institution's mail server (smtp_sender.py), always over TLS.
Another kind of server (e.g. a provider's HTTP API) = one more adapter with a send() method, nothing else changes.

Two ways of sending, decided by whether the person NEEDS the message to go on (17/11/2026):
- sender.send(...): the message carries a link the person needs (activation, authorization, e-mail change,
  revocation term). If it fails, EmailDeliveryError goes up and whoever acted is told (HTTP 503), so the
  administrator knows the link did not leave and can send it again. What was saved stays saved.
- notify(sender, ...): the message only informs (removal received or done, expiring event, account situation).
  If it fails, the failure is logged and the operation goes on. A deletion the LGPD requires (removal in 72 h,
  end of retention) must never wait for, or be undone by, a mail server that is down.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from email.message import EmailMessage as MimeMessage
from email.utils import formatdate, make_msgid, parseaddr
from typing import Protocol

log = logging.getLogger("fotomac.email")


@dataclass(frozen=True)
class EmailMessage:
    to: str
    subject: str
    body: str


class EmailSender(Protocol):
    def send(self, message: EmailMessage) -> None: ...


class EmailDeliveryError(Exception):
    """The message did not leave. The text is safe to log: no address, no body, no password."""


def to_mime(message: EmailMessage, sender: str) -> MimeMessage:
    """The message as it goes out, the same for every adapter."""
    mime = MimeMessage()
    mime["From"] = sender
    mime["To"] = message.to
    mime["Subject"] = message.subject
    # Date and Message-ID: mail servers add them when missing, but some count the absence against the message
    # (spam filters); the domain is the sender's own.
    mime["Date"] = formatdate(localtime=True)
    mime["Message-ID"] = make_msgid(domain=parseaddr(sender)[1].rpartition("@")[2] or None)
    # 8bit = plain readable text: whoever opens the message can copy the link as is
    # (the default quoted-printable would turn "token=" into "token=3D").
    mime.set_content(message.body, cte="8bit")
    return mime


def masked(address: str) -> str:
    """Only the domain goes to the log (LGPD, Art. 6º, III): enough to tell an institutional address from an
    external one, never who the person is."""
    return "*@" + address.rpartition("@")[2] if "@" in address else "*"


def notify(sender: EmailSender, message: EmailMessage) -> bool:
    """Sends a message that only informs: a failure is logged and never stops the operation (see the module text)."""
    try:
        sender.send(message)
        return True
    except Exception as exc:   # any adapter, any failure: the caller's operation must go on
        log.warning("informative e-mail not sent (%r to %s): %s", message.subject, masked(message.to),
                    exc if isinstance(exc, EmailDeliveryError) else type(exc).__name__)
        return False
