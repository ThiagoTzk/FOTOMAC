"""Accounts managed by the administrator.

There is NO self-registration anywhere: accounts exist only because an
administrator created them here. The account is born without a password; the holder defines
it through a single-use link. Accounts are never deleted.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app import audit, email_address, parameters
from app.accounts import identity
from app.auth import service as auth
from app.auth.service import _revoke_all_sessions
from app.db.models import (AUTHOR_ROLES, Account, AccountRole, AccountStatus, Event, EventStatus, Image, PasswordToken,
                           PasswordTokenPurpose)
from app.events.service import EventError, NotFound, PermissionDenied
from app.notifications.port import EmailMessage, EmailSender, notify

ROLE_LABEL = {AccountRole.ADMIN: "Administrador", AccountRole.PHOTOGRAPHER: "Fotógrafo",
              AccountRole.MARKETING: "Marketing", AccountRole.CONTRACTOR: "Fotógrafo contratado"}
STATUS_LABEL = {AccountStatus.PENDING: "Acesso Pendente", AccountStatus.ACTIVE: "Ativa",
                AccountStatus.INACTIVE: "Inativa", AccountStatus.SUSPENDED: "Suspensa",
                AccountStatus.EXPIRED: "Expirada"}
CONTRACTOR_HOURS = 24  # default period, from the moment the password is defined
MAX_CONTRACT_HOURS = 720  # 30 days
INSTITUTIONAL_DOMAIN = "cesmac.edu.br"


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class AccountInput:
    full_name: str
    email: str
    role: AccountRole
    photographer_signature: str | None
    bound_event_id: uuid.UUID | None = None   # temporary account only
    contract_number: str | None = None
    contract_hours: int | None = None


def _clean_name(name: str) -> str:
    name = " ".join(name.split())
    if len(name.split()) < 2:
        raise EventError("Informe o nome completo (nome e sobrenome).")
    if len(name) > 120:
        raise EventError("O nome completo pode ter até 120 caracteres.")
    return name


def is_institutional(email: str) -> bool:
    """cesmac.edu.br or one of its subdomains (e.g. academico.cesmac.edu.br)."""
    domain = email.rsplit("@", 1)[-1].lower()
    return domain == INSTITUTIONAL_DOMAIN or domain.endswith("." + INSTITUTIONAL_DOMAIN)


def _clean_hours(hours: int | None) -> int:
    if hours is None:
        return CONTRACTOR_HOURS
    if not 1 <= hours <= MAX_CONTRACT_HOURS:
        raise EventError(f"O prazo da conta temporária vai de 1 hora a {MAX_CONTRACT_HOURS // 24} dias.")
    return hours


def _coverage(db: Session, event_id: uuid.UUID | None, contract_number: str | None) -> tuple[Event, str]:
    event = db.get(Event, event_id) if event_id else None
    if event is None or event.status == EventStatus.EXPIRED:
        raise EventError("Escolha o evento para o qual o fotógrafo foi contratado.")
    contract = " ".join((contract_number or "").split())
    if not 1 <= len(contract) <= 60:
        raise EventError("Informe o número do contrato de prestação de serviço (até 60 caracteres).")
    return event, contract


def _clean_signature(role: AccountRole, signature: str | None) -> str | None:
    signature = " ".join((signature or "").split()) or None
    if role in AUTHOR_ROLES and not signature:
        raise EventError("A assinatura é obrigatória para quem envia fotos (é o crédito nas fotos).")
    if signature and len(signature) > 80:
        raise EventError("A assinatura pode ter até 80 caracteres.")
    return signature


# ------------------------------------------------------------------ list / read

def list_accounts(db: Session, q: str | None, role: AccountRole | None, status: AccountStatus | None):
    query = select(Account)
    if q and q.strip():
        term = f"%{q.strip().lower()}%"
        query = query.where(or_(func.lower(Account.full_name).like(term), func.lower(Account.email).like(term)))
    if role:
        query = query.where(Account.role == role)
    if status:
        query = query.where(Account.status == status)
    # Pending accounts come first, highlighted.
    pending_first = (Account.status != AccountStatus.PENDING)
    items = db.scalars(query.order_by(pending_first, func.lower(Account.full_name))).all()
    counts = dict(db.execute(select(Account.status, func.count()).group_by(Account.status)).all())
    return items, {s.value: counts.get(s, 0) for s in AccountStatus}


def get_account(db: Session, account_id: uuid.UUID) -> Account:
    account = db.get(Account, account_id)
    if account is None:
        raise NotFound("Conta não encontrada.")
    return account


def activation_link_state(db: Session, account: Account) -> str | None:
    """For a pending account: "valid" (a link is waiting) or "expired" (must be re-sent)."""
    if account.status != AccountStatus.PENDING:
        return None
    alive = db.scalar(select(func.count()).select_from(PasswordToken).where(
        PasswordToken.account_id == account.id, PasswordToken.purpose == PasswordTokenPurpose.ACTIVATION,
        PasswordToken.used_at.is_(None), PasswordToken.expires_at > _now()))
    return "valid" if alive else "expired"


def owned_events(db: Session, account: Account) -> int:
    return db.scalar(select(func.count()).select_from(Event).where(Event.owner_id == account.id)) or 0


def is_locked(account: Account) -> bool:
    return account.locked_until is not None and account.locked_until > _now()


# ------------------------------------------------------------------ create

def create_account(db: Session, admin: Account, sender: EmailSender, data: AccountInput) -> Account:
    name = _clean_name(data.full_name)
    email = data.email.strip()
    if wrong := email_address.problem(email, 100):
        raise EventError(wrong)
    # Whoever works for the CESMAC has an institutional e-mail; only the hired photographer, who does
    # not, may use a personal one.
    if data.role != AccountRole.CONTRACTOR and not is_institutional(email):
        raise EventError(f"Use o e-mail institucional (@{INSTITUTIONAL_DOMAIN}). E-mail pessoal só para fotógrafo contratado.")
    if db.scalar(select(Account.id).where(func.lower(Account.email) == email.lower())):
        raise EventError("Já existe uma conta com este e-mail.")
    account = Account(full_name=name, email=email, role=data.role,
                      photographer_signature=_clean_signature(data.role, data.photographer_signature),
                      status=AccountStatus.PENDING)  # no password
    if data.role == AccountRole.CONTRACTOR:  # one event, one contract
        identity._key()  # refuse early if the server cannot encrypt the identification later
        event, contract = _coverage(db, data.bound_event_id, data.contract_number)
        account.bound_event_id, account.contract_number = event.id, contract
        account.contract_hours = _clean_hours(data.contract_hours)
    db.add(account)
    db.flush()
    audit.record(db, "account.created", admin.id, "account", account.id, role=data.role.value,
                 **({"event_id": str(account.bound_event_id)} if account.bound_event_id else {}))
    auth.send_activation_link(db, account, sender)  # commits
    return account


def resend_activation(db: Session, admin: Account, sender: EmailSender, account: Account) -> None:
    """A new single-use link; the previous one stops working."""
    if account.status != AccountStatus.PENDING:
        raise EventError("Só contas em “Acesso Pendente” recebem o link de definição de senha.")
    audit.record(db, "account.activation_resent", admin.id, "account", account.id)
    auth.send_activation_link(db, account, sender)


# TEMPORÁRIO — REMOVER ANTES DA IMPLANTAÇÃO (demonstração enquanto não há envio real de e-mail).
# Shows the activation link to the administrator instead of e-mailing it. In production that would
# let any administrator take over any pending account, which is exactly what the single-use link forbids
# (the link goes ONLY to the holder's e-mail). So it exists only while e-mails are not really sent
# (email_sender == "outbox", development); on the CESMAC server it answers "not found".
def dev_mode_link_available() -> bool:
    from app.config import get_settings
    return get_settings().email_sender == "outbox"


def dev_activation_link(db: Session, admin: Account, account: Account) -> str:
    from app.config import get_settings
    if not dev_mode_link_available():
        raise NotFound("Recurso indisponível.")
    if account.status != AccountStatus.PENDING:
        raise EventError("Só contas em “Acesso Pendente” têm link de definição de senha.")
    token = auth._issue_link(db, account, PasswordTokenPurpose.ACTIVATION)  # the previous link stops working
    audit.record(db, "account.activation_link_shown_dev", admin.id, "account", account.id)
    db.commit()
    return f"{get_settings().frontend_url}/primeiro-acesso?token={token}"
# FIM DO TRECHO TEMPORÁRIO


# ------------------------------------------------------------------ edit (name, role, signature)

def _active_admins(db: Session) -> int:
    return db.scalar(select(func.count()).select_from(Account).where(
        Account.role == AccountRole.ADMIN, Account.status == AccountStatus.ACTIVE)) or 0


def update_account(db: Session, admin: Account, account: Account, full_name: str, role: AccountRole,
                   signature: str | None) -> Account:
    if role != account.role:
        if account.id == admin.id:
            raise PermissionDenied("Você não pode alterar o seu próprio perfil.")
        if AccountRole.CONTRACTOR in (role, account.role):
            raise EventError("A conta de fotógrafo contratado não pode ser convertida em outro perfil, nem o contrário.")
        if account.role == AccountRole.ADMIN and account.status == AccountStatus.ACTIVE and _active_admins(db) <= 1:
            raise EventError("Esta é a única conta de administrador ativa; o sistema ficaria sem administrador.")
    changes = {}
    name = _clean_name(full_name)
    signature = _clean_signature(role, signature)
    if name != account.full_name:
        changes["name"] = True
    if signature != account.photographer_signature:
        changes["signature"] = True
    if role != account.role:
        # A role change is the administrator's prerogative and is logged.
        changes["role"] = f"{account.role.value}->{role.value}"
    account.full_name, account.role, account.photographer_signature = name, role, signature
    if changes:
        audit.record(db, "account.updated", admin.id, "account", account.id, **changes)
    db.commit()
    return account


# ------------------------------------------------------------------ status

def change_status(db: Session, admin: Account, sender: EmailSender, account: Account,
                  target: AccountStatus) -> Account:
    """Ativa / Inativa / Suspensa, decided by the administrator. The screen asks for an
    explicit confirmation first; the change is logged and e-mailed to the holder.
    Events and photos of the account stay in the collection with their credit."""
    if account.id == admin.id:
        raise PermissionDenied("Você não pode alterar a situação da sua própria conta.")
    if target in (AccountStatus.PENDING, AccountStatus.EXPIRED):
        raise EventError("Essa situação é controlada pelo sistema.")
    if account.status == AccountStatus.EXPIRED:
        raise EventError("Conta temporária expirada: use “Renovar acesso” para uma nova cobertura.")
    if target == account.status:
        return account
    if (account.role == AccountRole.ADMIN and account.status == AccountStatus.ACTIVE
            and _active_admins(db) <= 1):
        raise EventError("Esta é a única conta de administrador ativa; o sistema ficaria sem administrador.")
    previous = account.status
    if target == AccountStatus.ACTIVE and account.password_hash is None:
        # Never defined a password: it goes back to waiting for the holder.
        account.status = AccountStatus.PENDING
    else:
        account.status = target
    if account.status != AccountStatus.ACTIVE:
        _revoke_all_sessions(db, account.id)  # takes effect immediately, on every device
    audit.record(db, "account.status_changed", admin.id, "account", account.id,
                 previous=previous.value, current=account.status.value)
    db.commit()
    message = {
        AccountStatus.ACTIVE: "foi reativada. Você já pode entrar novamente no FOTOMAC.",
        AccountStatus.PENDING: "foi reativada. Você receberá um link para definir sua senha.",
        AccountStatus.INACTIVE: "foi desativada temporariamente pela administração. Enquanto estiver "
                                "inativa, ao entrar você verá apenas a situação da conta e o Suporte, para "
                                "falar com a administração.",
        AccountStatus.SUSPENDED: "foi suspensa pela administração. Enquanto estiver suspensa, ao entrar você "
                                 "verá apenas a situação da conta e o Suporte, para falar com a administração.",
    }[account.status]
    notify(sender, EmailMessage(
        to=account.email, subject="FOTOMAC: situação da sua conta",
        body=(f"Olá, {account.full_name}.\n\nSua conta no FOTOMAC {message}\n\nOs eventos e as fotos que você "
              "enviou continuam no acervo institucional, com o seu crédito.\n\nEm caso de dúvida, procure a "
              "administração do sistema.\n\nEquipe FOTOMAC\nCentro Universitário CESMAC")))
    if account.status == AccountStatus.PENDING:
        auth.send_activation_link(db, account, sender)
    return account


# ------------------------------------------------------------------ temporary account

def contractor_identity(db: Session, account: Account) -> dict | None:
    """What the administrator sees of the identification: CPF masked, birth date."""
    if account.role != AccountRole.CONTRACTOR:
        return None
    if account.identity_erased_at:
        return {"cpf": None, "birth_date": None, "erased_at": account.identity_erased_at}
    birth = identity.decrypt(db, account.birth_date_encrypted)
    return {"cpf": identity.masked_cpf(identity.decrypt(db, account.cpf_encrypted)), "birth_date": birth, "erased_at": None}


def renew_contract(db: Session, admin: Account, sender: EmailSender, account: Account, event_id: uuid.UUID | None,
                   contract_number: str | None, hours: int | None) -> Account:
    """A new coverage for the same hired photographer (24/10/2026): event, contract and period. Nothing is
    deleted — the photos of earlier coverages stay with their credit.
    - active: the hours are ADDED to what is left (and the event may change);
    - expired: works again now, for the hours chosen, with the password the person already has; if the
      identification was already erased, the person defines a new password and identifies again first;
    - pending (never logged in): only the terms change; the hours start at the first access."""
    if account.role != AccountRole.CONTRACTOR:
        raise EventError("Só a conta de fotógrafo contratado tem prazo para renovar.")
    if account.status in (AccountStatus.INACTIVE, AccountStatus.SUSPENDED):
        raise EventError("Reative a conta antes de renovar o prazo.")
    event, contract = _coverage(db, event_id, contract_number)
    hours = _clean_hours(hours)
    previous = {"status": account.status.value, "event_id": str(account.bound_event_id) if account.bound_event_id else None,
                "valid_until": account.valid_until.isoformat() if account.valid_until else None}
    account.bound_event_id, account.contract_number, account.contract_hours = event.id, contract, hours
    relink = False
    if account.status == AccountStatus.ACTIVE:
        account.valid_until = max(_now(), account.valid_until or _now()) + timedelta(hours=hours)
    elif account.status == AccountStatus.EXPIRED and account.identity_erased_at is None:
        account.status, account.valid_until = AccountStatus.ACTIVE, _now() + timedelta(hours=hours)
        account.failed_login_attempts, account.locked_until = 0, None
    elif account.status == AccountStatus.EXPIRED:
        # The CPF and birth date were erased (retention over): identification is required again, which only
        # the first-access link asks for. Status and password change together (database rule).
        account.status, account.password_hash, account.valid_until = AccountStatus.PENDING, None, None
        relink = True
    audit.record(db, "account.contract_renewed", admin.id, "account", account.id, hours=hours,
                 event_id=str(event.id), current=account.status.value, previous=previous)
    db.commit()
    when = (f"até {account.valid_until.astimezone(_BRT):%d/%m/%Y às %H:%M}" if account.valid_until
            else f"por {_hours_label(hours)} a partir do primeiro acesso")
    notify(sender, EmailMessage(
        to=account.email, subject="FOTOMAC: seu acesso foi renovado",
        body=(f"Olá, {account.full_name}.\n\nSeu acesso ao FOTOMAC como fotógrafo contratado foi renovado para o "
              f"evento “{event.name}” (contrato {contract}), {when}.\n\n"
              + ("Você vai receber outro e-mail com o link para definir a senha e confirmar a sua identificação.\n\n"
                 if relink else "Entre com o mesmo e-mail e a mesma senha de antes.\n\n")
              + "Equipe FOTOMAC\nCentro Universitário CESMAC")))
    if relink:
        auth.send_activation_link(db, account, sender)
    return account


_BRT = timezone(timedelta(hours=-3))  # Maceió: the date in the e-mail is the local one


def _hours_label(hours: int) -> str:
    return f"{hours // 24} dia{'s' if hours // 24 > 1 else ''}" if hours % 24 == 0 else f"{hours} hora{'s' if hours > 1 else ''}"


def expire_contractors(db: Session) -> int:
    """When its period ends (contract_hours after the password definition) the temporary account becomes
    "Expirada": from then on its sessions only reach the restricted screen (31/10/2026). It is kept — never
    deleted — and can be renewed (renew_contract)."""
    due = db.scalars(select(Account).where(Account.role == AccountRole.CONTRACTOR,
                                           Account.status == AccountStatus.ACTIVE,
                                           Account.valid_until.is_not(None), Account.valid_until <= _now())).all()
    for account in due:
        account.status = AccountStatus.EXPIRED
        audit.record(db, "account.expired", None, "account", account.id)
    if due:
        db.commit()
    return len(due)


def erase_contractor_identities(db: Session) -> int:
    """CPF and birth date are kept while the photos sent by the account are in the
    collection, plus the period set by the administrator (provisional, to be defined by the legal
    department). Then they are erased; the name stays in the operation records."""
    months = parameters.get(db, "contractor_identity_months")
    erased = 0
    for account in db.scalars(select(Account).where(Account.role == AccountRole.CONTRACTOR,
                                                    Account.status == AccountStatus.EXPIRED,
                                                    Account.identity_erased_at.is_(None))).all():
        if db.scalar(select(func.count()).select_from(Image).where(Image.uploaded_by == account.id)):
            account.media_gone_at = None
            continue
        if account.media_gone_at is None:
            account.media_gone_at = _now()
        elif account.media_gone_at + timedelta(days=30 * months) <= _now():
            account.cpf_encrypted = account.birth_date_encrypted = None
            account.identity_erased_at = _now()
            audit.record(db, "account.identity_erased", None, "account", account.id)
            erased += 1
    db.commit()
    return erased


def unlock(db: Session, admin: Account, account: Account) -> Account:
    """The administrator may lift the temporary lock (5 wrong passwords)."""
    account.failed_login_attempts = 0
    account.locked_until = None
    audit.record(db, "account.unlocked", admin.id, "account", account.id)
    db.commit()
    return account
