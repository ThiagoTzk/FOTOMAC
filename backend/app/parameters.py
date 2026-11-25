"""Administrator-configurable parameters of facial recognition and retention.

Values live in system_parameters (one row per changed key); a key never changed uses its
default. Every change is written to the append-only audit log with the previous and the new
value and the administrator — nobody can rewrite that history.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import audit
from app.config import get_settings
from app.db.models import Account, AuditLog, Event, EventStatus, SystemParameter
from app.events import dates
from app.face import factory


@dataclass(frozen=True)
class Spec:
    label: str
    default: float
    minimum: float
    maximum: float
    step: float
    unit: str
    group: str
    help: str
    integer: bool = True
    # A choice instead of a number (shown as a list on screen): ((value, label), ...).
    choices: tuple[tuple[int, str], ...] | None = None


_factory = get_settings()  # .env holds the factory defaults; the administrator's changes live in the DB

MAX_VIDEO_MB = 4096   # the ceiling of the parameter, and of what the server accepts to receive at all

SPECS: dict[str, Spec] = {
    # Its default is not fixed: it is the value calibrated for the engine in use (default(), below).
    "similarity_threshold": Spec(
        "Limiar de similaridade", factory.ENGINES[_factory.face_engine].similarity_threshold if _factory.face_engine
        in factory.ENGINES else 0.5, 0.20, 0.80, 0.0001, "", "Comparação",
        "Semelhança mínima (0 a 1) para uma foto ser entregue ao visitante. Mais alto = menos falsos positivos "
        "e mais fotos verdadeiras perdidas. O padrão é o valor calibrado para o modelo em uso; ao trocar o modelo, "
        "o limiar volta ao calibrado do novo modelo.", integer=False),
    # Never less demanding than the public search; its default is the same
    # calibrated value of the engine in use (default(), below).
    "institutional_threshold": Spec(
        "Limiar da marcação institucional", factory.ENGINES[_factory.face_engine].similarity_threshold if _factory.face_engine
        in factory.ENGINES else 0.5, 0.20, 0.90, 0.0001, "", "Comparação",
        "Semelhança mínima para marcar uma pessoa institucional numa foto de qualquer evento. Não pode ser menor que "
        "o limiar da busca pública. Ao mudar, as pessoas autorizadas são procuradas de novo no acervo. Volta ao "
        "calibrado do modelo quando o modelo é trocado.", integer=False),
    "max_results_per_search": Spec(
        "Teto de resultados por busca", _factory.max_results_per_search, 10, 1000, 10, "fotos", "Comparação",
        "Quantidade máxima de fotos devolvidas numa busca."),
    "min_detection_score": Spec(
        "Confiança mínima da detecção", _factory.min_detection_score, 0.50, 0.95, 0.01, "", "Detecção",
        "Abaixo disso o rosto é ignorado, na indexação e na foto de busca. O detector já descarta tudo abaixo "
        "de 0,50 (configuração do Teste 1), por isso não é possível baixar mais.", integer=False),
    "min_query_face_side": Spec(
        "Lado mínimo do rosto da foto de busca", _factory.min_query_face_side, 20, 400, 1, "pixels", "Detecção",
        "Rostos menores que isso na foto enviada pelo visitante são recusados por qualidade insuficiente."),
    "searches_per_session": Spec(
        "Buscas por sessão de visitante", 10, 1, 100, 1, "buscas", "Limites de requisição",
        "Depois disso o visitante precisa voltar ao evento e dar ciência de novo."),
    "searches_per_address": Spec(
        "Buscas por endereço de origem (a cada 10 min)", 20, 1, 500, 1, "buscas", "Limites de requisição",
        "Protege contra varredura automatizada do acervo e o custo da inferência."),
    "downloads_per_address": Spec(
        "Downloads por endereço de origem (a cada 10 min)", 60, 1, 1000, 1, "downloads", "Limites de requisição",
        "Desestimula a extração automatizada das fotos."),
    "retention_months": Spec(
        "Prazo de retenção do acervo", 6, 1, 60, 1, "meses", "Retenção",
        "Por quanto tempo, após a data do evento, as fotos ficam disponíveis. Ao mudar, a expiração dos eventos "
        "ainda não expirados é recalculada na hora e o prazo exibido ao público também muda."),
    "event_deletion_days": Spec(
        "Prazo para desfazer a exclusão de um evento", 7, 1, 30, 1, "dias", "Retenção",
        "Ao excluir um evento, ele sai do site e os dados de reconhecimento facial são apagados na hora; as fotos "
        "esperam este prazo, durante o qual a exclusão pode ser desfeita. Depois, tudo é eliminado."),
    "contractor_identity_months": Spec(
        "Guarda do CPF e do nascimento do fotógrafo contratado", 36, 1, 120, 1, "meses", "Retenção",
        "Depois que as fotos enviadas pela conta temporária saem do acervo, por quanto tempo o CPF e a data de "
        "nascimento ainda ficam guardados, criptografados, antes de serem apagados. Valor "
        "PROVISÓRIO: o prazo definitivo é da área jurídica (pendência em aberto)."),
    "watermark_corner": Spec(
        "Posição da marca d'água", 1, 0, 1, 1, "", "Fotos e downloads",
        "Canto inferior em que a identificação \"CESMAC\" aparece nas fotos baixadas pelo visitante. "
        "As contas da equipe baixam sem marca d'água.", choices=((0, "Canto inferior esquerdo"), (1, "Canto inferior direito"))),
    "raw_max_mb": Spec(
        "Tamanho máximo de um arquivo RAW", 100, 25, 300, 5, "MB", "Fotos e downloads",
        "Vale nos eventos em que quem os gerencia ligou \"Aceitar arquivos RAW\" (no formulário do evento). As demais "
        "fotografias seguem com até 25 MB."),
    # 02/11/2026: provisional, until there are real videos of the marketing team (RF034, note 1).
    "max_video_mb": Spec(
        "Tamanho máximo de um vídeo", 1024, 100, MAX_VIDEO_MB, 100, "MB", "Vídeos",
        "Tamanho do arquivo enviado. Cada vídeo pode guardar o original e uma cópia convertida, então um limite "
        "maior gasta mais armazenamento."),
    "max_video_minutes": Spec(
        "Duração máxima de um vídeo", 10, 1, 60, 1, "minutos", "Vídeos",
        "Vídeos mais longos são recusados no envio. Quanto maior a duração, maior o tempo de conversão."),
}

DEFAULTS = {k: s.default for k, s in SPECS.items()}


class ParameterError(ValueError):
    pass


# Parameters whose good value depends on the model (each engine has its own similarity scale).
ENGINE_SCOPED = ("similarity_threshold", "institutional_threshold")


def default(db: Session, key: str) -> float:
    if key in ENGINE_SCOPED:
        try:
            return factory.active_spec(db).similarity_threshold
        except factory.FaceEngineUnavailable:
            return SPECS[key].default
    return SPECS[key].default


def get(db: Session, key: str):
    row = db.get(SystemParameter, key)
    value = row.value if row is not None else default(db, key)
    return int(value) if SPECS[key].integer else float(value)


def all_values(db: Session) -> dict[str, float]:
    return {k: get(db, k) for k in SPECS}


def retention_months(db: Session) -> int:
    return int(get(db, "retention_months"))


def institutional_threshold(db: Session) -> float:
    """The one used to mark: never below the public search's, even if that one was raised later."""
    return max(get(db, "institutional_threshold"), get(db, "similarity_threshold"))


