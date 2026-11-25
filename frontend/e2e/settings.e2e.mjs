// "Configuração do evento" (24/10/2026), in a real browser: the person responsible switches RAW and
// collaboration after creating the event, and turns off the access of a photographer who already finished —
// whose photos stay in the event while they can no longer send or change anything.
//
//   node e2e/settings.e2e.mjs <photo.jpg> <cover.jpg> [screenshot-folder]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const WEB = 'http://localhost:8081';
const API = 'http://localhost:8000/api/v1';
const BACKEND = fileURLToPath(new URL('../../backend/', import.meta.url));
const OUTBOX = join(BACKEND, 'outbox');
const [PHOTO, COVER, SHOTS = 'e2e-screenshots/configuracao'] = process.argv.slice(2);
if (!PHOTO || !COVER) throw new Error('uso: node e2e/settings.e2e.mjs <foto.jpg> <capa.jpg> [pasta]');
mkdirSync(SHOTS, { recursive: true });
const PASSWORD = 'Fotomac#2026';
const stamp = Date.now();
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
async function person(name, role) {
  const email = `e2e.config.${name.split(' ')[0].normalize('NFD').replace(/[^a-z]/gi, '').toLowerCase()}.${stamp}@cesmac.edu.br`;
  execFileSync(join(BACKEND, '.venv/bin/python'), ['scripts/create_account.py', '--name', name, '--email', email, '--role', role,
    '--signature', name], { cwd: BACKEND });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 40[0-9]|non-boolean attribute|accessible/.test(m.text())) problems.push(m.text().slice(0, 200));
  });
  await page.goto(linkFor(email));
  await page.getByLabel('Nova senha', { exact: true }).filter({ visible: true }).fill(PASSWORD);
  await page.getByLabel('Confirmar nova senha', { exact: true }).filter({ visible: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Salvar nova senha', exact: true }).filter({ visible: true }).click();
  await page.getByRole('button', { name: /Continuar para o painel/ }).filter({ visible: true }).click();
  await page.getByText(/ÁREA DO/).filter({ visible: true }).first().waitFor({ timeout: 15000 });
  return page;
}
const text = (page, t) => page.getByText(t).filter({ visible: true }).first();

try {
  console.log('1. O responsável cria o evento (sem RAW) e libera a colaboração; João envia uma foto');
  const owner = await person('Bruno Configuração', 'photographer');
  const joao = await person('João Configuração', 'photographer');
  const created = await owner.request.post(`${API}/events`, { multipart: {
    name: `EVENTO CONFIGURAÇÃO E2E ${stamp}`, theme_ids: '1', date_precision: 'day', date_start: '2026-09-18',
    location: 'Campus I', description: 'Evento do teste automatizado.',
    cover: { name: 'capa.jpg', mimeType: 'image/jpeg', buffer: readFileSync(COVER) } } });
  const eventId = (await created.json()).id;
  check((await created.json()).raw_enabled === false, 'evento criado com RAW desligado');
  await owner.goto(`${WEB}/eventos/${eventId}?aba=configuracao`);
  await text(owner, 'Configuração do evento').waitFor();
  await owner.getByRole('switch', { name: 'Colaboração' }).click();
  await text(owner, 'João').waitFor({ timeout: 1 }).catch(() => undefined);
  await owner.waitForTimeout(800);
  const sent = await joao.request.post(`${API}/events/${eventId}/images`, {
    multipart: { file: { name: 'foto.jpg', mimeType: 'image/jpeg', buffer: readFileSync(PHOTO) } } });
  check(sent.status() === 201, 'com a colaboração ligada pela tela, João enviou uma foto');

  console.log('2. RAW é ligado e desligado depois de criado, sem "Editar evento"');
  await owner.getByRole('switch', { name: 'Aceitar arquivos RAW' }).click();
  await owner.waitForTimeout(800);
  check((await (await owner.request.get(`${API}/events/${eventId}`)).json()).raw_enabled === true, 'RAW ligado');
  await owner.getByRole('switch', { name: 'Aceitar arquivos RAW' }).click();
  await owner.waitForTimeout(800);
  check((await (await owner.request.get(`${API}/events/${eventId}`)).json()).raw_enabled === false, 'RAW desligado de novo');

  console.log('3. O responsável encerra o acesso do João');
  await owner.reload();
  await text(owner, 'Quem trabalha neste evento').waitFor();
  await text(owner, 'João Configuração').waitFor();
  check(await text(owner, 'Responsável').isVisible(), 'o responsável aparece fixo, sem chave');
  await owner.getByRole('switch', { name: 'Acesso de João Configuração' }).click();
  await text(owner, 'Acesso encerrado').waitFor();
  await owner.waitForTimeout(1000);
  await owner.screenshot({ path: join(SHOTS, '01-configuracao.png'), fullPage: true });
  check(true, 'João aparece com "Acesso encerrado"');

  console.log('4. João vê o aviso, não envia mais nada, e a foto dele continua no evento');
  await joao.goto(`${WEB}/eventos/${eventId}`);
  await text(joao, 'Seu acesso a este evento foi encerrado').waitFor();
  await joao.goto(`${WEB}/eventos/${eventId}/imagens`);
  await joao.waitForTimeout(1500);
  check(!(await joao.getByRole('button', { name: 'Enviar imagens' }).filter({ visible: true }).count()), 'sem "Enviar imagens"');
  const again = await joao.request.post(`${API}/events/${eventId}/images`, {
    multipart: { file: { name: 'b.jpg', mimeType: 'image/jpeg', buffer: readFileSync(COVER) } } });
  check(again.status() === 403, 'o servidor recusa o envio');
  const listed = await (await owner.request.get(`${API}/events/${eventId}/images`)).json();
  check(listed.items.length === 1, 'a foto do João continua no evento');

  console.log('5. Religar devolve o acesso');
  await owner.getByRole('switch', { name: 'Acesso de João Configuração' }).click();
  await owner.waitForTimeout(800);
  check((await (await joao.request.get(`${API}/events/${eventId}`)).json()).can_upload === true, 'João volta a poder enviar');

  check(problems.length === 0, `console sem erros${problems.length ? ': ' + problems.join(' | ') : ''}`);
  console.log('\nTUDO CERTO — colaboração, RAW e acesso por pessoa na Configuração do evento.');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
