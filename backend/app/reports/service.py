"""Operations report (RF024 note 7) and compliance export (RNF14), for the administrator.

Everything comes from records that already exist: the append-only operations log (audit_log), the consent records
of the visitors and the institutional people. Nothing new about people is collected to build it.

What the export contains (RNF14): the operations log, the institutional queries (account that searched and person
searched), the visitors' consent records, the institutional authorizations, the downloads for institutional
publicity, the public searches counted per day and event (anonymous) and the atypical-use alerts.

What it never contains (RF024 notes 3 and 6; LGPD Art. 6, III): any personal data of a visitor (the public search
is recorded without identification, the removal requester's e-mail is not in the log), and no image, frame or face
vector, in any file.
"""
from __future__ import annotations

import csv
import io
import json
import uuid
import zipfile
from collections import Counter, defaultdict
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import audit
from app.accounts.service import ROLE_LABEL
from app.db.models import Account, AuditLog, ConsentRecord, Event, InstitutionalPerson
from app.security.atypical import ACTION as ATYPICAL
from app.security.atypical import CAPTURE_FAILED

TZ = ZoneInfo("America/Maceio")   # the CESMAC's time, in every date of the report
MAX_ALERTS_ON_SCREEN = 50

GROUPS = {   # the first part of the action code -> the area, in Portuguese, for the report reader
    "account": "Contas", "auth": "Autenticação", "event": "Eventos", "image": "Fotos", "video": "Vídeos",
    "package": "Pacotes de download", "institutional": "Pessoas institucionais", "public": "Área pública (anônimo)",
    "removal": "Pedidos de remoção", "calibration": "Teste de precisão", "parameter": "Parâmetros",
    "face_engine": "Motor de reconhecimento", "reindex": "Reindexação", "theme": "Temas", "support": "Suporte",
    "usage": "Uso atípico", "report": "Relatórios",
}
INSTITUTIONAL_QUERIES = ("institutional.query", "institutional.download", "institutional.marks_confirmed",
                         "institutional.marks_rejected")
AUTHORIZATIONS = ("institutional.authorized", "institutional.refused", "institutional.revocation_requested",
                  "institutional.revoked", "institutional.email_changed", "institutional.expired")
PUBLICITY = ("image.download", "video.download")
KIND_LABEL = {"searches": "Buscas demais do mesmo endereço", "liveness": "Provas de vida reprovadas em sequência"}
STATUS_LABEL = {"awaiting": "Aguardando autorização", "active": "Autorizada", "revoked": "Revogada"}


class ReportError(ValueError):
    pass


def period(start: date | None, end: date | None) -> tuple[date, date]:
    end = end or datetime.now(TZ).date()
    start = start or date(2026, 1, 1)   # "todo o período": the system did not exist before 2026
    if start > end:
        raise ReportError("A data inicial não pode ser depois da final.")
    return start, end


def _bounds(start: date, end: date) -> tuple[datetime, datetime]:
    """From the first moment of `start` to the last of `end`, in the CESMAC's time."""
    return datetime.combine(start, time.min, TZ), datetime.combine(end + timedelta(days=1), time.min, TZ)


def _local(moment: datetime) -> str:
    return moment.astimezone(TZ).strftime("%d/%m/%Y %H:%M:%S")


def _rows(db: Session, start: date, end: date, actions: tuple[str, ...] | None = None) -> list[AuditLog]:
    lo, hi = _bounds(start, end)
    q = select(AuditLog).where(AuditLog.occurred_at >= lo, AuditLog.occurred_at < hi)
    if actions is not None:
        q = q.where(AuditLog.action.in_(actions))
    return list(db.scalars(q.order_by(AuditLog.occurred_at, AuditLog.id)))


def _publicity(rows: list[AuditLog]) -> list[AuditLog]:
    return [r for r in rows if r.action in PUBLICITY and (r.details or {}).get("publicity")]