def video_max_bytes(db: Session) -> int:
    return int(get(db, "max_video_mb")) * 1024 * 1024


def video_max_seconds(db: Session) -> int:
    return int(get(db, "max_video_minutes")) * 60


def raw_max_bytes(db: Session, event: Event) -> int | None:
    """None while the event does not accept RAW files (its own switch): the upload refuses them."""
    return int(get(db, "raw_max_mb")) * 1024 * 1024 if event.raw_enabled else None


def update(db: Session, admin: Account, values: dict[str, float], threshold_warning_acknowledged: bool) -> list[str]:
    """Validates every value first, then applies all of them (all or nothing). Returns the keys
    actually changed."""
    current = all_values(db)
    changes: dict[str, float] = {}
    for key, raw in values.items():
        spec = SPECS.get(key)
        if spec is None:
            raise ParameterError(f"Parâmetro desconhecido: {key}.")
        try:
            value = int(raw) if spec.integer else round(float(raw), 4)
        except (TypeError, ValueError):
            raise ParameterError(f"{spec.label}: informe um número.") from None
        if spec.integer and float(raw) != int(raw):
            raise ParameterError(f"{spec.label}: informe um número inteiro.")
        if spec.choices and value not in {v for v, _ in spec.choices}:
            raise ParameterError(f"{spec.label}: escolha uma das opções.")
        if not spec.minimum <= value <= spec.maximum:
            raise ParameterError(f"{spec.label}: o valor deve estar entre {_fmt(spec.minimum)} e {_fmt(spec.maximum)}.")
        if value != current[key]:
            changes[key] = value
    after = {**current, **changes}
    if "institutional_threshold" in changes and after["institutional_threshold"] < after["similarity_threshold"]:
        raise ParameterError("O limiar da marcação institucional não pode ser menor que o limiar da busca pública "
                             ": a busca no acervo inteiro tem de ser a mais exigente.")
    if "similarity_threshold" in changes and not threshold_warning_acknowledged:
        # The change must be preceded by the warning — enforced here, not only on screen.
        raise ParameterError("Confirme a advertência sobre o limiar de similaridade antes de salvar.")
    for key, value in changes.items():
        row = db.get(SystemParameter, key)
        if row is None:
            db.add(SystemParameter(key=key, value=value, updated_by=admin.id))
        else:
            row.value, row.updated_by = value, admin.id
        audit.record(db, "parameter.changed", admin.id, "parameter", key, previous=current[key], new=value)
    if "retention_months" in changes:
        _recompute_expiry(db, changes["retention_months"])
    if "institutional_threshold" in changes:  # the marks follow the new threshold
        from app.institutional.service import schedule_rescan_all
        schedule_rescan_all(db)
    db.commit()
    return list(changes)


