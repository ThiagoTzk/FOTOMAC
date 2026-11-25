# FOTOMAC: interface (Expo)

Telas do FOTOMAC em Expo (React Native + React Native Web) com Expo Router: **um só código** para o site
(computador, tablet e celular) e para o aplicativo Android e iPhone.

A instalação, a forma de rodar e os testes estão no [README principal](../README.md); a organização e as
regras do projeto, no [CLAUDE.md](../CLAUDE.md).

- `src/app/`: rotas e telas. Área pública em `/` (início, eventos, página do evento com a busca facial,
  como funciona, privacidade, créditos); equipe em `/login` e no grupo `(painel)`.
- `src/api/`: chamadas à API (`/api/v1`); no site a sessão vai em cookie HttpOnly, no app em cabeçalho.
- `src/components/`: `visitor/` (público), `panel/` (painel), `admin/`, `capture/` (captura guiada com
  prova de vida), `map/`, `signature/` e outros.
- `src/theme/`: cores, fontes e acessibilidade.
- Arquivos `.native.ts(x)`: versão do aplicativo; sem o sufixo, versão do site.
- `e2e/`: testes de navegador com Playwright.
- `AGENTS.md`: orientações da Expo para assistentes de IA.
