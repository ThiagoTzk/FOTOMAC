// The hired photographer's photo REJECTED WITH A REASON (decision of 22/10/2026), in a real browser:
// the administrator writes the reason; the hired photographer sees "Recusada" and the reason, gets a
// notice, and cannot replace files. Then (24/10/2026) the account's period ends and the administrator
// renews it for a new coverage: the same person logs in again with the same password.
//
//   node e2e/contractor.e2e.mjs <photo.jpg> <cover.jpg> [screenshot-folder]
//
// Two browser contexts (two cookie jars), like a normal window and a private one.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const WEB = 'http://localhost:8081';
const API = 'http://localhost:8000/api/v1';
const BACKEND = fileURLToPath(new URL('../../backend/', import.meta.url));
const OUTBOX = join(BACKEND, 'outbox');
const [PHOTO, COVER, SHOTS = 'e2e-screenshots/contratado'] = process.argv.slice(2);
if (!PHOTO || !COVER) throw new Error('uso: node e2e/contractor.e2e.mjs <foto.jpg> <capa.jpg> [pasta]');
mkdirSync(SHOTS, { recursive: true });
const PASSWORD = 'Fotomac#2026';
const CPF = '529.982.247-25';   // valid check digits, not of a real person
const stamp = Date.now();
const REASON = 'Foto fora de foco, envie outra.';
let step = 0;
const check = (ok, msg) => { if (!ok) throw new Error(`FALHOU: ${msg}`); console.log(`  ok  ${msg}`); };
const problems = [];

