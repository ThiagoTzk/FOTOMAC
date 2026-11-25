"""The shape of an e-mail address, checked the same way everywhere (accounts, institutional people, removal
requests). Found in the test of 28/10/2026: "nome@@cesmac.edu.br" was accepted, because only the presence of an
"@" was checked. Since 31/10/2026 each broken rule has its own message, like the sign-up forms of big sites,
so the person knows what to fix. Whether the mailbox exists only the message itself proves (the activation link).

The rules are the practical subset that the big mail providers accept (RFC 5321/5322 allow more exotic forms,
like quoted names, that no institutional or personal mailbox uses). The same rules, with the same messages,
are in frontend/src/auth/email-rules.ts.
"""
import re

LOCAL_MAX = 64          # before the "@" (RFC 5321)
LABEL_MAX = 63          # each part of the domain between dots
_LOCAL_CHARS = re.compile(r"^[A-Za-z0-9._%+'-]+$")
_DOMAIN_CHARS = re.compile(r"^[A-Za-z0-9.-]+$")
_TLD = re.compile(r"^[A-Za-z]{2,}$")


def problem(email: str, max_length: int = 254) -> str | None:
    """What is wrong with the address, in words for the person; None when it is well formed."""
    if not email:
        return "Informe o e-mail."
    if any(c.isspace() for c in email):
        return "O e-mail não pode ter espaços."
    if len(email) > max_length:
        return f"O e-mail pode ter até {max_length} caracteres."
    ats = email.count("@")
    if ats == 0:
        return "Falta o @ no e-mail (exemplo: nome@cesmac.edu.br)."
    if ats > 1:
        return "O e-mail tem mais de um @. Use apenas um."
    local, domain = email.split("@")
    if not local:
        return "Falta o nome antes do @ (exemplo: nome@cesmac.edu.br)."
    if len(local) > LOCAL_MAX:
        return f"A parte antes do @ pode ter até {LOCAL_MAX} caracteres."
    if not _LOCAL_CHARS.match(local):
        return "Antes do @, use só letras sem acento, números e os sinais . _ - +"
    if local.startswith(".") or local.endswith("."):
        return "A parte antes do @ não pode começar nem terminar com ponto."
    if ".." in email:
        return "O e-mail não pode ter dois pontos seguidos."
    if not domain:
        return "Falta o domínio depois do @ (exemplo: cesmac.edu.br)."
    if not _DOMAIN_CHARS.match(domain):
        return "Depois do @, use só letras sem acento, números, hífen e ponto."
    if domain.startswith(".") or domain.endswith("."):
        return "O domínio não pode começar nem terminar com ponto."
    labels = domain.split(".")
    if len(labels) < 2:
        return "O domínio precisa de um ponto (exemplo: cesmac.edu.br)."
    if any(len(label) > LABEL_MAX for label in labels):
        return f"Cada parte do domínio pode ter até {LABEL_MAX} caracteres."
    if any(label.startswith("-") or label.endswith("-") for label in labels):
        return "Nenhuma parte do domínio pode começar ou terminar com hífen."
    if not _TLD.match(labels[-1]):
        return "O final do domínio precisa ter ao menos 2 letras (exemplo: .br, .com)."
    return None


def valid(email: str, max_length: int = 254) -> bool:
    return problem(email, max_length) is None
