"""Temas screen (RF027), for every team account: the administrator, photographers and marketing.

One list, visible to all of them, with the author of each theme. Creating happens through POST /themes
(api/events.py, also used inside the event form). Changing a theme is for its author or the administrator,
a rule the service applies on the server. The hired photographer's temporary account is refused here.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.deps import require_role
from app.db.models import Account, AccountRole
from app.db.session import get_session
from app.events.service import EventError, NotFound, PermissionDenied
from app.themes import service as themes

router = APIRouter(prefix="/themes", tags=["temas"])
team = require_role(AccountRole.ADMIN, AccountRole.PHOTOGRAPHER, AccountRole.MARKETING)


class ThemeRow(BaseModel):
    id: int
    name: str
    icon: str
    active: bool
    events: int
    author: str | None       # None: the account is gone, or the theme came with the system
    mine: bool               # created by the account asking
    can_change: bool         # the author or the administrator


class ThemeIn(BaseModel):
    name: str = Field(max_length=200)
    icon: str | None = Field(None, max_length=40)


class ThemeStatusIn(BaseModel):
    active: bool


def _http(exc: EventError) -> HTTPException:
    code = (status.HTTP_404_NOT_FOUND if isinstance(exc, NotFound)
            else status.HTTP_403_FORBIDDEN if isinstance(exc, PermissionDenied) else status.HTTP_400_BAD_REQUEST)
    return HTTPException(code, str(exc))


def _rows(db: Session, account: Account) -> list[ThemeRow]:
    return [ThemeRow(id=t.id, name=t.name, icon=t.icon, active=t.active, events=n, author=author,
                     mine=t.created_by == account.id, can_change=themes.can_change(account, t))
            for t, n, author in themes.list_with_counts(db)]


def _row(db: Session, account: Account, theme_id: int) -> ThemeRow:
    for row in _rows(db, account):
        if row.id == theme_id:
            return row
    raise HTTPException(status.HTTP_404_NOT_FOUND, "Tema não encontrado.")


@router.get("/manage", response_model=list[ThemeRow])
def list_themes(account: Account = Depends(team), db: Session = Depends(get_session)):
    """"Relação de Temas": every theme, active or not, with its author and how many events use it."""
    return _rows(db, account)


@router.put("/{theme_id}", response_model=ThemeRow)
def rename_theme(theme_id: int, body: ThemeIn, account: Account = Depends(team), db: Session = Depends(get_session)):
    try:
        themes.rename(db, account, theme_id, body.name, body.icon)
    except EventError as exc:
        raise _http(exc) from None
    return _row(db, account, theme_id)


@router.post("/{theme_id}/status", response_model=ThemeRow)
def theme_status(theme_id: int, body: ThemeStatusIn, account: Account = Depends(team),
                 db: Session = Depends(get_session)):
    try:
        themes.set_active(db, account, theme_id, body.active)
    except EventError as exc:
        raise _http(exc) from None
    return _row(db, account, theme_id)


@router.delete("/{theme_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_theme(theme_id: int, account: Account = Depends(team), db: Session = Depends(get_session)):
    try:
        themes.delete(db, account, theme_id)
    except EventError as exc:
        raise _http(exc) from None