def reset_engine_scoped(db: Session, admin: Account, previous: dict[str, float]) -> None:
    """After an engine swap: the model-dependent parameters go back to the values calibrated for
    the NEW model (a threshold tuned for one model means nothing for another). Logged like any
    other change; the caller commits."""
    for key in ENGINE_SCOPED:
        row = db.get(SystemParameter, key)
        if row is not None:
            db.delete(row)
        db.flush()
        new = get(db, key)
        if new != previous[key]:
            audit.record(db, "parameter.changed", admin.id, "parameter", key, previous=previous[key], new=new,
                         reason="troca do modelo de reconhecimento")


NOTICE_DAYS = 30  # photographers are warned at least 30 days before


def new_expiry(event_end: date, months: int, today: date) -> date:
    """The expiry an event gets under a new retention. A REDUCED retention never makes an event
    expire in less than 30 days from now: the change applies at once and the 30-day notice
    (30-day notice so the photographers can download the package) must both hold."""
    return max(dates.expiry_date(event_end, months), today + timedelta(days=NOTICE_DAYS))


def retention_impact(db: Session, months: int, today: date) -> dict:
    """What a new retention would do, shown to the administrator BEFORE saving."""
    changed = held = 0
    for event in db.scalars(select(Event).where(Event.status != EventStatus.EXPIRED)):
        target = dates.expiry_date(event.date_end, months)
        if target != event.expires_on:
            changed += 1
        if target < today + timedelta(days=NOTICE_DAYS):
            held += 1
    return {"events_changed": changed, "held_by_notice": held, "notice_days": NOTICE_DAYS}


def _recompute_expiry(db: Session, months: int) -> None:
    """Events not yet expired get the new expiry date immediately."""
    today = date.today()
    for event in db.scalars(select(Event).where(Event.status != EventStatus.EXPIRED)):
        target = new_expiry(event.date_end, months, today)
        if target != event.expires_on:
            event.expires_on = target
            event.expiry_notice_sent_at = None  # warn again, about the NEW date


def history(db: Session, limit: int = 50) -> list[AuditLog]:
    return db.scalars(select(AuditLog).where(AuditLog.action.in_(["parameter.changed", "face_engine.changed"]))
                      .order_by(AuditLog.id.desc()).limit(limit)).all()


def _fmt(v: float) -> str:
    return str(int(v)) if float(v).is_integer() else f"{v:.2f}".replace(".", ",")
