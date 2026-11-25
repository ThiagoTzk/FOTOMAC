"""The authorization term an institutional person signs.

Versioned like the visitor's notice: changing a word makes a new version, and every signature keeps
the version it signed. PROVISIONAL text, written with the law at hand (Lei nº 13.709/2018); it must be
validated by CESMAC's legal area before production.
"""
from __future__ import annotations

TERM_VERSION = "2026-10-v4"
TERM_TITLE = "Termo de autorização de uso de imagem, de reconhecimento facial e de divulgação (pessoa institucional)"

# v2 (24/10/2026) added the press use; v3 (24/10/2026) rewrote
# the whole text as ONE term, one finalidade per section, the press and journalistic use stated plainly.
# A consent covers "finalidades determinadas" (LGPD, Art. 8º, § 4º) and the shared use must be informed
# (Art. 9º, V): a person who signed v1 never agreed to the press use, so the named download needs v2 or later.
# v4 (31/10/2026): section 2 says the team sees the reference photos to confirm the marks (Art. 9º), and the
# text lost its dashes (they read like text written by an AI).
PRESS_VERSIONS = frozenset({"2026-10-v2", "2026-10-v3", "2026-10-v4"})

# A paragraph that is only "N. Title" (short, no final period) is a section title: the signing page and
# the PDF show it in bold. The text signed — and hashed — is the same list either way.
HEADING_MAX = 60


def is_heading(paragraph: str) -> bool:
    head, _, rest = paragraph.partition(". ")
    return head.isdigit() and 0 < len(rest) <= HEADING_MAX and "." not in rest


def allows_press(version: str | None) -> bool:
    """Whether the term this person signed allows sending the photos to the press identified by name."""
    return version in PRESS_VERSIONS


def paragraphs(full_name: str, position: str, unit: str | None) -> list[str]:
    who = f"{full_name}, {position}" + (f" ({unit})" if unit else "")
    return [
        f"Eu, {who}, ao assinar este termo, autorizo o Centro Universitário CESMAC, responsável pelo sistema "
        "FOTOMAC, a usar a minha imagem e os meus dados nas finalidades descritas abaixo. Cada finalidade está "
        "explicada em uma seção própria, para que eu saiba exatamente com o que estou concordando. Uma única "
        "assinatura vale para todas elas.",

        "1. Reconhecimento facial",
        "As fotografias de referência do meu rosto, mostradas nesta página, são usadas para que o FOTOMAC me "
        "localize nas fotografias publicadas dos eventos da instituição. A partir delas, o sistema calcula um "
        "vetor facial, que é dado pessoal sensível de natureza biométrica (LGPD, Art. 5º, II), e o compara com os "
        "rostos de todas as fotografias publicadas no FOTOMAC, inclusive as publicadas depois desta autorização. "
        "É a única busca no acervo inteiro que o sistema faz, e só para quem a autorizou.",

        "2. Consulta pela equipe",
        "As fotografias em que eu for localizado ficam disponíveis para consulta somente pelas equipes de "
        "fotografia e de marketing e pela administração do FOTOMAC. Antes de qualquer uso, uma pessoa da equipe "
        "confere se sou eu de fato; o que for marcado por engano é descartado. Para essa conferência, essas mesmas "
        "pessoas veem também as minhas fotografias de referência, somente dentro do sistema. Cada consulta fica "
        "registrada.",

        "3. Uso e compartilhamento das minhas imagens",
        "Autorizo, a título gratuito, que as fotografias em que eu for identificado sejam usadas e compartilhadas "
        "para a comunicação institucional do CESMAC e para fins jornalísticos, o que inclui:",
        "• a publicação nos canais do CESMAC, como site, redes sociais, revistas, informativos e materiais impressos;",
        "• o envio a jornais, revistas, sites de notícias, emissoras de rádio e de televisão e demais veículos de "
        "imprensa, para matérias e reportagens;",
        "• o envio a parceiros e a instituições com as quais o CESMAC realize eventos, projetos ou divulgação conjunta.",
        "Nesses envios, a fotografia pode levar a minha identificação (nome e cargo) no nome do arquivo e nos "
        "dados da própria fotografia, para que eu seja corretamente identificado na publicação. Cada envio desse "
        "tipo fica registrado no sistema.",

        "4. Limites desta autorização",
        "O FOTOMAC não mostra nada ao público por causa desta autorização: nenhum visitante encontra as minhas "
        "fotografias pelo meu rosto. As fotografias não serão usadas em contexto que ofenda a minha honra ou a "
        "minha imagem, nem vendidas ou cedidas para publicidade de produtos de terceiros.",

        "5. Prazo",
        "Esta autorização vale enquanto eu exercer função de representação institucional no CESMAC ou até eu "
        "revogá-la, o que acontecer primeiro. Quando eu deixar a função, a administração encerra a autorização.",

        "6. Meus direitos",
        "Esta autorização é livre e específica para as finalidades acima, e o tratamento do dado biométrico tem "
        "como base o meu consentimento específico e destacado (LGPD, Art. 11, I). Posso não assinar: nesse caso, "
        "não sou cadastrado no FOTOMAC, e nada mais muda para mim (LGPD, Art. 18, VIII). Posso revogar esta "
        "autorização a qualquer momento, sem justificativa e sem custo, pelo link que recebo por e-mail ao "
        "assinar (LGPD, Art. 8º, § 5º). Com a revogação, as fotografias de referência, o vetor facial e todas as "
        "marcações são eliminados, e as minhas fotografias deixam de ser enviadas com o meu nome. A revogação "
        "não desfaz publicações feitas antes dela por veículos de imprensa ou parceiros. Também posso pedir, a "
        "qualquer momento, a confirmação e o acesso aos meus dados, a correção deles e a informação sobre com "
        "quem foram compartilhados (LGPD, Art. 18).",

        "7. Comprovação",
        "Para comprovar esta autorização (LGPD, Art. 8º, § 2º), o CESMAC guarda este termo, a minha assinatura, "
        "a data e a hora, o endereço de rede (IP) e o navegador usados, inclusive depois de uma eventual "
        "revogação.",

        "Ao assinar, declaro que li este termo por inteiro, que entendi cada uma das finalidades acima e que "
        "concordo com todas elas.",
    ]
