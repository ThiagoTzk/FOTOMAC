# FOTOMAC

**Plataforma de acervo fotográfico e audiovisual de eventos, com busca por reconhecimento facial.**

Uma instituição de ensino realiza dezenas de eventos por mês, e cada um gera centenas de fotos e vídeos.
Publicar tudo abertamente exporia cada pessoa retratada a qualquer visitante; não publicar deixa quem
participou sem as próprias imagens. O FOTOMAC resolve com uma inversão: **a galeria de cada evento é
privada**, e a própria pessoa recupera as suas imagens mostrando o rosto para a câmera.

- **Visitante (sem conta):** escolhe o evento, aceita o aviso de uso de imagem, faz uma captura guiada
  do rosto com movimentos sorteados (prova de vida) e recebe **só** as fotos e os vídeos em que aparece,
  para ver e baixar com marca d'água. Pode pedir a remoção de qualquer imagem sua.
- **Equipe:** fotógrafos e marketing cadastram eventos, enviam, conferem e publicam as mídias; o
  fotógrafo contratado envia com prazo e aprovação; a administração cuida das contas, da calibração do
  reconhecimento facial, das pessoas institucionais e dos registros de operações.
- **Site e aplicativo:** a mesma base de código atende o navegador (computador, tablet e celular) e o
  aplicativo para Android e iPhone.

> Trabalho de Conclusão de Curso, Bacharelado em Sistemas de Informação, Centro Universitário CESMAC
> (Maceió, 2026). Os créditos completos estão na página **Créditos** do próprio sistema.

## Privacidade desde o desenho (LGPD)

Rosto e vetor facial são **dado pessoal sensível** (Lei 13.709/2018, Art. 5º, II). A lei decidiu a
arquitetura, não foi uma revisão no final:

| Princípio | Como o sistema cumpre |
|---|---|
| Consentimento destacado | "Estou ciente" antes da câmera, conferido no servidor, nada pré-marcado |
| Finalidade | A busca acontece só dentro de um evento; não existe busca no acervo inteiro |
| Necessidade | A captura do visitante nunca é gravada; a localização (GPS) sai de toda mídia enviada |
| Eliminação | Remoção a pedido em até 72 h; fim do prazo de retenção elimina mídias, pacotes e vetores |
| Segurança | Permissão conferida no servidor, sessão HttpOnly, senha em Argon2id, CPF cifrado, links assinados que expiram, arquivos em armazenamento privado |
| Prestação de contas | Registro de operações que o próprio banco impede de alterar |

## Arquitetura

```
   Site (navegador)            Aplicativo (Android / iPhone)
          \                       /
           Expo + React Native (um só código)
                       |  HTTPS + JSON
                       v
             API em Python (FastAPI)  ------------  trabalhador em segundo plano
          /        |            |          \         (vetores, vídeos, pacotes,
         v         v            v           v          remoções, expiração)
   reconhecimento  arquivos     banco        e-mail
   facial          (S3)         (SQL)        (SMTP)
   YuNet + SFace   SeaweedFS    PostgreSQL   servidor da
   (OpenCV, CPU)                + pgvector   instituição
```

**Portas e adaptadores.** O sistema conversa com cada serviço externo por uma interface própria
(a "porta"), e cada serviço concreto é um "adaptador" que se encaixa nela:

| Porta | Adaptadores | Como trocar |
|---|---|---|
| Reconhecimento facial (`backend/app/face/`) | YuNet + SFace (e variações de resolução) | Novo motor entra no catálogo `ENGINES` de `face/factory.py`, com o limiar calibrado para ele. O administrador escolhe no painel; como vetores de motores diferentes não se comparam, o painel conduz a reindexação. A troca nunca acontece sozinha e um motor que não carrega nunca vira o motor em uso. |
| Arquivos (`backend/app/storage/`) | S3 (SeaweedFS) | Qualquer armazenamento compatível com S3 funciona só com configuração; outro tipo é um adaptador novo com os mesmos métodos. |
| E-mail (`backend/app/notifications/`) | `outbox` (desenvolvimento: grava arquivos) e `smtp` (produção, sempre criptografado) | `FOTOMAC_EMAIL_SENDER` escolhe o adaptador; outro serviço (por exemplo, uma API de e-mail) é um adaptador novo com o método `send`. |

**Busca facial, em resumo:** o servidor sorteia a ordem de movimentos de cabeça; o aparelho envia só
alguns quadros; o servidor confere a prova de vida e se é a mesma pessoa em todas as poses, extrai os
vetores (128 números por rosto) e compara, por similaridade de cosseno no pgvector, apenas com as mídias
**daquele evento**. Voltam só as que passam do limiar definido pelo administrador.

## Tecnologias

Python 3.12 · FastAPI · SQLAlchemy 2 · Alembic · PostgreSQL 17 + pgvector · SeaweedFS (S3) · OpenCV
(YuNet, SFace) · FFmpeg · ExifTool · Expo SDK 58 · React Native · Expo Router · TypeScript · MapLibre ·
pytest · Playwright

## Instalação

### Versões testadas (travadas)

O sistema foi testado exatamente com estas versões, e elas estão travadas: os pacotes do Python em
`backend/requirements.txt`, os do site e do app em `frontend/package.json` e `frontend/package-lock.json`
(instale com `npm ci`, que respeita a trava). Atualizar qualquer uma é uma decisão consciente: muda a
versão, roda todos os testes e só então segue.