function linkFor(email) {
  const files = readdirSync(OUTBOX).filter((f) => f.endsWith('.eml')).map((f) => join(OUTBOX, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (text.includes(`To: ${email}`)) return text.match(/http:\/\/localhost:8081\/primeiro-acesso\?token=[\w-]+/)[0];
  }
  throw new Error(`sem e-mail para ${email}`);
}

const browser = await chromium.launch();
async function context() {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 40[0-9]|non-boolean attribute|accessible/.test(m.text())) problems.push(m.text().slice(0, 200));
  });
  return page;
}
const tools = (page) => ({
  text: (t) => page.getByText(t).filter({ visible: true }).first(),
  button: (name) => page.getByRole('button', { name, exact: true }).filter({ visible: true }),
  shot: async (name) => {
    step += 1;
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(SHOTS, `${String(step).padStart(2, '0')}-${name}.png`), fullPage: true });
  },
});
async function firstAccess(page, email, identity) {
  await page.goto(linkFor(email));
  if (identity) {
    await page.getByLabel('CPF').filter({ visible: true }).fill(CPF);
    await page.getByLabel('Data de nascimento').filter({ visible: true }).fill('20/05/1990');
  }
  await page.getByLabel('Nova senha', { exact: true }).filter({ visible: true }).fill(PASSWORD);
  await page.getByLabel('Confirmar nova senha', { exact: true }).filter({ visible: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Salvar nova senha', exact: true }).filter({ visible: true }).click();
  await page.getByRole('button', { name: /Continuar para o painel/ }).filter({ visible: true }).click();
}

try {
  console.log('1. Administrador cria o evento e a conta temporária');
  const admin = await context();
  const a = tools(admin);
  const adminEmail = `e2e.contr.admin.${stamp}@cesmac.edu.br`;
  execFileSync(join(BACKEND, '.venv/bin/python'), ['scripts/create_account.py', '--name', 'Admin Contratado', '--email', adminEmail,
    '--role', 'admin'], { cwd: BACKEND });
  await firstAccess(admin, adminEmail, false);
  const created = await admin.request.post(`${API}/events`, { multipart: {
    name: `EVENTO CONTRATADO E2E ${stamp}`, theme_ids: '1', date_precision: 'day', date_start: '2026-09-18',
    location: 'Campus I', description: 'Evento do teste automatizado.',
    cover: { name: 'capa.jpg', mimeType: 'image/jpeg', buffer: readFileSync(COVER) } } });
  const eventId = (await created.json()).id;
  const contractorEmail = `e2e.contr.foto.${stamp}@cesmac.edu.br`;
  const acc = await admin.request.post(`${API}/admin/accounts`, { data: {
    full_name: 'Eduardo Contratado', email: contractorEmail, role: 'contractor', photographer_signature: 'Eduardo C.',
    bound_event_id: eventId, contract_number: 'CT-2026/045', contract_hours: 48 } });
  check(acc.status() === 201 && (await acc.json()).contractor.contract_hours === 48, 'conta temporária criada, com prazo de 48 h');
  const contractorId = (await acc.json()).id;

  console.log('2. O contratado envia uma foto');
  const hired = await context();
  const h = tools(hired);
  await firstAccess(hired, contractorEmail, true);
  const sent = await hired.request.post(`${API}/events/${eventId}/images`, {
    multipart: { file: { name: 'foto.jpg', mimeType: 'image/jpeg', buffer: readFileSync(PHOTO) } } });
  check(sent.status() === 201, 'foto enviada, aguardando aprovação');
  const imageId = (await sent.json()).id;

  console.log('3. O administrador recusa, com motivo obrigatório');
  await admin.goto(`${WEB}/eventos/${eventId}/imagens/${imageId}`);
  await a.button('Recusar foto').click();
  await a.text('Recusar esta foto?').waitFor();
  check(await a.button('Recusar').isDisabled(), 'sem motivo, não dá para recusar');
  await admin.getByLabel('Motivo da recusa').filter({ visible: true }).fill(REASON);
  // Typing in the box must not move to another photo (← → move between photos on this page).
  await admin.keyboard.press('ArrowLeft');
  check(await a.text('Recusar esta foto?').isVisible(), 'digitar o motivo não troca de foto');
  await a.shot('recusar-com-motivo');
  await a.button('Recusar').click();
  await a.text('Recusada pela administração').waitFor();
  check(await a.text(REASON).isVisible(), 'a foto mostra "Recusada pela administração" e, à parte, o motivo');

  console.log('4. O contratado vê a recusa, o motivo e o aviso; não substitui arquivos');
  await hired.goto(`${WEB}/eventos/${eventId}/imagens?filtro=rejected`);
  await h.text(/Recusadas · 1/).waitFor();
  const bell = await (await hired.request.get(`${API}/notifications`)).json();
  check(bell.items.some((n) => n.kind === 'own_rejected'), 'o sino do contratado avisa a imagem recusada');
  await hired.goto(`${WEB}/eventos/${eventId}/imagens/${imageId}`);
  await h.text('Recusada pela administração').waitFor();
  await h.text(REASON).waitFor();
  check(await h.text(/excluída automaticamente em/).isVisible(), 'o contratado lê o motivo e quando a foto sai');
  check(!(await h.button('Substituir arquivo').isVisible().catch(() => false)), 'o contratado não tem "Substituir arquivo"');
  const swap = await hired.request.put(`${API}/images/${imageId}/file`, {
    multipart: { file: { name: 'b.jpg', mimeType: 'image/jpeg', buffer: readFileSync(PHOTO) } } });
  check(swap.status() === 403, 'o servidor também recusa a troca de arquivo do contratado');
  await h.shot('contratado-ve-recusa');

  console.log('5. O prazo acaba; o administrador renova o acesso para uma nova cobertura');
  execFileSync(join(BACKEND, '.venv/bin/python'), ['-c', `
from datetime import datetime, timedelta, timezone
from sqlalchemy import update
from app.db.models import Account
from app.db.session import get_engine
with get_engine().begin() as c:
    c.execute(update(Account).where(Account.email == "${contractorEmail}").values(valid_until=datetime.now(timezone.utc) - timedelta(minutes=1)))
`], { cwd: BACKEND });
  await hired.goto(`${WEB}/eventos/${eventId}`);
  // 31/10/2026: no longer thrown out to the login — the restricted page says why, and opens the Support.
  await h.text('O prazo da sua conta temporária terminou').waitFor({ timeout: 15000 });
  check(true, 'prazo vencido: o contratado vê só a página da conta expirada');
  check((await hired.request.get(`${API}/events/${eventId}`)).status() === 401, 'o servidor recusa o evento');
  await hired.getByLabel('Mensagem', { exact: true }).filter({ visible: true }).fill('Preciso de mais um dia para enviar o restante.');
  await hired.getByRole('button', { name: 'Enviar', exact: true }).click();
  await h.text(/Mensagem enviada/).waitFor();
  check(true, 'pedido de renovação enviado pelo Suporte');
  await h.shot('conta-expirada');
  await admin.goto(`${WEB}/contas/${contractorId}`);
  await a.text('Expirada').waitFor();
  await a.button('Renovar acesso').click();
  await a.text(/volta a funcionar agora/).waitFor();
  await admin.getByLabel('Número do contrato').filter({ visible: true }).last().fill('CT-2026/046');
  await admin.getByRole('button', { name: 'Prazo da conta' }).filter({ visible: true }).last().click();
  await a.text('3 dias (72 horas)').click();
  await a.shot('renovar-acesso');
  await admin.getByRole('button', { name: 'Renovar acesso', exact: true }).filter({ visible: true }).last().click();
  await a.text(/Acesso renovado/).waitFor();
  check(await a.text('Ativa').isVisible(), 'a conta voltou a "Ativa"');
  check(await a.text('CT-2026/046').isVisible(), 'com o novo contrato');
  await hired.reload();
  await h.text('ÁREA DO FOTÓGRAFO CONTRATADO').waitFor({ timeout: 15000 });
  check(true, 'renovada: o painel volta para o mesmo fotógrafo, na mesma sessão');
  check(await h.text('CONTA TEMPORÁRIA · EXPIRA EM').isVisible(), 'o relógio do prazo aparece ao lado do sino');
  const c1 = await h.text(/^\d+d \d\d:\d\d:\d\d$|^\d\d:\d\d:\d\d$/).innerText();
  await hired.waitForTimeout(2100);
  const c2 = await h.text(/^\d+d \d\d:\d\d:\d\d$|^\d\d:\d\d:\d\d$/).innerText();
  check(c1 !== c2, `o relógio desce de segundo em segundo (${c1} → ${c2})`);
  await h.shot('relogio-conta-temporaria');
  const mail = readdirSync(OUTBOX).map((f) => join(OUTBOX, f)).sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs)
    .map((f) => readFileSync(f, 'utf8')).find((t) => t.includes(`To: ${contractorEmail}`));
  check(/renovado/.test(mail), 'ele recebeu o e-mail de renovação');

  check(problems.length === 0, `console sem erros${problems.length ? ': ' + problems.join(' | ') : ''}`);
  console.log('\nTUDO CERTO — recusa com motivo, aviso ao contratado, sem troca de arquivo, e renovação do acesso.');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
