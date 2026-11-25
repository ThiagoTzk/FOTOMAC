// RF027 in the browser (11/11/2026): the whole team has the Temas screen; only the author (or the administrator)
// changes a theme; somebody else's theme shows "Só o autor altera". Also on a phone-sized screen.
//
//   node e2e/themes.e2e.mjs [pasta-capturas]
//
// Creates e2e.temas.* accounts and themes named "... E2E ..."; clean with backend/scripts/cleanup_e2e.py --apply.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const SHOTS = resolve(process.argv[2] ?? 'e2e-screenshots/temas');
mkdirSync(SHOTS, { recursive: true });
const API = 'http://localhost:8000/api/v1';
const WEB = 'http://localhost:8081';
const BACKEND = fileURLToPath(new URL('../../backend/', import.meta.url));
const OUTBOX = join(BACKEND, 'outbox');
const PASSWORD = 'Fotomac#2026';
const stamp = Date.now();
const check = (ok, msg) => { if (!ok) throw new Error(`FALHOU: ${msg}`); console.log(`  ok  ${msg}`); };
const problems = [];

function token(email) {
  const files = readdirSync(OUTBOX).filter((f) => f.endsWith('.eml')).map((f) => join(OUTBOX, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const f of files) { const m = readFileSync(f, 'utf8'); if (m.includes(`To: ${email}`)) return m.match(/primeiro-acesso\?token=([\w-]+)/)[1]; }
  throw new Error(`sem link para ${email}`);
}

const browser = await chromium.launch();
async function person(name, role, viewport = { width: 1440, height: 1000 }) {
  const email = `e2e.temas.${name.split(' ')[0].toLowerCase()}.${stamp}@cesmac.edu.br`;
  const args = ['scripts/create_account.py', '--name', name, '--email', email, '--role', role];
  if (role !== 'admin') args.push('--signature', name);
  execFileSync(join(BACKEND, '.venv/bin/python'), args, { cwd: BACKEND });
  const p = await (await browser.newContext({ viewport })).newPage();
  p.on('pageerror', (e) => problems.push(e.message));
  const ok = await p.request.post(`${API}/auth/first-access`, { data: { token: token(email), password: PASSWORD, password_confirmation: PASSWORD } });
  check(ok.ok(), `${name} (${role}) ativado`);
  return p;
}
const visible = (loc) => loc.filter({ visible: true });
const row = (p, name) => p.getByRole('listitem', { name: `Tema ${name}` });
const rowHas = async (p, name, text) => (await visible(row(p, name).getByText(text, { exact: true })).count()) > 0;
const rowButton = (p, name, label) => visible(row(p, name).getByRole('button', { name: label, exact: true }));

async function createOnScreen(p, name) {
  await p.getByLabel('Novo tema', { exact: true }).fill(name);
  await visible(p.getByRole('button', { name: 'Adicionar', exact: true })).click();
  await visible(p.getByText(`Tema “${name}” criado.`)).waitFor();
}

try {
  const olgaTheme = `Ensaio E2E ${stamp}`;
  const maraTheme = `Divulgacao E2E ${stamp}`;

  console.log('1. Fotógrafo: Temas no menu, cria pela tela e só ele altera');
  const olga = await person('Olga Fotografa', 'photographer');
  await olga.goto(`${WEB}/painel`, { waitUntil: 'networkidle' });
  check(await visible(olga.getByRole('link', { name: 'Temas', exact: true })).count() === 1, 'fotógrafo: "Temas" no menu lateral');
  await visible(olga.getByRole('link', { name: 'Temas', exact: true })).click();
  await olga.waitForURL('**/temas');
  await createOnScreen(olga, olgaTheme);
  check(await rowHas(olga, olgaTheme, 'Você'), 'o tema dela aparece com autor "Você"');
  check(await rowButton(olga, olgaTheme, 'Editar').count() === 1, 'ela vê Editar no próprio tema');
  await olga.screenshot({ path: join(SHOTS, 'fotografo.png'), fullPage: true });

  console.log('2. Marketing: vê o tema da fotógrafa só para consulta e cria o seu');
  const mara = await person('Mara Marketing', 'marketing');
  await mara.goto(`${WEB}/temas`, { waitUntil: 'networkidle' });
  await row(mara, olgaTheme).waitFor();
  check(await rowHas(mara, olgaTheme, 'Olga Fotografa'), 'marketing vê a autora do tema');
  check(await rowHas(mara, olgaTheme, 'Só o autor altera'), 'no tema dos outros: "Só o autor altera"');
  check(await rowButton(mara, olgaTheme, 'Editar').count() === 0 && await rowButton(mara, olgaTheme, 'Inativar').count() === 0,
        'sem Editar nem Inativar no tema dos outros');
  const refused = await mara.request.put(`${API}/themes/${(await (await mara.request.get(`${API}/themes/manage`)).json()).find((t) => t.name === olgaTheme).id}`,
    { data: { name: 'Trocado E2E' } });
  check(refused.status() === 403, 'o servidor recusa a alteração do tema dos outros (403), mesmo sem a tela');
  await createOnScreen(mara, maraTheme);
  check(await rowButton(mara, maraTheme, 'Editar').count() === 1, 'marketing altera o próprio tema');
  await mara.screenshot({ path: join(SHOTS, 'marketing.png'), fullPage: true });

  console.log('3. A autora renomeia e inativa o próprio tema');
  await olga.reload({ waitUntil: 'networkidle' });
  await rowButton(olga, olgaTheme, 'Editar').click();
  const renamed = `${olgaTheme} II`;
  await olga.getByLabel('Nome do tema', { exact: true }).fill(renamed);
  await visible(olga.getByRole('button', { name: 'Salvar', exact: true })).click();
  await visible(olga.getByText('Tema atualizado.')).waitFor();
  await rowButton(olga, renamed, 'Inativar').click();
  await row(olga, renamed).getByText('Inativo', { exact: true }).first().waitFor();
  check(true, 'renomeado e inativado pela autora');

  console.log('4. Administrador: altera qualquer tema');
  const adao = await person('Adao Administrador', 'admin');
  await adao.goto(`${WEB}/temas`, { waitUntil: 'networkidle' });
  await row(adao, renamed).waitFor();
  check(await rowButton(adao, renamed, 'Editar').count() === 1 && await rowButton(adao, maraTheme, 'Editar').count() === 1,
        'administrador vê Editar nos temas da fotógrafa e do marketing');
  check(await rowHas(adao, renamed, 'Olga Fotografa'), 'administrador vê a autora');

  console.log('5. Celular (390 px): menu, autor na linha e nada passa da borda');
  const phone = await person('Paula Celular', 'photographer', { width: 390, height: 844 });
  await phone.goto(`${WEB}/temas`, { waitUntil: 'networkidle' });
  await row(phone, maraTheme).waitFor();
  check(await rowHas(phone, maraTheme, 'Criado por: Mara Marketing'), 'no celular: "Criado por: Mara Marketing"');
  check(await rowHas(phone, maraTheme, 'Só o autor altera'), 'no celular: "Só o autor altera"');
  const right = await phone.evaluate(() => Math.max(...[...document.querySelectorAll('body *')]
    .filter((el) => el.getClientRects().length).map((el) => el.getBoundingClientRect().right)));
  check(right <= 391, `nada passa da borda da tela (maior borda direita: ${Math.round(right)} px)`);
  await phone.screenshot({ path: join(SHOTS, 'celular.png'), fullPage: true });
  await visible(phone.getByRole('button', { name: /menu/i })).first().click();
  check(await visible(phone.getByRole('link', { name: 'Temas', exact: true })).count() === 1, 'no celular: "Temas" no menu');

  // The e2e themes are removed now (unused, so they can be deleted): nothing of the test is left in the list.
  for (const [p, name] of [[olga, renamed], [mara, maraTheme]]) {
    const t = (await (await p.request.get(`${API}/themes/manage`)).json()).find((x) => x.name === name);
    check((await p.request.delete(`${API}/themes/${t.id}`)).status() === 204, `"${name}" excluído pela autora`);
  }
  check(problems.length === 0, `console sem erros${problems.length ? `: ${problems.join(' | ')}` : ''}`);
  console.log('\nTUDO CERTO: temas para fotógrafo e marketing, só o autor altera.');
} finally {
  await browser.close();
}
