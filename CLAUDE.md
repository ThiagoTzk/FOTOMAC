# FOTOMAC: instruções para quem trabalha no código (pessoas e IA)

O FOTOMAC é a plataforma do Centro Universitário CESMAC para publicar o acervo de fotografias e vídeos
dos seus eventos. A galeria de cada evento é **privada**: a pessoa retratada encontra as próprias imagens
por **reconhecimento facial**, numa captura guiada com prova de vida, e recebe só as mídias em que aparece.
A equipe (fotógrafos, marketing, fotógrafo contratado e administração) cadastra eventos, envia, confere e
publica as mídias pelo painel.

Rosto e vetor facial são **dado pessoal sensível** (LGPD, Lei 13.709/2018, Art. 5º, II). Toda mudança no
sistema começa pela pergunta: que dado pessoal isso toca, com que finalidade, por quanto tempo, e quem
pode ver? As regras da seção 5 não são opcionais.

## 1. Pilha

| Parte | Tecnologia |
|---|---|
| API | Python 3.12, FastAPI, SQLAlchemy 2 e Alembic (`backend/`) |
| Banco | PostgreSQL 17 com as extensões `vector` (pgvector), `unaccent` e `pg_trgm` |
| Arquivos | SeaweedFS pelo protocolo S3 (boto3), bucket privado |
| Reconhecimento facial | OpenCV com YuNet (detecção) e SFace (vetor de 128 números), em CPU |
| Vídeo e metadados | FFmpeg; ExifTool (retira GPS e grava os créditos nos arquivos) |
| Site e aplicativo | Expo (React Native + React Native Web) com Expo Router (`frontend/`), **um só código** para web, Android e iPhone |
| Mapa do evento | MapLibre com o mapa do Brasil servido pela própria API (nenhum serviço externo de mapas) |

## 2. Onde está cada coisa

```
backend/
  app/
    main.py             liga rotas, banco, modelo facial e trabalhador em segundo plano
    config.py           TODA configuração vem daqui (variáveis FOTOMAC_*, arquivo backend/.env)
    parameters.py       limites que o administrador muda no painel (com padrões de fábrica)
    api/                rotas HTTP (prefixo /api/v1); só validam entrada e chamam os serviços
    <domínio>/          regras de negócio: accounts, auth, events, images, videos, public,
                        institutional, themes, support, reports, calibration, packages, geo
    face/               PORTA e ADAPTADORES do reconhecimento facial (port.py, factory.py)
    storage/            PORTA e ADAPTADOR de arquivos (S3/SeaweedFS)
    notifications/      PORTA e ADAPTADORES de e-mail (outbox em desenvolvimento, smtp em produção)
    indexing/worker.py  fila em segundo plano: vetores, conversão de vídeo, pacotes, remoções, expiração
    security/           links assinados, limites de requisição, uso atípico
    audit.py            registro de operações (só acrescenta; o banco recusa alterar ou apagar)
    db/models.py        tabelas
  migrations/           Alembic (uma migração por mudança de banco; nunca editar uma já aplicada)
  tests/                pytest (banco fotomac_test; cada teste roda numa transação desfeita no fim)
  scripts/              create_first_admin.py, create_account.py, send_test_email.py, limpeza de testes
frontend/
  src/app/              telas; o caminho do arquivo é o endereço (Expo Router)
    index.tsx, explorar.tsx, evento/[id].tsx, como-funciona.tsx, privacidade.tsx, creditos.tsx   área pública
    login.tsx, primeiro-acesso.tsx, recuperar-senha.tsx ...                                     entrada da equipe
    (painel)/           área da equipe; o layout confere a sessão
  src/api/client.ts     ÚNICA porta para a API (cookie no site, cabeçalho de sessão no app)
  src/components/       visitor/ (público), panel/ (painel), admin/, capture/ (captura guiada), ...
  src/theme/tokens.ts   cores, fontes e espaçamentos; não espalhar valores soltos pelas telas
  e2e/                  testes de navegador (Playwright, Node)
  AGENTS.md             orientações da Expo para IA: ler antes de mexer em API do Expo ou React Native
infra/
  setup_local.sh        prepara o ambiente de DESENVOLVIMENTO (banco, credenciais, modelos faciais)
  seaweedfs.sh          liga e desliga o SeaweedFS local
  build_map.sh          gera o mapa do Brasil (backend/data/map/brasil.pmtiles)
```

