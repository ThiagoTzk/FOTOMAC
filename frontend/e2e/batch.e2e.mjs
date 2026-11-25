// 28/10/2026 (reported in the test): 500 files chosen, some already in the collection — the files beyond the
// 500 were DROPPED, while duplicates (never sent) were holding places. Now duplicates do not take a place, the
// files beyond wait for their turn and come in by themselves, and "Tirar os duplicados da lista" cleans the list.
// No photo is actually sent: only the choice and the check before sending.
//
//   node e2e/batch.e2e.mjs [pasta-arquivos]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const [DIR = 'e2e-screenshots/batch-files'] = process.argv.slice(2);
const API = 'http://localhost:8000/api/v1';
const WEB = 'http://localhost:8081';
const BACKEND = fileURLToPath(new URL('../../backend/', import.meta.url));
const OUTBOX = join(BACKEND, 'outbox');
const PASSWORD = 'Fotomac#2026';
const stamp = Date.now();
const email = `e2e.lote.${stamp}@cesmac.edu.br`;
const check = (ok, msg) => { if (!ok) throw new Error(`FALHOU: ${msg}`); console.log(`  ok  ${msg}`); };

function token(to) {
  const files = readdirSync(OUTBOX).filter((f) => f.endsWith('.eml')).map((f) => join(OUTBOX, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const f of files) {
    const m = readFileSync(f, 'utf8');
    if (m.includes(`To: ${to}`)) return m.match(/primeiro-acesso\?token=([\w-]+)/)[1];
  }
  throw new Error(`sem link para ${to}`);
}

// 535 small, distinct JPEGs (u0 … u534), made by the backend's OpenCV.
mkdirSync(DIR, { recursive: true });
execFileSync(join(BACKEND, '.venv/bin/python'), ['-c', `
import cv2, numpy as np, sys
for i in range(535):
    img = np.full((60, 80, 3), (i * 7) % 255, np.uint8)
    cv2.putText(img, str(i), (4, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
    cv2.imwrite(f"${DIR}/u{i}.jpg", img)
`]);
const u = (i) => join(DIR, `u${i}.jpg`);

const browser = await chromium.launch();
try {
  console.log('1. Fotógrafo com um evento que já tem 1 foto no acervo (u0)');
  execFileSync(join(BACKEND, '.venv/bin/python'), ['scripts/create_account.py', '--name', 'Lote Teste', '--email', email,
    '--role', 'photographer', '--signature', 'Lote Teste'], { cwd: BACKEND });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  check((await page.request.post(`${API}/auth/first-access`, { data: { token: token(email), password: PASSWORD, password_confirmation: PASSWORD } })).ok(), 'fotógrafo ativado');
  const themes = await (await page.request.get(`${API}/themes`)).json();
  const created = await page.request.post(`${API}/events`, { multipart: {
    name: `Lote E2E ${stamp}`, theme_ids: String(themes[0].id), date_precision: 'day', date_start: '2026-09-18',
    location: 'Campus I', description: 'Evento do teste automatizado.',
    cover: { name: 'capa.jpg', mimeType: 'image/jpeg', buffer: readFileSync(u(534)) } } });
  const ev = await created.json();
  check(Boolean(ev.id), `evento criado${ev.id ? '' : `: ${JSON.stringify(ev)}`}`);
  check((await page.request.post(`${API}/events/${ev.id}/images`, { multipart: { file: { name: 'u0.jpg', mimeType: 'image/jpeg', buffer: readFileSync(u(0)) } } })).ok(), 'u0 já está no acervo');

  console.log('2. 515 arquivos escolhidos: 21 duplicados entre os 500 primeiros (u0 do acervo e 20 repetidos)');
  await page.goto(`${WEB}/eventos/${ev.id}/enviar`);
  await page.getByText('Arraste suas fotos e vídeos aqui').waitFor();
  const first500 = [...Array.from({ length: 480 }, (_, i) => u(i)), ...Array.from({ length: 20 }, (_, i) => u(i + 1))];
  const beyond = Array.from({ length: 15 }, (_, i) => u(480 + i));
  // The same file twice in one selection needs a copy with another name (the browser keeps one per path).
  execFileSync('/bin/sh', ['-c', Array.from({ length: 20 }, (_, i) => `cp "${u(i + 1)}" "${DIR}/copia${i + 1}.jpg"`).join(' && ')]);
  const selection = [...first500.slice(0, 480), ...Array.from({ length: 20 }, (_, i) => join(DIR, `copia${i + 1}.jpg`)), ...beyond];
  await page.locator('input[type=file]').setInputFiles(selection);
  await page.getByRole('button', { name: 'Iniciar envio (494)' }).filter({ visible: true }).waitFor({ timeout: 120000 });
  check(true, 'os 15 além dos 500 entraram sozinhos no lugar dos duplicados: 494 para enviar');
  check(await page.getByText('21 arquivos duplicados').isVisible(), 'um só aviso para os 21 duplicados');
  check(!(await page.getByText(/aguarda(m)? a vez/).count()), 'nenhum arquivo ficou de fora');
  await page.screenshot({ path: join(DIR, '..', 'batch-1-duplicados.png') });

  console.log('3. "Tirar os duplicados da lista"');
  await page.getByRole('button', { name: 'Tirar os duplicados da lista' }).click();
  await page.getByText('Arquivos selecionados · 494').waitFor();
  check(!(await page.getByText(/arquivos? duplicados?$/).count()), 'a lista fica só com o que vai ser enviado');

  console.log('4. Mais 20 arquivos: 6 entram (até 500) e 14 aguardam a vez');
  await page.locator('input[type=file]').setInputFiles(Array.from({ length: 20 }, (_, i) => u(495 + i)));
  await page.getByRole('button', { name: 'Iniciar envio (500)' }).filter({ visible: true }).waitFor({ timeout: 60000 });
  await page.getByText('14 arquivos aguardam a vez').waitFor();
  check(true, 'até 500 por envio; os 14 restantes aguardam (não são descartados)');
  await page.screenshot({ path: join(DIR, '..', 'batch-2-aguardando.png') });

  console.log('\nTUDO CERTO — duplicados não ocupam lugar e nenhum arquivo é descartado.');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
