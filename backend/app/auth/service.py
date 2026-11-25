"""Authentication business rules.

Isolated from HTTP and from the rest of the application: a future
integration with CESMAC's institutional accounts replaces this module, not the screens
nor the other rules.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app import audit
from app.auth import passwords
from app.auth.tokens import new_token, token_hash
from app.config import get_settings
from app.db.models import (AUTHOR_ROLES, Account, AccountRole, AccountStatus, PasswordToken, PasswordTokenPurpose,
                           Session as LoginSession)
from app.notifications.port import EmailMessage, EmailSender, notify

# One message for every login failure: never reveal whether the e-mail exists, the
# password is wrong, or the account is locked/suspended.
GENERIC_LOGIN_ERROR = "Não foi possível entrar. Verifique suas credenciais e tente novamente."
# Suspended, inactive or expired (31/10/2026, user test): whoever types the RIGHT password enters a restricted
# screen — what happened to the account, its data and the Support page to ask to come back. Nothing else is
# reachable (the routes check it on the server). A stranger with a wrong password still gets the generic
# message, so the login never tells who has an account.
BLOCKED = (AccountStatus.SUSPENDED, AccountStatus.INACTIVE, AccountStatus.EXPIRED)
INVALID_LINK_ERROR = ("Este link é inválido, já foi usado ou expirou. "
                      "Solicite um novo link para continuar.")


class AuthError(Exception):
    """Message safe to show to the user."""


class WeakPasswordError(AuthError):
    def __init__(self, failed: list[str]):
        super().__init__("A nova senha ainda não atende aos requisitos.")
        self.failed = failed


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class LoginResult:
    account: Account
    session_token: str  # goes ONLY into the HttpOnly cookie, never into a response body
    # Set only with "Manter conectado": how long the cookie outlives the browser. None = the cookie
    # dies when the browser closes (the server still ends the session after session_hours).
    remember_seconds: int | None = None


def session_lifetime(account: Account, remember: bool) -> timedelta:
    """8 hours, or remember_days with "Manter conectado". A hired photographer's session may outlive the account
    (31/10/2026): from the moment its time ends, the session only reaches the restricted screen (why it stopped,
    and the Support page) — every other route refuses it, on the server."""
    settings = get_settings()
    return timedelta(days=settings.remember_days) if remember else timedelta(hours=settings.session_hours)


# ------------------------------------------------------------------- login / logout

def login(db: Session, email: str, password: str, remember: bool = False) -> LoginResult:
    settings = get_settings()
    account = db.scalar(select(Account).where(func.lower(Account.email) == email.strip().lower()))

    if account is None or account.password_hash is None:
        passwords.verify_password(passwords.DUMMY_HASH, password)  # same response time
        audit.record(db, "auth.login_failed")  # the typed e-mail is NOT stored
        db.commit()
        raise AuthError(GENERIC_LOGIN_ERROR)

    locked = account.locked_until is not None and account.locked_until > _now()
    password_ok = passwords.verify_password(account.password_hash, password)
    if (account.role == AccountRole.CONTRACTOR and account.status == AccountStatus.ACTIVE
            and account.valid_until and account.valid_until <= _now()):
        account.status = AccountStatus.EXPIRED   # its time ended while nobody was logged in
        audit.record(db, "account.expired", None, "account", account.id)

    blocked = password_ok and not locked and account.status in BLOCKED
    if not blocked and (locked or not password_ok or account.status != AccountStatus.ACTIVE):
        if not locked and not password_ok:
            account.failed_login_attempts += 1
            if account.failed_login_attempts >= settings.max_failed_logins:
                account.locked_until = _now() + timedelta(minutes=settings.lockout_minutes)
                audit.record(db, "auth.account_locked", account.id, "account", account.id)
        audit.record(db, "auth.login_failed", account.id, "account", account.id,
                     reason="locked" if locked else ("password" if not password_ok else account.status.value))
        db.commit()
        raise AuthError(GENERIC_LOGIN_ERROR)

    account.failed_login_attempts = 0
    account.locked_until = None
    token = new_token()  # a brand-new token on every login
    if blocked:   # restricted: never kept after the browser closes, whatever the box said
        remember = False
        life = timedelta(hours=settings.session_hours)
    else:
        life = session_lifetime(account, remember)
    db.add(LoginSession(token_hash=token_hash(token), account_id=account.id, expires_at=_now() + life, remember=remember))
    audit.record(db, "auth.login_restricted" if blocked else "auth.login", account.id, "account", account.id,
                 **({"status": account.status.value} if blocked else {"remember": remember}))
    db.commit()
    return LoginResult(account, token, int(life.total_seconds()) if remember else None)


IDLE_TOUCH_SECONDS = 30   # last_activity_at is written at most this often (not on every request)
# Closing the browser (28/10/2026). The cookie of a session without "Manter conectado" has no expiry date, but a
# browser that reopens "where it left off" restores it — so the server also checks that a tab is still open.
CLOSE_GRACE_SECONDS = 15    # the last tab said it closed: a reload comes back well within this
PRESENCE_GRACE_MINUTES = 5  # open tabs say so every minute (a background tab, at most every two)


def current_session(db: Session, token: str | None) -> LoginSession | None:
    """The open session behind a cookie (not revoked, not past its end), whatever its idle time."""
    if not token:
        return None
    return db.scalar(select(LoginSession).where(
        LoginSession.token_hash == token_hash(token), LoginSession.revoked_at.is_(None),
        LoginSession.expires_at > _now()))


def idle_left(row: LoginSession) -> int | None:
    """Seconds before the session ends for lack of use; None with "Manter conectado"."""
    if row.remember:
        return None
    limit = timedelta(minutes=get_settings().idle_minutes)
    return max(0, int((row.last_activity_at + limit - _now()).total_seconds()))


def browser_closed(row: LoginSession) -> bool:
    """No tab of the site is open any more: the last one said it closed (and no page came back since), or the
    open tabs stopped giving signs of life (browser killed, computer asleep). Never with "Manter conectado"."""
    if row.remember:
        return False
    now = _now()
    if row.closed_at and now - row.closed_at > timedelta(seconds=CLOSE_GRACE_SECONDS):
        return True
    return bool(row.seen_at and now - row.seen_at > timedelta(minutes=PRESENCE_GRACE_MINUTES))


def tab_open(db: Session, token: str | None) -> None:
    """A tab of the site is open (its sign of life, once a minute). Does NOT count as use for the idle limit."""
    row = current_session(db, token)
    if row and not row.remember and (row.seen_at is None or row.seen_at < _now() - timedelta(seconds=IDLE_TOUCH_SECONDS)):
        row.seen_at = _now()
        db.commit()


def tab_closed(db: Session, token: str | None) -> None:
    """The last open tab of the site is closing (or reloading: then the page comes back in a few seconds)."""
    row = current_session(db, token)
    if row and not row.remember:
        row.closed_at = _now()
        db.commit()


def account_for_session(db: Session, token: str | None, background: bool = False,
                        blocked_ok: bool = False) -> Account | None:
    """The account behind a session cookie, or None. Status is re-checked on EVERY request,
    so suspending an account takes effect immediately.

    blocked_ok=True: also a suspended, inactive or expired account — only for the few routes of the restricted
    screen (who I am, the Support page, logging out). Every other route keeps refusing it.

    Inactivity (25/10/2026): without "Manter conectado", a session with no use for settings.idle_minutes ends,
    here on the server — closing the warning on the screen does not keep it alive. background=True (a read the
    screen may make by itself, like the bell) checks the session without counting as use."""
    row = current_session(db, token)
    allowed = (AccountStatus.ACTIVE, *BLOCKED) if blocked_ok else (AccountStatus.ACTIVE,)
    if row is None or row.account.status not in allowed:
        return None
    if idle_left(row) == 0:
        row.revoked_at = _now()
        audit.record(db, "auth.session_idle", row.account_id, "account", row.account_id)
        db.commit()
        return None
    if browser_closed(row):
        row.revoked_at = _now()
        audit.record(db, "auth.session_closed", row.account_id, "account", row.account_id)
        db.commit()
        return None
    if row.closed_at is not None:   # a reload (or another tab) came back in time
        row.closed_at = None
        db.commit()
    if not background and row.last_activity_at < _now() - timedelta(seconds=IDLE_TOUCH_SECONDS):
        row.last_activity_at = _now()
        db.commit()
    account = row.account
    # A temporary account stops working the moment its time ends, even mid-session. The session is kept, but only
    # for the restricted screen (31/10/2026): the countdown reaches zero and the person sees why and what to do.
    if (account.role == AccountRole.CONTRACTOR and account.status == AccountStatus.ACTIVE
            and account.valid_until and account.valid_until <= _now()):
        account.status = AccountStatus.EXPIRED
        audit.record(db, "account.expired", None, "account", account.id)
        db.commit()
    if account.status != AccountStatus.ACTIVE and not blocked_ok:
        return None
    return account


def blocked_info(db: Session, account: Account) -> dict | None:
    """What the restricted screen shows about a suspended, inactive or expired account (31/10/2026): since when, and
    the last time it really entered the system. Only to the account itself."""
    if account.status not in BLOCKED:
        return None
    from app.db.models import AuditLog

    def last(*actions: str) -> datetime | None:
        return db.scalar(select(func.max(AuditLog.occurred_at)).where(
            AuditLog.action.in_(actions), AuditLog.target_type == "account", AuditLog.target_id == str(account.id)))

    since = last("account.status_changed", "account.expired")
    if account.status == AccountStatus.EXPIRED and account.valid_until:
        since = account.valid_until
    return {"since": since, "last_login_at": last("auth.login")}


def logout(db: Session, token: str | None) -> None:
    if not token:
        return
    row = db.scalar(select(LoginSession).where(LoginSession.token_hash == token_hash(token)))
    if row and row.revoked_at is None:
        row.revoked_at = _now()
        audit.record(db, "auth.logout", row.account_id, "account", row.account_id)
        db.commit()


def _revoke_all_sessions(db: Session, account_id: uuid.UUID) -> None:
    db.execute(update(LoginSession).where(LoginSession.account_id == account_id,
                                          LoginSession.revoked_at.is_(None))
               .values(revoked_at=_now()))


# ------------------------------------------------------------------- password links

def _issue_link(db: Session, account: Account, purpose: PasswordTokenPurpose) -> str:
    settings = get_settings()
    # Only the newest link of each kind works: older unused ones are invalidated.
    db.execute(update(PasswordToken).where(PasswordToken.account_id == account.id,
                                           PasswordToken.purpose == purpose,
                                           PasswordToken.used_at.is_(None))
               .values(used_at=_now()))
    lifetime = (timedelta(hours=settings.activation_link_hours) if purpose == PasswordTokenPurpose.ACTIVATION
                else timedelta(minutes=settings.reset_link_minutes))
    token = new_token()
    db.add(PasswordToken(token_hash=token_hash(token), account_id=account.id, purpose=purpose,
                         expires_at=_now() + lifetime))
    return token


def send_activation_link(db: Session, account: Account, sender: EmailSender) -> None:
    """The account is created WITHOUT a password; the holder defines it."""
    if account.status != AccountStatus.PENDING:
        raise AuthError("Esta conta já foi ativada.")
    settings = get_settings()
    token = _issue_link(db, account, PasswordTokenPurpose.ACTIVATION)
    db.commit()
    sender.send(EmailMessage(
        to=account.email, subject="FOTOMAC: defina sua senha de acesso",
        body=(f"Olá, {account.full_name}.\n\nUma conta foi criada para você no FOTOMAC. Para ativá-la, "
              f"defina sua senha pessoal no link abaixo (válido por {settings.activation_link_hours} horas "
              f"e de uso único):\n\n{settings.frontend_url}/primeiro-acesso?token={token}\n\n"
              "Se você não esperava esta mensagem, ignore-a.\n\nEquipe FOTOMAC\nCentro Universitário CESMAC")))


def request_password_reset(db: Session, email: str, sender: EmailSender) -> None:
    """Always "succeeds" from the caller's point of view."""
    account = db.scalar(select(Account).where(func.lower(Account.email) == email.strip().lower()))
    # No self-service recovery for a temporary account; the administrator issues a new link.
    if account is None or account.status != AccountStatus.ACTIVE or account.role == AccountRole.CONTRACTOR:
        return
    settings = get_settings()
    token = _issue_link(db, account, PasswordTokenPurpose.RESET)
    audit.record(db, "auth.password_reset_requested", account.id, "account", account.id)
    db.commit()
    notify(sender, EmailMessage(
        to=account.email, subject="FOTOMAC: redefinição de senha",
        body=(f"Olá, {account.full_name}.\n\nRecebemos um pedido para redefinir sua senha. Use o link abaixo "
              f"(válido por {settings.reset_link_minutes} minutos e de uso único):\n\n"
              f"{settings.frontend_url}/redefinir-senha?token={token}\n\n"
              "Se você não fez este pedido, ignore esta mensagem: sua senha continua a mesma.\n\n"
              "Equipe FOTOMAC\nCentro Universitário CESMAC")))