Arquivo com `.native.ts(x)` é a versão do app (Android e iPhone); sem o sufixo, a do site. Os dois
precisam ter a mesma interface exportada.

## 3. Rodar e testar (desenvolvimento)

```bash
infra/setup_local.sh                       # uma vez por máquina (PostgreSQL 17 via Homebrew no macOS)
cd backend && python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/alembic upgrade head
cd frontend && npm ci                    # respeita as versões travadas

infra/seaweedfs.sh start
cd backend && .venv/bin/uvicorn app.main:app --port 8000      # API; documentação em /api/v1/docs
cd frontend && npx expo start --web --port 8081                 # site em http://localhost:8081
cd backend && .venv/bin/python scripts/create_first_admin.py --email voce@cesmac.edu.br
```

Testes, sempre antes de dizer que algo está pronto:

```bash
cd backend && .venv/bin/pytest              # regras de negócio e de privacidade (banco fotomac_test)
cd frontend && npm run typecheck            # tipos do site e do app
cd frontend && node e2e/<roteiro>.e2e.mjs   # navegador de verdade; API e site ligados (ver o topo de cada arquivo)
cd backend && .venv/bin/python scripts/cleanup_e2e.py --apply   # apaga o que os testes de navegador criaram
```

Os testes de navegador rodam no Chromium: comportamento do Safari e do iPhone precisa ser conferido no
aparelho. Os testes usam só retratos da NASA em domínio público e imagens sintéticas
(`backend/tests/fixtures/README.md`): nunca colocar foto de evento ou de pessoa real nos testes.

**Versões travadas.** Tudo roda nas versões testadas (tabela no README): Python em
`backend/requirements.txt` e `backend/.python-version`, site e app em `frontend/package.json` e
`frontend/package-lock.json`, sem `^` nem `~`. Nunca rodar `npm update`, `pip install -U` ou `brew upgrade` no
meio de uma tarefa: atualizar é uma tarefa própria, com todos os testes depois. Pacote novo do Expo entra com
`npx expo install <pacote>` e depois tem a versão fixada à mão no `package.json`.

## 4. Arquitetura que deve ser respeitada

- **Portas e adaptadores.** O sistema fala com três serviços externos por uma interface própria:
  reconhecimento facial (`face/port.py`), arquivos (`storage/port.py`) e e-mail (`notifications/port.py`).
  Trocar o motor facial, o armazenamento ou o servidor de e-mail é escrever um adaptador novo e
  registrá-lo na fábrica (`factory.py` de cada pasta); nada mais muda.
  - Motor facial: cada motor entra no catálogo `ENGINES` de `face/factory.py` com o limiar calibrado
    para ele. O administrador troca no painel; vetores de motores diferentes não se comparam, então a
    troca exige **reindexação** (o painel conduz) e nunca acontece sozinha.
  - E-mail: `send()` para mensagens com link de que a pessoa precisa (falha avisa quem agiu);
    `notify()` para mensagens que só informam (falha vai para o log e não interrompe nada).
- **A permissão é conferida no servidor**, sempre. Esconder um botão na tela não é controle de acesso.
- **Rotas finas, serviços com a regra.** A rota valida e traduz erros; a regra mora no serviço do domínio.
- **Configuração só por `config.py`.** Mudar de máquina ou ir para produção é mudar `backend/.env`,
  nunca o código. Segredos nunca vão para o repositório.
- **Banco só por migração Alembic.** Regra de privacidade que o banco consegue garantir (por exemplo,
  auditoria só acrescenta) fica também no banco, não só no código.
- **Trabalho pesado vai para a fila** (`indexing/worker.py`), não para dentro da requisição.
- **Erros ao usuário em português e sem detalhe interno**; o detalhe vai para o log.

## 5. Regras de negócio e de privacidade que não podem ser quebradas

1. **Galeria privada.** Não existe navegação pelo acervo de um evento nem busca no acervo inteiro. O
   visitante vê só o que a própria busca encontrou, por links assinados que expiram.
2. **Busca só com ciência e só no evento.** O servidor recusa a busca sem o "Estou ciente" do aviso
   de uso de imagem daquele evento (nada pré-marcado).
