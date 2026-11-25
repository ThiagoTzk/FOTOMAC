"""CEP lookup for the event form, and the map of Brazil the site serves itself."""
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.api.deps import current_account
from app.config import get_settings
from app.db.models import PRODUCER_ROLES, Account, AccountRole
from app.geo import cep as geo
from app.security.rate_limit import RateLimiter

router = APIRouter(tags=["geo"])
limiter = RateLimiter(max_requests=30, window_seconds=60)   # per account: the outside services are shared and free


class PlaceOut(BaseModel):
    postal_code: str
    street: str
    district: str
    city: str
    state: str
    latitude: float | None
    longitude: float | None


@router.get("/geo/cep/{cep}", response_model=PlaceOut)
def find_cep(cep: str, account: Account = Depends(current_account)):
    if account.role not in PRODUCER_ROLES and account.role != AccountRole.ADMIN:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Esta conta não cadastra eventos.")
    limiter.check(str(account.id))
    try:
        return PlaceOut(**geo.lookup(cep).__dict__)
    except geo.CepInvalid as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None
    except geo.CepNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from None
    except geo.CepUnavailable as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from None


@router.get("/map/brasil.pmtiles", include_in_schema=False)
def map_of_brazil():
    """Public: streets, no one's data. Served from here so that opening a page connects the visitor to nobody else.

    The browser asks for pieces of the 4 GB file (Range), which FileResponse answers.
    """
    path = get_settings().map_file
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "O mapa não está instalado neste servidor.")
    return FileResponse(path, media_type="application/octet-stream", headers={"Cache-Control": "public, max-age=604800"})
