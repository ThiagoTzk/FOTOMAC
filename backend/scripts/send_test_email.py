"""Sends ONE test message with the e-mail adapter configured in backend/.env, to check the mail server on the day
of the installation (manual, section 3.6). Nothing else in the system changes.

    .venv/bin/python scripts/send_test_email.py --to pessoa@cesmac.edu.br

Prints which adapter and server were used (never the password) and whether the message left. With the "outbox"
adapter the message only becomes a file in backend/outbox/.
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import get_settings  # noqa: E402
from app.email_address import problem  # noqa: E402
from app.notifications.factory import get_email_sender  # noqa: E402
from app.notifications.port import EmailDeliveryError, EmailMessage  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Envia um e-mail de teste com a configuração atual do FOTOMAC.")
    parser.add_argument("--to", required=True, help="endereço que vai receber o teste")
    to = parser.parse_args().to.strip()
    if wrong := problem(to, 120):
        print(f"Endereço inválido: {wrong}")
        return 2
    s = get_settings()
    where = (f"{s.smtp_host}:{s.smtp_port} ({s.smtp_security}"
             + (f", usuário {s.smtp_username}" if s.smtp_username else ", sem usuário: relay") + ")"
             if s.email_sender == "smtp" else "pasta backend/outbox (desenvolvimento)")
    print(f"Adaptador: {s.email_sender} | servidor: {where} | remetente: {s.email_from}")
    try:
        sender = get_email_sender()
        sender.send(EmailMessage(
            to=to, subject="FOTOMAC: e-mail de teste",
            body=(f"Este é um e-mail de teste do FOTOMAC, enviado em {datetime.now():%d/%m/%Y às %H:%M}.\n\n"
                  "Se você recebeu esta mensagem, o envio de e-mails do sistema está funcionando.\n\n"
                  "Equipe FOTOMAC\nCentro Universitário CESMAC")))
    except ValueError as exc:   # configuration (missing server, unencrypted...)
        print(f"Configuração incompleta: {exc}")
        return 1
    except EmailDeliveryError as exc:
        print(f"NÃO ENVIADO: {exc}")
        return 1
    print("Enviado. Confira a caixa de entrada (e a pasta de spam) do destinatário.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