def summary(db: Session, start: date | None, end: date | None) -> dict:
    """The numbers of the period, for the screen. All of them are counts: no person appears here."""
    start, end = period(start, end)
    rows = _rows(db, start, end)
    actions = Counter(r.action for r in rows)
    searches = [r for r in rows if r.action == "public.search"]
    outcomes = Counter((r.details or {}).get("outcome", "found") for r in searches)
    found = sum(1 for r in searches if "outcome" not in (r.details or {}) and (r.details or {}).get("found", 0) > 0)
    lo, hi = _bounds(start, end)
    consents = db.scalar(select(func.count()).select_from(ConsentRecord).where(
        ConsentRecord.accepted_at >= lo, ConsentRecord.accepted_at < hi)) or 0
    alerts = [r for r in rows if r.action == ATYPICAL]
    names = _event_names(db, {r.target_id for r in alerts})
    return {
        "start": start.isoformat(), "end": end.isoformat(),
        "operations": len(rows),
        "public": {
            "searches": len(searches), "found": found, "no_result": outcomes["found"] - found,
            # Refused by the final search, or the capture ended by wrong movements before any search (11/11/2026).
            "liveness_refused": outcomes["liveness"] + outcomes["consistency"] + actions[CAPTURE_FAILED],
            "other_refused": len(searches) - outcomes["found"] - outcomes["liveness"] - outcomes["consistency"],
            "downloads": actions["public.download"] + actions["public.video_download"],
        },
        "consents": consents,
        "institutional_queries": sum(actions[a] for a in INSTITUTIONAL_QUERIES),
        "authorizations": {"authorized": actions["institutional.authorized"], "revoked": actions["institutional.revoked"]},
        "publicity_downloads": len(_publicity(rows)),
        "alerts": [{"at": r.occurred_at.isoformat(), "kind": r.details.get("kind"),
                    "label": KIND_LABEL.get(r.details.get("kind"), r.details.get("kind")),
                    "count": r.details.get("count"), "minutes": r.details.get("minutes"),
                    "event": names.get(r.target_id)} for r in reversed(alerts)][:MAX_ALERTS_ON_SCREEN],
        "alerts_total": len(alerts),
    }


# ------------------------------------------------------------------ export

def _event_names(db: Session, ids: set) -> dict[str, str]:
    valid = []
    for i in ids:
        try:
            valid.append(uuid.UUID(str(i)))
        except (ValueError, TypeError):
            pass
    return {str(e.id): e.name for e in db.scalars(select(Event).where(Event.id.in_(valid)))} if valid else {}


def _who(r: AuditLog, accounts: dict) -> tuple[str, str]:
    """Name and profile of whoever did it. Without an account: the anonymous visitor, the institutional person by
    the e-mailed link, or the system itself (expiry, automatic deletion, the atypical-use watcher)."""
    if r.actor_account_id:
        a = accounts.get(r.actor_account_id)
        return (a.full_name, ROLE_LABEL[a.role]) if a else ("Conta removida", "")
    if r.action.startswith(("public.", "removal.")):
        return "Visitante (anônimo)", "Visitante"
    if r.action in AUTHORIZATIONS[:-1]:
        return "Pessoa institucional (pelo link do e-mail)", "Pessoa institucional"
    if r.action.startswith("auth."):
        return "Não identificado", ""
    return "Sistema", ""


def _target(r: AuditLog, events: dict, people: dict, accounts_by_id: dict) -> str:
    """The name of what the operation was about, when it still exists (an event, a person, an account)."""
    tid = r.target_id or ""
    if r.target_type == "event":
        return events.get(tid, "")
    if r.target_type == "institutional_person":
        return people.get(tid, "")
    if r.target_type == "account":
        a = accounts_by_id.get(tid)
        return a.full_name if a else ""
    return events.get(str((r.details or {}).get("event_id", "")), "")


def _csv(header: list[str], rows: list[list]) -> bytes:
    """Semicolon and a BOM: opens with the accents and the columns right in a spreadsheet in Portuguese."""
    out = io.StringIO()
    writer = csv.writer(out, delimiter=";", lineterminator="\r\n")
    writer.writerow(header)
    writer.writerows(rows)
    return ("﻿" + out.getvalue()).encode("utf-8")


