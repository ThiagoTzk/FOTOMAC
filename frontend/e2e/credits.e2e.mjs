// 17/11/2026 (after the final banca): a credits page reachable from the whole system. Visitor: the site's
// footer (computer) and the phone's menu lead to /creditos. Staff: the panel's sidebar (and its drawer on the phone)
// leads to /sobre, inside the panel. Same content in both; nothing crosses the screen's edge; "Voltar" returns.
//
//   node e2e/credits.e2e.mjs [pasta-capturas]
//
// Chromium, not Safari: check the real phone too. The e2e account is removed by scripts/cleanup_e2e.py at the end.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(join(ROOT, 'frontend/package.json'));
const { chromium } = require('playwright');
const [OUT = 'e2e-screenshots/credits'] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const API = 'http://localhost:8000/api/v1';
const WEB = 'http://localhost:8081';
const BACKEND = join(ROOT, 'backend');
const PASSWORD = 'Fotomac#2026';
const NAMES = ['Thiago José Camêlo Nunes', 'Prof. Me. Wagner de Oliveira Lima Palmeira de Araujo',
  'Prof. Me. Mozart de Melo Alves Junior', 'Moacir Barbosa da Silva', 'CITEC'];

const browser = await chromium.launch();
const PHONE = (width, height) => ({ viewport: { width, height }, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
const DESKTOP = { viewport: { width: 1280, height: 800 } };

function check(cond, msg) { if (!cond) throw new Error(msg); console.log(`ok  ${msg}`); }
async function content(p, where) {
  const text = await p.locator('body').innerText();
  for (const n of NAMES) check(text.includes(n), `${where}: mostra "${n}"`);
  check(!/@|\(82\)|CPF/.test(text.split('Créditos').slice(1).join('')), `${where}: sem e-mail, telefone ou CPF`);
  const wide = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(wide <= 1, `${where}: nada passa da borda (${wide}px)`);
}
function outbox(email) {
  const dir = join(BACKEND, 'outbox');
  const files = readdirSync(dir).filter((f) => f.endsWith('.eml')).map((f) => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const f of files) { const m = readFileSync(f, 'utf8'); if (m.includes(`To: ${email}`)) return m.match(/primeiro-acesso\?token=([\w-]+)/)[1]; }
  throw new Error(`sem link para ${email}`);
}
async function staff(ctx) {
  const email = `e2e.credits.${Date.now()}@cesmac.edu.br`;
  execFileSync(join(BACKEND, '.venv/bin/python'), ['scripts/create_account.py', '--name', 'Teste Creditos', '--email', email,
    '--role', 'photographer', '--signature', 'Teste'], { cwd: BACKEND });
  const p = await (await browser.newContext(ctx)).newPage();
  const r = await p.request.post(`${API}/auth/first-access`, { data: { token: outbox(email), password: PASSWORD, password_confirmation: PASSWORD } });
  if (!r.ok()) throw new Error('ativar conta de teste');
  return p;
}

try {
  // Visitor, computer: footer of the home -> /creditos -> Voltar returns home.
  let p = await (await browser.newContext(DESKTOP)).newPage();
  await p.goto(WEB, { waitUntil: 'networkidle' });
  await p.getByRole('contentinfo').getByText('Créditos', { exact: true }).click();
  await p.waitForURL('**/creditos');
  await p.getByText('Equipe do projeto').waitFor();
  check(/Créditos/.test(await p.title()), 'visitante, computador: título da aba "Créditos"');
  await content(p, 'visitante, computador');
  await p.screenshot({ path: join(OUT, 'visitante-computador.png'), fullPage: true });
  await p.getByRole('link', { name: 'Voltar' }).first().click();
  await p.waitForURL(WEB + '/');
  check(true, 'visitante, computador: Voltar leva de volta ao início');

  // Visitor, phones: the settings menu of the header -> /creditos.
  for (const [w, h] of [[390, 844], [320, 568]]) {
    p = await (await browser.newContext(PHONE(w, h))).newPage();
    await p.goto(`${WEB}/como-funciona`, { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: 'Menu' }).click();
    await p.getByText('Créditos', { exact: true }).click();
    await p.waitForURL('**/creditos');
    await p.getByText('Equipe do projeto').waitFor();
    await content(p, `visitante, celular ${w}px`);
    await p.screenshot({ path: join(OUT, `visitante-celular-${w}.png`), fullPage: true });
    await p.getByText('Voltar', { exact: true }).filter({ visible: true }).first().click();   // the previous screen stays mounted (hidden) behind
    await p.waitForURL('**/como-funciona');
    check(true, `visitante, celular ${w}px: Voltar volta para a tela anterior`);
  }

  // Staff, computer: sidebar "Sobre" -> /sobre inside the panel.
  p = await staff(DESKTOP);
  await p.goto(`${WEB}/painel`, { waitUntil: 'networkidle' });
  await p.getByRole('navigation', { name: 'Menu principal' }).waitFor();
  await p.getByText('Sobre', { exact: true }).click();
  await p.waitForURL('**/sobre');
  await p.getByRole('heading', { name: 'Sobre o FOTOMAC' }).waitFor();
  check(await p.getByText('Meu perfil', { exact: true }).first().isVisible(), 'equipe, computador: continua no painel (menu lateral à vista)');
  await content(p, 'equipe, computador');
  await p.screenshot({ path: join(OUT, 'equipe-computador.png'), fullPage: true });

  // Staff, phone: the drawer of the panel -> /sobre.
  const phoneStaff = await (await browser.newContext({ ...PHONE(390, 844), storageState: await p.context().storageState() })).newPage();
  await phoneStaff.goto(`${WEB}/painel`, { waitUntil: 'networkidle' });
  await phoneStaff.getByRole('button', { name: 'Abrir menu' }).click();
  await phoneStaff.getByText('Sobre', { exact: true }).click();
  await phoneStaff.waitForURL('**/sobre');
  await phoneStaff.getByRole('heading', { name: 'Sobre o FOTOMAC' }).waitFor();
  await content(phoneStaff, 'equipe, celular 390px');
  await phoneStaff.screenshot({ path: join(OUT, 'equipe-celular-390.png'), fullPage: true });
  console.log('\nTUDO OK');
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  execFileSync(join(BACKEND, '.venv/bin/python'), ['scripts/cleanup_e2e.py', '--apply'], { cwd: BACKEND, stdio: 'inherit' });
}
