"""Event themes (RF027): photographers, marketing and the administrator create and maintain them.

One list for everyone. A theme belongs to the account that created it: only that account changes it
(rename, icon, inactivate, delete), so nobody alters another person's theme; the administrator may change
any of them, preferably only to moderate. The hired photographer's temporary account does not take part.
"""
from __future__ import annotations

import re

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import audit
from app.db.models import Account, AccountRole, Theme, event_themes
from app.events.service import EventError, NotFound, PermissionDenied


def list_with_counts(db: Session) -> list[tuple[Theme, int, str | None]]:
    """"Relação de Temas": name, situation, how many events use each one and who created it."""
    count = select(func.count()).select_from(event_themes).where(event_themes.c.theme_id == Theme.id).scalar_subquery()
    return list(db.execute(select(Theme, count, Account.full_name).outerjoin(Account, Account.id == Theme.created_by)
                           .order_by(Theme.active.desc(), func.lower(Theme.name))).all())


def can_change(account: Account, theme: Theme) -> bool:
    """The author, or the administrator. A theme whose author is gone (or that came with the system)
    is left to the administrator."""
    return account.role == AccountRole.ADMIN or (theme.created_by is not None and theme.created_by == account.id)


def _check_team(account: Account) -> None:
    if account.role == AccountRole.CONTRACTOR:  # a temporary account does not create nor maintain themes
        raise PermissionDenied("Esta conta não cria nem altera temas.")


def _owned(db: Session, account: Account, theme_id: int) -> Theme:
    """The theme, if this account may change it: checked here, on the server, whatever the screen shows."""
    _check_team(account)
    theme = _get(db, theme_id)
    if not can_change(account, theme):
        raise PermissionDenied("Só quem criou este tema pode alterá-lo.")
    return theme


def _get(db: Session, theme_id: int) -> Theme:
    theme = db.get(Theme, theme_id)
    if theme is None:
        raise NotFound("Tema não encontrado.")
    return theme


def _clean(db: Session, name: str, ignore_id: int | None = None) -> str:
    name = " ".join(name.split())
    if not name:
        raise EventError("Informe o nome do tema.")
    if len(name) > 50:
        raise EventError("O nome do tema pode ter até 50 caracteres.")
    # Unique ignoring capitals AND accents (RF027 note 1, 11/11/2026: "Ciência" and "Ciencia" were two themes). The same
    # unaccent the public search uses, so the list of the team and the public filters never show both.
    folded = func.unaccent(func.lower(name))
    clash = db.scalar(select(Theme.id).where(func.unaccent(func.lower(Theme.name)) == folded, Theme.id != (ignore_id or -1)))
    if clash:
        raise EventError("Já existe um tema com esse nome.")  # unique in the system
    return name


ICON = re.compile(r"^[a-z0-9-]{1,40}$")
DEFAULT_ICON = "tag"


def _icon(icon: str | None) -> str:
    """The symbol is the NAME of an icon the front-end draws (lucide set); unknown names are
    drawn as the default tag there, so only the format is checked here."""
    icon = (icon or DEFAULT_ICON).strip()
    if not ICON.match(icon):
        raise EventError("Ícone inválido.")
    return icon


def create(db: Session, account: Account, name: str, icon: str | None = None) -> Theme:
    """On the Temas screen or while filling in an event, by any team account: the creator owns it."""
    _check_team(account)
    theme = Theme(name=_clean(db, name), active=True, icon=_icon(icon), created_by=account.id)
    db.add(theme)
    db.flush()
    audit.record(db, "theme.created", account.id, "theme", str(theme.id), name=theme.name, icon=theme.icon)
    db.commit()
    return theme


def rename(db: Session, account: Account, theme_id: int, name: str, icon: str | None = None) -> Theme:
    """Edits the name and, when given, the symbol, each change in the audit log."""
    theme = _owned(db, account, theme_id)
    new = _clean(db, name, theme.id)
    if new != theme.name:
        audit.record(db, "theme.renamed", account.id, "theme", str(theme.id), previous=theme.name, new=new)
        theme.name = new
    if icon is not None and (new_icon := _icon(icon)) != theme.icon:
        audit.record(db, "theme.icon_changed", account.id, "theme", str(theme.id), previous=theme.icon, new=new_icon)
        theme.icon = new_icon
    db.commit()
    return theme


def set_active(db: Session, account: Account, theme_id: int, active: bool) -> Theme:
    """Inactive: no longer offered for new events nor in the public filters; events that already
    use it keep it."""
    theme = _owned(db, account, theme_id)
    if theme.active != active:
        theme.active = active
        audit.record(db, "theme.activated" if active else "theme.deactivated", account.id, "theme", str(theme.id))
    db.commit()
    return theme


def delete(db: Session, account: Account, theme_id: int) -> None:
    """Only a theme NO event uses can be deleted; otherwise it is inactivated."""
    theme = _owned(db, account, theme_id)
    used = db.scalar(select(func.count()).select_from(event_themes).where(event_themes.c.theme_id == theme.id))
    if used:
        raise EventError(f"Este tema está em {used} evento(s) e não pode ser excluído. Inative-o.")
    audit.record(db, "theme.deleted", account.id, "theme", str(theme.id), name=theme.name)
    db.delete(theme)
    db.commit()
