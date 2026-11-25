"""The FIRST administrator of a new installation (24/11/2026).

A fresh installation has no account, and only an administrator opens "Contas" to create the others. This
creates that first administrator WITHOUT a password and returns a single-use first-access link, printed in
the installer's terminal (scripts/create_first_admin.py): no default password ever exists, and the mail
server does not need to be configured yet. The person opens the link and defines their own password.

Refused when any administrator already exists: after the installation, accounts are created in the panel,
where every creation is recorded with who made it.
"""
from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import audit, email_address
from app.accounts.service import INSTITUTIONAL_DOMAIN, _clean_name, is_institutional
from app.auth.service import _issue_link
from app.config import get_settings
from app.db.models import Account, AccountRole, AccountStatus, PasswordTokenPurpose
from app.events.service import EventError

DEFAULT_NAME = "Administrador FOTOMAC"


def create_first_admin(db: Session, email: str, full_name: str = DEFAULT_NAME) -> str:
    """Creates the first administrator (pending, no password) and returns the first-access link."""
    if db.scalar(select(Account.id).where(Account.role == AccountRole.ADMIN).limit(1)):
        raise EventError("Esta instalação já tem administrador: crie as outras contas pelo painel (Contas).")
    email = email.strip()
    if wrong := email_address.problem(email, 100):
        raise EventError(wrong)
    if not is_institutional(email):
        raise EventError(f"Use um e-mail institucional (@{INSTITUTIONAL_DOMAIN}).")
    if db.scalar(select(Account.id).where(func.lower(Account.email) == email.lower())):
        raise EventError("Já existe uma conta com este e-mail.")
    account = Account(full_name=_clean_name(full_name), email=email, role=AccountRole.ADMIN,
                      status=AccountStatus.PENDING)
    db.add(account)
    db.flush()
    audit.record(db, "account.created", None, "account", account.id, role=AccountRole.ADMIN.value, via="install")
    token = _issue_link(db, account, PasswordTokenPurpose.ACTIVATION)
    db.commit()
    return f"{get_settings().frontend_url}/primeiro-acesso?token={token}"