def _valid_link(db: Session, token: str, purpose: PasswordTokenPurpose) -> PasswordToken | None:
    return db.scalar(select(PasswordToken).where(
        PasswordToken.token_hash == token_hash(token), PasswordToken.purpose == purpose,
        PasswordToken.used_at.is_(None), PasswordToken.expires_at > _now()))


def link_is_valid(db: Session, token: str, purpose: PasswordTokenPurpose) -> bool:
    return _valid_link(db, token, purpose) is not None


def _set_password(db: Session, token: str, purpose: PasswordTokenPurpose,
                  password: str, confirmation: str) -> Account:
    link = _valid_link(db, token, purpose)
    if link is None:
        raise AuthError(INVALID_LINK_ERROR)
    expected = AccountStatus.PENDING if purpose == PasswordTokenPurpose.ACTIVATION else AccountStatus.ACTIVE
    if link.account.status != expected:
        raise AuthError(INVALID_LINK_ERROR)
    if failed := passwords.failed_rules(password):
        raise WeakPasswordError(failed)
    if password != confirmation:
        raise AuthError("As senhas não coincidem.")
    account = link.account
    if purpose == PasswordTokenPurpose.ACTIVATION:
        # Status and password change together: the database forbids a pending account
        # with a password and an active one without it.
        account.status = AccountStatus.ACTIVE
    account.password_hash = passwords.hash_password(password)
    account.failed_login_attempts = 0
    account.locked_until = None  # recovery e-mail also unlocks
    link.used_at = _now()        # invalidated immediately after use
    _revoke_all_sessions(db, account.id)
    return account