3. **Captura do visitante nunca é gravada.** Os quadros servem à prova de vida e à comparação, na
   memória, e são descartados. Nada em disco, log ou cache.
4. **Prova de vida no servidor.** A ordem dos movimentos é sorteada pelo servidor e vale uma vez.
5. **Só mídia publicada é indexada.** Material descartado ou em conferência nunca gera vetor.
6. **Vetor facial em tabela própria, nunca em log**, e apagado junto com a mídia.
7. **Remoção a pedido:** a mídia sai das buscas na hora e é excluída em até 72 horas, mesmo sem ação
   do fotógrafo e mesmo sem servidor de e-mail. O contato de quem pediu é apagado ao concluir.
8. **Fim do prazo de retenção:** o evento expira e todas as mídias, pacotes e vetores são eliminados.
9. **Marca d'água só no download do visitante**, uma mídia por vez. A equipe baixa sem marca.
10. **Localização (GPS) sempre retirada** das mídias no envio.
11. **Contas nunca são excluídas**, só desativadas, suspensas ou expiram: o histórico de quem fez o
    quê é preservado. Toda mudança fica no registro de operações.
12. **E-mail institucional (@cesmac.edu.br, com subdomínios)** para administrador, fotógrafo e
    marketing; só o fotógrafo contratado usa e-mail pessoal. Conta sem senha até o titular definir
    pelo link de uso único.
13. **Fotógrafo contratado:** conta com prazo, ligada a um evento; suas mídias só são publicadas
    depois da aprovação do administrador; CPF e data de nascimento ficam cifrados.
14. **Crianças:** evento com crianças só com a declaração da autorização dos responsáveis; o borrão
    de rostos altera o próprio arquivo e o rosto borrado não gera vetor.
15. **Pessoa institucional:** só depois de assinar o termo na tela; a revogação apaga na hora as fotos
    de referência, os vetores e as marcações.
16. **O limiar de similaridade nunca muda sozinho.** Limiar mais baixo traz mais fotos da pessoa e
    também mais fotos de outras pessoas; quem decide é o administrador, com o teste de precisão.

## 6. Convenções

- Código, nomes de arquivos, variáveis e mensagens de commit em **inglês**; textos de tela em
  **português do Brasil**.
- Comentário explica o **porquê** de uma decisão, não repete o que o código diz.
- Textos de tela sem travessão (—); frases curtas, linguagem simples.
- Toda tela tem caminho de volta ("Voltar" no topo, à esquerda).
- O site precisa caber de celulares pequenos (320 px) a computadores, e funcionar no app.
- Não colocar nome, e-mail, telefone ou documento de pessoa real em código, comentário ou teste.
- Nunca versionar: `backend/.env`, `infra/seaweedfs/s3.json`, `backend/outbox/`, `backend/models/`,
  `backend/data/map/`, `backend/samples/`, capturas de testes (ver `.gitignore`).

## 7. Produção (checklist)

- HTTPS com certificado; `FOTOMAC_COOKIE_SECURE=true`; `FOTOMAC_FRONTEND_URL` e
  `FOTOMAC_CORS_ORIGINS` com o domínio definitivo.
- E-mail: `FOTOMAC_EMAIL_SENDER=smtp` e as variáveis `FOTOMAC_SMTP_*` e `FOTOMAC_EMAIL_FROM`; conferir
  com `scripts/send_test_email.py`. A API não inicia com a configuração incompleta.
- `FOTOMAC_DIAGNOSTICS_LOG=false` (é só para calibração em desenvolvimento).
- Banco e SeaweedFS fornecidos pela infraestrutura, com cópias de segurança compatíveis com os prazos
  de eliminação; criptografia dos discos; antivírus nos arquivos recebidos; monitoramento.
- Primeiro administrador com `scripts/create_first_admin.py` (link de uso único, sem senha padrão).
- App nas lojas: compilar com o EAS na conta Expo da instituição (`owner` em `frontend/app.json`) e
  com o endereço definitivo da API em `EXPO_PUBLIC_API_URL`.
- A base legal, a Política de Privacidade e o encarregado (DPO) são decisões da área jurídica da
  instituição; o código aplica o que está decidido, não substitui esse parecer.
