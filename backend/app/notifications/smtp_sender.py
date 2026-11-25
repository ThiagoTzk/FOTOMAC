"""Production adapter: the institution's mail server, by SMTP.

Configuration (backend/.env or the server's environment), see the manual, section 3.6:
    FOTOMAC_EMAIL_SENDER=smtp
    FOTOMAC_SMTP_HOST=smtp.exemplo.cesmac.edu.br
    FOTOMAC_SMTP_PORT=587                 # 587 with starttls, 465 with ssl
    FOTOMAC_SMTP_SECURITY=starttls        # or ssl
    FOTOMAC_SMTP_USERNAME=...             # empty when the server accepts the FOTOMAC machine by address (relay)
    FOTOMAC_SMTP_PASSWORD=...
    FOTOMAC_EMAIL_FROM=FOTOMAC <nao-responda@cesmac.edu.br>

Always encrypted, and the server's certificate is checked: the messages carry names and single-use links
(activation, authorization, revocation), which must not travel in clear text (LGPD, Art. 46). There is no
"no encryption" option on purpose. Standard library only (smtplib).
"""
from __future__ import annotations

import smtplib
import ssl

from app.config import Settings, get_settings
from app.notifications.port import EmailDeliveryError, EmailMessage, to_mime

SECURITY = ("starttls", "ssl")


class SmtpEmailSender:
    def __init__(self, settings: Settings | None = None):
        s = settings or get_settings()
        # Checked when the API starts, not at the first e-mail: a wrong configuration shows up at once.
        if not s.smtp_host:
            raise ValueError("FOTOMAC_SMTP_HOST is required when FOTOMAC_EMAIL_SENDER=smtp.")
        if s.smtp_security not in SECURITY:
            raise ValueError(f"FOTOMAC_SMTP_SECURITY must be one of {', '.join(SECURITY)} (never unencrypted).")
        if s.smtp_username and not s.smtp_password:
            raise ValueError("FOTOMAC_SMTP_PASSWORD is required when FOTOMAC_SMTP_USERNAME is set.")
        self.host, self.port, self.security = s.smtp_host, s.smtp_port, s.smtp_security
        self.username = s.smtp_username or None
        self._password = s.smtp_password.get_secret_value() if s.smtp_password else None
        self.timeout = s.smtp_timeout_seconds
        self.sender = s.email_from

    def send(self, message: EmailMessage) -> None:
        mime = to_mime(message, self.sender)
        context = ssl.create_default_context()   # verifies the certificate and the host name
        try:
            if self.security == "ssl":
                smtp = smtplib.SMTP_SSL(self.host, self.port, timeout=self.timeout, context=context)
            else:
                smtp = smtplib.SMTP(self.host, self.port, timeout=self.timeout)
            with smtp:
                if self.security == "starttls":
                    smtp.starttls(context=context)   # raises if the server does not offer encryption
                if self.username:
                    smtp.login(self.username, self._password)
                smtp.send_message(mime)
        except smtplib.SMTPAuthenticationError as exc:
            raise EmailDeliveryError(f"the mail server refused the FOTOMAC login (code {exc.smtp_code})") from None
        except smtplib.SMTPRecipientsRefused:
            raise EmailDeliveryError("the mail server refused the recipient address") from None
        except smtplib.SMTPNotSupportedError:
            raise EmailDeliveryError("the mail server does not offer encryption (STARTTLS)") from None
        except ssl.SSLError as exc:
            raise EmailDeliveryError(f"encryption failed with the mail server ({exc.reason or 'certificate'})") from None
        except (smtplib.SMTPException, OSError) as exc:
            # "from None": the original exception may quote the server's reply, which can echo the address.
            raise EmailDeliveryError(f"the mail server did not accept the message ({type(exc).__name__})") from None