def activation_info(db: Session, token: str) -> dict:
    """What the first-access screen needs before asking anything: is the link valid, and must the
    holder identify themselves (temporary account)?"""
    link = _valid_link(db, token, PasswordTokenPurpose.ACTIVATION)
    if link is None or link.account.status != AccountStatus.PENDING:
        return {"valid": False, "needs_identity": False, "full_name": None}
    contractor = link.account.role == AccountRole.CONTRACTOR
    return {"valid": True, "needs_identity": contractor, "full_name": link.account.full_name if contractor else None}


def activate_account(db: Session, token: str, password: str, confirmation: str,
                     cpf: str | None = None, birth_date: date | None = None) -> LoginResult:
    """First access: defines the password, "Acesso Pendente" → "Ativa". A hired
    photographer also informs CPF and birth date, and the contracted hours start now."""
    from app.accounts import identity  # local: identity → events.service → … would import this module
    from app.events.service import EventError

    link = _valid_link(db, token, PasswordTokenPurpose.ACTIVATION)
    contractor = link is not None and link.account.role == AccountRole.CONTRACTOR
    encrypted = None
    if contractor:
        try:
            digits, born = identity.clean_cpf(cpf or ""), identity.clean_birth_date(birth_date)
            # Encrypted BEFORE the password is set: the database refuses an active contractor
            # without identification, and the query below would flush a half-done account.
            encrypted = identity.encrypt(db, digits), identity.encrypt(db, born.isoformat())
        except EventError as exc:
            raise AuthError(str(exc)) from None
    # No autoflush in between: setting the password ends the old sessions with a query, which would
    # write the account as "active" before its identification is in place (the database refuses it).
    with db.no_autoflush:
        account = _set_password(db, token, PasswordTokenPurpose.ACTIVATION, password, confirmation)
        if encrypted:
            account.cpf_encrypted, account.birth_date_encrypted = encrypted
            account.identity_erased_at = account.media_gone_at = None   # identified again (renewed account)
            account.valid_until = _now() + timedelta(hours=account.contract_hours or 24)
    if encrypted:
        audit.record(db, "account.contractor_identified", account.id, "account", account.id)
    audit.record(db, "auth.account_activated", account.id, "account", account.id)
    session_token = new_token()
    db.add(LoginSession(token_hash=token_hash(session_token), account_id=account.id,
                        expires_at=_now() + timedelta(hours=get_settings().session_hours)))
    db.commit()
    return LoginResult(account, session_token)