def export_zip(db: Session, admin: Account, start: date | None, end: date | None) -> tuple[bytes, str]:
    start, end = period(start, end)
    rows = _rows(db, start, end)
    accounts = {a.id: a for a in db.scalars(select(Account))}
    accounts_by_id = {str(k): v for k, v in accounts.items()}
    event_ids = {r.target_id for r in rows if r.target_type == "event"} | {
        str((r.details or {}).get("event_id")) for r in rows if (r.details or {}).get("event_id")}
    events = _event_names(db, event_ids)
    lo, hi = _bounds(start, end)
    consents = list(db.scalars(select(ConsentRecord).where(ConsentRecord.accepted_at >= lo, ConsentRecord.accepted_at < hi)
                               .order_by(ConsentRecord.accepted_at)))
    events.update(_event_names(db, {c.event_id for c in consents if c.event_id}))
    people = {str(p.id): p for p in db.scalars(select(InstitutionalPerson))}
    people_names = {k: p.full_name for k, p in people.items()}

    def base(r: AuditLog) -> list:
        name, role = _who(r, accounts)
        return [_local(r.occurred_at), name, role]

    def details(r: AuditLog) -> str:
        return json.dumps(r.details or {}, ensure_ascii=False, sort_keys=True)

    files = {}
    files["1-operacoes.csv"] = _csv(
        ["Data e hora", "Quem", "Perfil", "Área", "Operação (código)", "Sobre", "Tipo do alvo", "Identificador", "Detalhes"],
        [base(r) + [GROUPS.get(r.action.split(".")[0], r.action.split(".")[0]), r.action,
                    _target(r, events, people_names, accounts_by_id), r.target_type or "", r.target_id or "", details(r)]
         for r in rows])
    files["2-consultas-institucionais.csv"] = _csv(
        ["Data e hora", "Conta que consultou", "Perfil", "Pessoa consultada", "Operação (código)", "Detalhes"],
        [base(r) + [people_names.get(r.target_id or "", "Cadastro removido"), r.action, details(r)]
         for r in rows if r.action in INSTITUTIONAL_QUERIES])
    files["3-autorizacoes-institucionais.csv"] = _csv(
        ["Data e hora", "Quem", "Perfil", "Pessoa", "E-mail da pessoa", "Situação atual", "Operação (código)",
         "Versão do termo", "Resumo SHA-256 do documento assinado"],
        [base(r) + [people_names.get(r.target_id or "", "Cadastro removido"),
                    people[r.target_id].email if r.target_id in people else "",
                    STATUS_LABEL.get(people[r.target_id].status.value, "") if r.target_id in people else "",
                    r.action, (r.details or {}).get("term_version", ""), (r.details or {}).get("document_sha256", "")]
         for r in rows if r.action in AUTHORIZATIONS])
    files["4-ciencia-dos-visitantes.csv"] = _csv(
        ["Data e hora", "Evento", "Versão do texto de ciência"],
        [[_local(c.accepted_at), events.get(str(c.event_id), "Evento excluído") if c.event_id else "Evento excluído",
          c.text_version] for c in consents])
    files["5-downloads-para-divulgacao.csv"] = _csv(
        ["Data e hora", "Conta", "Perfil", "Mídia", "Evento", "Identificador da mídia"],
        [base(r) + ["Foto" if r.action == "image.download" else "Vídeo",
                    events.get(str((r.details or {}).get("event_id", "")), ""), r.target_id or ""]
         for r in _publicity(rows)])
    per_day: dict[tuple[str, str], Counter] = defaultdict(Counter)
    for r in rows:
        if not r.action.startswith("public.") and r.action != "removal.request":
            continue
        event_id = r.target_id if r.target_type == "event" else str((r.details or {}).get("event_id", ""))
        c = per_day[(r.occurred_at.astimezone(TZ).strftime("%d/%m/%Y"), events.get(event_id, "Evento excluído"))]
        if r.action == "public.search":
            outcome = (r.details or {}).get("outcome")
            c["buscas"] += 1
            if outcome in ("liveness", "consistency"):
                c["prova de vida reprovada"] += 1
            elif outcome:
                c["outras recusas"] += 1
            elif (r.details or {}).get("found", 0) > 0:
                c["com resultado"] += 1
            else:
                c["sem resultado"] += 1
        elif r.action == CAPTURE_FAILED:   # ended by wrong movements before any search
            c["prova de vida reprovada"] += 1
        elif r.action in ("public.download", "public.video_download"):
            c["downloads"] += 1
        elif r.action == "public.video_view":
            c["vídeos assistidos"] += 1
        elif r.action == "removal.request":
            c["pedidos de remoção"] += 1
    cols = ["buscas", "com resultado", "sem resultado", "prova de vida reprovada", "outras recusas", "downloads",
            "vídeos assistidos", "pedidos de remoção"]
    files["6-consultas-publicas-por-dia.csv"] = _csv(
        ["Dia", "Evento", *[c.capitalize() for c in cols]],
        [[day, event, *[per_day[(day, event)][c] for c in cols]] for day, event in per_day])
    files["7-uso-atipico.csv"] = _csv(
        ["Data e hora", "Sinal", "Quantidade", "Em minutos", "Evento"],
        [[_local(r.occurred_at), KIND_LABEL.get((r.details or {}).get("kind"), (r.details or {}).get("kind")),
          (r.details or {}).get("count"), (r.details or {}).get("minutes"), events.get(r.target_id or "", "")]
         for r in rows if r.action == ATYPICAL])
    generated = datetime.now(TZ)
    readme = f"""RELATÓRIO DE OPERAÇÕES E CONFORMIDADE - FOTOMAC
Período: {start.strftime('%d/%m/%Y')} a {end.strftime('%d/%m/%Y')} (horário de Maceió)
Gerado em {generated.strftime('%d/%m/%Y às %H:%M')} por {admin.full_name} (administrador).

Requisitos atendidos: RF024 (registro de operações e controle de uso atípico) e RNF14 (exportação para a
demonstração de conformidade e o relatório de impacto, Art. 38 da LGPD).

Arquivos (planilhas CSV, separadas por ponto e vírgula, abrem no Excel ou no Google Planilhas):
1-operacoes.csv                    todas as operações registradas no período ({len(rows)}). O registro não pode ser
                                   alterado nem apagado por nenhum perfil, nem pelo administrador.
2-consultas-institucionais.csv     quem consultou cada pessoa institucional no acervo, e o que fez com o resultado.
3-autorizacoes-institucionais.csv  autorizações, recusas, trocas de e-mail e revogações das pessoas institucionais,
                                   com a versão do termo e o resumo (SHA-256) do documento assinado.
4-ciencia-dos-visitantes.csv       cada manifestação de ciência do aviso de uso de imagem, antes da busca. Sem
                                   identificação: só o evento, o momento e a versão do texto.
5-downloads-para-divulgacao.csv    downloads feitos pela equipe de marketing, para divulgação institucional, de
                                   mídias de outros autores (RF030).
6-consultas-publicas-por-dia.csv   buscas e downloads da área pública, contados por dia e evento, sem identificar
                                   ninguém. "Prova de vida reprovada" inclui as capturas encerradas por movimentos
                                   errados, que não chegam a virar busca.
7-uso-atipico.csv                  alertas automáticos: buscas demais do mesmo endereço (bloqueadas pelo limite) e
                                   provas de vida reprovadas em sequência.

Dados pessoais (LGPD): nenhum arquivo traz dado pessoal de visitante, imagem, quadro da câmera ou vetor facial.
O endereço de rede usado para detectar o uso atípico fica só na memória do servidor, por poucos minutos, e não é
gravado. Os arquivos 1, 2, 3 e 5 trazem nomes e e-mails da equipe e das pessoas institucionais, e o arquivo 1 traz
também o endereço de rede (IP) da pessoa institucional no momento em que assinou, guardado como prova da assinatura
eletrônica (RF020). Guarde este relatório com o mesmo cuidado do sistema e não o compartilhe fora de quem precisa dele.
"""
    files["LEIA-ME.txt"] = readme.encode("utf-8")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data)
    # The export is an operation too: who took the records out, and of which period.
    audit.record(db, "report.exported", admin.id, None, None, start=start.isoformat(), end=end.isoformat(),
                 operations=len(rows))
    db.commit()
    name = f"FOTOMAC - registros {start.strftime('%d-%m-%Y')} a {end.strftime('%d-%m-%Y')}.zip"
    return buffer.getvalue(), name
