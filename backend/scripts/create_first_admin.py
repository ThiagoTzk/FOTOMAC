"""Creates the FIRST administrator of a new installation and prints its first-access link.

    .venv/bin/python scripts/create_first_admin.py --email administrador@cesmac.edu.br

Optional: --name "Nome Sobrenome" (default "Administrador FOTOMAC"). No password is created or shown: open the
printed link (single use, valid for FOTOMAC_ACTIVATION_LINK_HOURS, 24 h by default) and define it there. Refused
when the installation already has an administrator. See app/accounts/install.py.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy.orm import sessionmaker  # noqa: E402

from app.accounts.install import DEFAULT_NAME, create_first_admin  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.db.session import get_engine  # noqa: E402
from app.events.service import EventError  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description="Cria o primeiro administrador do FOTOMAC e mostra o link de primeiro acesso.")
    p.add_argument("--email", required=True, help="e-mail institucional da conta de administrador")
    p.add_argument("--name", default=DEFAULT_NAME, help=f'nome da conta (padrão: "{DEFAULT_NAME}")')
    args = p.parse_args()
    db = sessionmaker(bind=get_engine())()
    try:
        link = create_first_admin(db, args.email, args.name)
    except EventError as exc:
        print(f"Não criado: {exc}")
        return 1
    finally:
        db.close()
    hours = get_settings().activation_link_hours
    print(f"Administrador criado em 'Acesso Pendente': {args.name.strip()} <{args.email.strip()}>\n")
    print(f"Abra este link no navegador e defina a senha (uso único, válido por {hours} horas):\n\n{link}\n")
    print("Depois, crie as outras contas no painel, em Contas. Não guarde este link: ele dá acesso à conta.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
