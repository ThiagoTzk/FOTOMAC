"""CEP → street and point on the map, for "Local do evento" (01/11/2026).

The street comes from ViaCEP, which has no coordinates. The point comes from Nominatim (OpenStreetMap), with
AwesomeAPI as the second opinion. A CEP is a stretch of street, never a building: the point only places the map, and
the person who creates the event puts the pin on the entrance.

It goes through this server, not the browser: the outside services see the CEP of an event, never who is using the
form. Nominatim allows one request per second for the whole application and asks for answers to be kept, hence the
pause and the cache.
"""
from __future__ import annotations

import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

USER_AGENT = "FOTOMAC/2.0 (TCC CESMAC; localizacao de eventos)"
TIMEOUT_SECONDS = 6
CACHE_SECONDS = 30 * 24 * 3600
CACHE_MAX = 2000
NOMINATIM_GAP_SECONDS = 1.1


class CepInvalid(Exception):
    """Not eight digits."""


class CepNotFound(Exception):
    """A well-formed CEP that does not exist."""


class CepUnavailable(Exception):
    """The outside services did not answer: the pin can still be placed by hand."""


@dataclass(frozen=True)
class Place:
    postal_code: str
    street: str
    district: str
    city: str
    state: str
    latitude: float | None
    longitude: float | None


_cache: dict[str, tuple[float, Place]] = {}
_lock = threading.Lock()
_nominatim_lock = threading.Lock()
_nominatim_last = 0.0


def clean(cep: str) -> str:
    digits = re.sub(r"\D", "", cep or "")
    if len(digits) != 8:
        raise CepInvalid("Informe o CEP com 8 números.")
    return digits


def _get_json(url: str):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: S310 - fixed https hosts
        return json.load(response)


def _point(lat, lng) -> tuple[float, float] | None:
    try:
        point = float(lat), float(lng)
    except (TypeError, ValueError):
        return None
    return point if -90 <= point[0] <= 90 and -180 <= point[1] <= 180 else None


def _nominatim(cep: str, city: str) -> tuple[float, float] | None:
    global _nominatim_last
    query = urllib.parse.urlencode({"postalcode": f"{cep[:5]}-{cep[5:]}", "country": "Brasil", "format": "jsonv2", "limit": 1})
    with _nominatim_lock:
        wait = _nominatim_last + NOMINATIM_GAP_SECONDS - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        try:
            rows = _get_json(f"https://nominatim.openstreetmap.org/search?{query}")
        finally:
            _nominatim_last = time.monotonic()
    # The same city ViaCEP gave, or it is someone else's CEP: a wrong point is worse than none.
    if rows and city.casefold() in rows[0].get("display_name", "").casefold():
        return _point(rows[0].get("lat"), rows[0].get("lon"))
    return None


def _awesome(cep: str, city: str) -> tuple[float, float] | None:
    row = _get_json(f"https://cep.awesomeapi.com.br/json/{cep}")
    return _point(row.get("lat"), row.get("lng")) if row.get("city", "").casefold() == city.casefold() else None


def _find_point(cep: str, city: str) -> tuple[float, float] | None:
    for source in (_nominatim, _awesome):
        try:
            point = source(cep, city)
        except (OSError, ValueError, AttributeError):   # one service down or odd: ask the other
            continue
        if point:
            return point
    return None


def lookup(raw: str) -> Place:
    cep = clean(raw)
    now = time.time()
    with _lock:
        kept = _cache.get(cep)
        if kept and kept[0] > now:
            return kept[1]
    try:
        address = _get_json(f"https://viacep.com.br/ws/{cep}/json/")
    except urllib.error.HTTPError as exc:
        if exc.code == 400:
            raise CepNotFound("CEP não encontrado.") from None
        raise CepUnavailable("Não foi possível consultar o CEP agora.") from None
    except (OSError, ValueError):
        raise CepUnavailable("Não foi possível consultar o CEP agora.") from None
    if address.get("erro"):
        raise CepNotFound("CEP não encontrado.")

    city = address.get("localidade", "")
    point = _find_point(cep, city)
    place = Place(postal_code=cep, street=address.get("logradouro", ""), district=address.get("bairro", ""), city=city,
                  state=address.get("uf", ""), latitude=point[0] if point else None, longitude=point[1] if point else None)
    if point:   # without a point, try again next time
        with _lock:
            if len(_cache) >= CACHE_MAX:
                _cache.clear()
            _cache[cep] = (now + CACHE_SECONDS, place)
    return place
