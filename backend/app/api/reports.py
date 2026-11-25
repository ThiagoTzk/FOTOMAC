"""Registros (RF024, RNF14): the administrator's summary of a period and the export of the records.

Administrator only: the export carries names and e-mails of the team and of the institutional people.
"""
from __future__ import annotations

from datetime import date
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.api.deps import require_role
from app.db.models import Account, AccountRole
from app.db.session import get_session
from app.reports import service

router = APIRouter(prefix="/admin/reports", tags=["admin: registros"])
admin_only = require_role(AccountRole.ADMIN)


@router.get("/summary")
def summary(start: date | None = None, end: date | None = None, _: Account = Depends(admin_only),
            db: Session = Depends(get_session)):
    try:
        return service.summary(db, start, end)
    except service.ReportError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None


@router.get("/export.zip")
def export(start: date | None = None, end: date | None = None, admin: Account = Depends(admin_only),
           db: Session = Depends(get_session)):
    try:
        data, name = service.export_zip(db, admin, start, end)
    except service.ReportError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None
    return Response(data, media_type="application/zip", headers={
        "Cache-Control": "no-store",
        "Content-Disposition": f"attachment; filename=\"registros.zip\"; filename*=UTF-8''{quote(name)}"})