def reset_password(db: Session, token: str, password: str, confirmation: str) -> None:
    account = _set_password(db, token, PasswordTokenPurpose.RESET, password, confirmation)
    audit.record(db, "auth.password_reset", account.id, "account", account.id)
    db.commit()


# ------------------------------------------------------------------- own profile

def update_signature(db: Session, account: Account, signature: str) -> Account:
    """The photographer may change the professional name used as credit.
    Only the name is stored; "— Centro Universitário CESMAC" is added when displayed."""
    signature = signature.strip()
    if account.role not in AUTHOR_ROLES:
        raise AuthError("Somente contas que enviam fotos possuem assinatura.")
    if not signature or len(signature) > 80:
        raise AuthError("Informe a assinatura (até 80 caracteres).")
    if signature != account.photographer_signature:
        audit.record(db, "account.signature_changed", account.id, "account", account.id,
                     de=account.photographer_signature, para=signature)
        account.photographer_signature = signature
        db.commit()
    return account


def change_password(db: Session, account: Account, current_token: str, current: str,
                    password: str, confirmation: str) -> None:
    """Logged-in password change. Ends every OTHER session and keeps this one."""
    if not account.password_hash or not passwords.verify_password(account.password_hash, current):
        raise AuthError("A senha atual não confere.")
    if failed := passwords.failed_rules(password):
        raise WeakPasswordError(failed)
    if password != confirmation:
        raise AuthError("As senhas não coincidem.")
    if passwords.verify_password(account.password_hash, password):
        raise AuthError("A nova senha deve ser diferente da atual.")
    account.password_hash = passwords.hash_password(password)
    db.execute(update(LoginSession).where(LoginSession.account_id == account.id,
                                          LoginSession.revoked_at.is_(None),
                                          LoginSession.token_hash != token_hash(current_token))
               .values(revoked_at=_now()))
    audit.record(db, "auth.password_changed", account.id, "account", account.id)
    db.commit()