| Componente | Versão |
|---|---|
| Python | 3.12.16 (`backend/.python-version`) |
| Node.js / npm | 26.13.1 / 11.20.0 (`frontend/.nvmrc`) |
| Expo SDK | 58 (versões exatas no `package.json`) |
| PostgreSQL | 17.12 |
| pgvector | 0.8.7 |
| SeaweedFS | 4.54 |
| FFmpeg | 9.0.2 |
| ExifTool | 13.55 |
| Modelos faciais | YuNet 2023mar e SFace 2021dec, conferidos por SHA-256 em `infra/setup_local.sh` |

No macOS, `brew pin postgresql@17 pgvector seaweedfs node ffmpeg exiftool python@3.12` impede o Homebrew
de atualizar esses programas sozinho.

### Desenvolvimento (macOS)

Pré-requisitos: PostgreSQL 17 e pgvector (Homebrew), SeaweedFS, Python 3.12, Node.js, FFmpeg e ExifTool.

Se o pgvector do Homebrew não trouxer a extensão para o PostgreSQL 17 (o erro é `could not access file
"$libdir/vector"`), compile a mesma versão a partir do código oficial:

```bash
git clone --depth 1 --branch v0.8.7 https://github.com/pgvector/pgvector.git && cd pgvector
make PG_CONFIG=/opt/homebrew/opt/postgresql@17/bin/pg_config
make install PG_CONFIG=/opt/homebrew/opt/postgresql@17/bin/pg_config
brew services restart postgresql@17
```

Em servidores Linux (Debian/Ubuntu), o pacote é `postgresql-17-pgvector`.

```bash
infra/setup_local.sh            # banco, credenciais locais (backend/.env) e modelos faciais conferidos
cd backend && python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/alembic upgrade head                 # banco principal
.venv/bin/alembic -x db=test upgrade head       # banco dos testes
cd ../frontend && npm ci
```

Para rodar:

```bash
infra/seaweedfs.sh start
cd backend && .venv/bin/uvicorn app.main:app --port 8000
cd frontend && npx expo start --web --port 8081
```

- Área pública: http://localhost:8081
- Área da equipe: http://localhost:8081/login
- Documentação da API: http://localhost:8000/api/v1/docs

O mapa do local do evento é gerado uma vez com `infra/build_map.sh` (mapa do Brasil, servido pela própria
API, sem serviço externo). Sem ele, o evento mostra o local escrito.

### Primeiro administrador

Uma instalação nova não tem nenhuma conta. O primeiro administrador é criado no terminal do servidor,
**sem senha**: o comando mostra um link de uso único, e quem instala abre o link e define a própria
senha. As demais contas são criadas no painel, em **Contas**.

```bash
cd backend && .venv/bin/python scripts/create_first_admin.py --email administrador@instituicao.edu.br
```

Se o link vencer sem ser usado, rode o mesmo comando com o mesmo e-mail: sai um link novo e o anterior deixa de
valer. Depois que um administrador ativa a conta, o comando passa a recusar.

### Produção

A configuração fica em variáveis `FOTOMAC_*` (arquivo `backend/.env` ou ambiente do servidor; lista em
`backend/app/config.py`). Antes de abrir ao público:

- HTTPS com certificado, `FOTOMAC_COOKIE_SECURE=true`, `FOTOMAC_FRONTEND_URL` e `FOTOMAC_CORS_ORIGINS`
  com o domínio definitivo;
- e-mail real: `FOTOMAC_EMAIL_SENDER=smtp`, `FOTOMAC_SMTP_HOST`, `FOTOMAC_SMTP_PORT` (587 com
  `starttls` ou 465 com `ssl`), `FOTOMAC_SMTP_USERNAME`, `FOTOMAC_SMTP_PASSWORD` e `FOTOMAC_EMAIL_FROM`;
  conferir com `.venv/bin/python scripts/send_test_email.py --to alguem@instituicao.edu.br`;
- `FOTOMAC_DIAGNOSTICS_LOG=false`;
- banco e armazenamento com cópias de segurança compatíveis com os prazos de eliminação, discos
  criptografados, antivírus nos arquivos recebidos e monitoramento;
- aplicativo nas lojas: compilar com o EAS da Expo, na conta da instituição, com o endereço definitivo
  da API em `EXPO_PUBLIC_API_URL`.

## Testes

```bash
cd backend && .venv/bin/pytest           # regras de negócio e de privacidade, em banco de teste separado
cd frontend && npm run typecheck         # tipos do site e do aplicativo
cd frontend && node e2e/visitor.e2e.mjs <pasta-de-fotos>   # roteiros de navegador (Playwright)
```

Os testes provam a **regra**, não só o funcionamento: sem ciência não há busca; mídia não publicada não
gera vetor; o link de download de uma sessão não abre em outra; a remoção acontece no prazo mesmo com o
servidor de e-mail fora do ar; uma captura sem os movimentos na ordem sorteada é recusada. As imagens dos
testes são retratos da NASA em domínio público e imagens sintéticas, nunca fotos de eventos.

## Para quem vai mexer no código

Leia o [`CLAUDE.md`](CLAUDE.md): organização das pastas, arquitetura, comandos e as regras de negócio e de
privacidade que não podem ser quebradas. Ele foi escrito para pessoas e para assistentes de IA.

---

Direitos reservados ao autor e ao Centro Universitário CESMAC. Sem licença de uso: o código está público
para consulta, e o reuso depende de autorização.
