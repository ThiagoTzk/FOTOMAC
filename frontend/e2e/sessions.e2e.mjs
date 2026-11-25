// Two tabs of the SAME browser (one session cookie for both): a real case found on 22/10/2026 —
// a tab still showing the hired photographer published as the administrator logged in in the other tab.
// Decision of 24/10/2026: one account per browser at a time and every tab FOLLOWS it, like Google or
// GitHub — a login in any tab takes the other tabs (even one sitting on the login screen) to that account;
// a logout sends them to the login. The public site shows who is logged in (name, role, "Área da equipe")
// and updates when someone logs in or out in another tab. "Manter conectado" keeps the cookie 30 days.
//
//   node e2e/sessions.e2e.mjs
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const API = 'http://localhost:8000/api/v1';
const BACKEND = fileURLToPath(new URL('../../backend/', import.meta.url));
const OUTBOX = join(BACKEND, 'outbox');
const PASSWORD = 'Fotomac#2026';
const stamp = Date.now();
const check = (ok, msg) => { if (!ok) throw new Error(`FALHOU: ${msg}`); console.log(`  ok  ${msg}`); };

function activationLink(email) {
  const files = readdirSync(OUTBOX).filter((f) => f.endsWith('.eml')).map((f) => join(OUTBOX, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (text.includes(`To: ${email}`)) return text.match(/http:\/\/localhost:8081\/primeiro-acesso\?token=[\w-]+/)[0];
  }
  throw new Error(`sem e-mail para ${email}`);
}

const emails = {};
async function activate(page, name, role, signature) {
  const email = `e2e.sessao.${role}.${stamp}@cesmac.edu.br`;
  const args = ['scripts/create_account.py', '--name', name, '--email', email, '--role', role];
  execFileSync(join(BACKEND, '.venv/bin/python'), signature ? [...args, '--signature', signature] : args, { cwd: BACKEND });
  emails[role] = email;
  await page.goto(activationLink(email));
  await page.getByLabel('Nova senha', { exact: true }).filter({ visible: true }).fill(PASSWORD);
  await page.getByLabel('Confirmar nova senha', { exact: true }).filter({ visible: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Salvar nova senha', exact: true }).filter({ visible: true }).click();
  await page.getByRole('button', { name: /Continuar para o painel/ }).filter({ visible: true }).click();
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });   // ONE cookie jar
  const tab1 = await context.newPage();
  const tab2 = await context.newPage();
  const area = (tab, who) => tab.getByText(`ÁREA DO ${who}`).filter({ visible: true }).first().waitFor({ timeout: 15000 });
  const onLogin = (tab) => tab.waitForURL((u) => u.pathname === '/login', { timeout: 15000 });
  async function login(tab, email) {
    await tab.getByLabel('E-mail', { exact: true }).filter({ visible: true }).fill(email);
    await tab.getByLabel('Senha', { exact: true }).filter({ visible: true }).fill(PASSWORD);
    await tab.getByRole('button', { name: 'Entrar', exact: true }).filter({ visible: true }).click();
  }

  console.log('1. Aba 1: fotógrafo');
  await activate(tab1, 'Fotógrafo Sessão', 'photographer', 'Fotografo S');
  await area(tab1, 'FOTÓGRAFO');
  const photographerId = (await (await tab1.request.get(`${API}/auth/me`)).json()).id;
  check(true, 'aba 1 mostra o fotógrafo');

  console.log('2. Aba 2, mesmo navegador: o administrador entra — a aba 1 vai junto');
  await activate(tab2, 'Admin Sessão', 'admin');
  await area(tab2, 'ADMINISTRADOR');
  await area(tab1, 'ADMINISTRADOR');
  check(true, 'a aba 1 passou sozinha para a conta que está no navegador');

  console.log('3. Se uma aba ficasse para trás, o servidor recusa agir com outra identidade');
  const status = await tab1.evaluate(async ([api, id]) => (await fetch(`${api}/auth/me`, {
    credentials: 'include', headers: { 'X-Fotomac-Account': id } })).status, [API, photographerId]);
  check(status === 409, 'pedido dizendo "sou o fotógrafo" com a sessão do admin: recusado (409)');

  console.log('4. O site público mostra quem está conectado e leva de volta à área da equipe');
  const site = await context.newPage();
  await site.goto(new URL('/', tab1.url()).href);
  await site.getByText('Admin Sessão').filter({ visible: true }).first().waitFor({ timeout: 15000 });
  check(await site.getByText('Administrador').filter({ visible: true }).count() > 0, 'nome e cargo no topo do site');
  await site.getByRole('link', { name: 'Área da equipe' }).filter({ visible: true }).first().click();
  await area(site, 'ADMINISTRADOR');
  check(true, '"Área da equipe" abre o painel sem entrar de novo');
  await site.getByRole('link', { name: 'Ver o site' }).filter({ visible: true }).first().click();
  await site.waitForURL((u) => u.pathname === '/', { timeout: 15000 });
  check(true, '"Ver o site" no painel volta ao site, ainda conectado');

  console.log('5. Sair numa aba leva as abas do painel para o login; o site público passa a "Acesso da equipe"');
  await tab1.getByText('Sair', { exact: true }).filter({ visible: true }).first().click();
  await onLogin(tab1);
  await onLogin(tab2);
  check(true, 'as duas abas do painel foram para o login');
  await site.getByText('Acesso da equipe').filter({ visible: true }).first().waitFor({ timeout: 15000 });
  check(site.url().endsWith('/'), 'a aba do site continuou na página e trocou o topo sozinha');

  console.log('6. Entrar numa aba leva a aba que estava no login para dentro da conta (caso relatado em teste)');
  await login(tab1, emails.photographer);
  await area(tab1, 'FOTÓGRAFO');
  await area(tab2, 'FOTÓGRAFO');
  check(true, 'a aba 2, parada no login, entrou sozinha na conta');
  await site.getByText('Fotógrafo Sessão').filter({ visible: true }).first().waitFor({ timeout: 15000 });
  check(true, 'o site público mostra o fotógrafo');
  await tab2.reload();
  await area(tab2, 'FOTÓGRAFO');
  check(true, 'recarregando, continua na conta');

  console.log('7. Uma aba que perdeu o aviso entre abas confere a sessão ao voltar a ficar visível');
  const deaf = await context.newPage();
  await deaf.addInitScript(() => { delete window.BroadcastChannel; });   // like a tab with an old page
  await deaf.goto(new URL('/', tab1.url()).href);
  await deaf.getByText('Fotógrafo Sessão').filter({ visible: true }).first().waitFor({ timeout: 15000 });
  await tab2.getByText('Sair', { exact: true }).filter({ visible: true }).first().click();
  await onLogin(tab2);
  await login(tab2, emails.admin);
  await area(tab2, 'ADMINISTRADOR');
  await area(tab1, 'ADMINISTRADOR');
  check(true, 'uma conta por navegador: as abas do painel mostram a mesma');
  await deaf.evaluate(() => window.dispatchEvent(new Event('focus')));
  await deaf.getByText('Admin Sessão').filter({ visible: true }).first().waitFor({ timeout: 15000 });
  check(true, 'sem o aviso, a aba se atualizou ao receber o foco');

  console.log('8. Login: seta para voltar ao site e "Manter conectado"');
  await tab2.getByText('Sair', { exact: true }).filter({ visible: true }).first().click();
  await onLogin(tab2);
  await tab2.getByRole('link', { name: /Voltar ao site/ }).filter({ visible: true }).click();
  await tab2.waitForURL((u) => u.pathname === '/', { timeout: 15000 });
  check(true, 'a seta no canto do login volta ao site');
  const sessionCookie = async () => (await context.cookies('http://localhost:8000/api')).find((c) => c.httpOnly);
  await tab2.goto(new URL('/login', tab1.url()).href);
  await login(tab2, emails.admin);
  await area(tab2, 'ADMINISTRADOR');
  check((await sessionCookie()).expires === -1, 'sem a caixa marcada: o cookie acaba quando o navegador fecha');
  await tab2.getByText('Sair', { exact: true }).filter({ visible: true }).first().click();
  await onLogin(tab2);
  await tab2.getByRole('checkbox', { name: /Manter conectado/ }).filter({ visible: true }).click();
  await login(tab2, emails.admin);
  await area(tab2, 'ADMINISTRADOR');
  const days = ((await sessionCookie()).expires * 1000 - Date.now()) / 86400000;
  check(days > 29 && days <= 30, `com "Manter conectado": o cookie dura 30 dias (${days.toFixed(1)})`);
  await tab2.goto(new URL('/login', tab1.url()).href);
  await area(tab2, 'ADMINISTRADOR');
  check(true, 'já conectado, abrir o /login leva direto à área da conta');

  console.log('9. Sem uso: aviso "Você ainda está aí?" um minuto antes, e desconexão no fim');
  const idleCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });   // its own cookies and storage
  const idlePage = await idleCtx.newPage();
  await idlePage.clock.install();                    // the page's clock moves only when the test says so
  await idlePage.goto(new URL('/login', tab1.url()).href);
  await login(idlePage, emails.admin);
  await area(idlePage, 'ADMINISTRADOR');
  const minutes = (await (await idlePage.request.get(`${API}/auth/me`)).json()).idle_minutes;
  check(minutes > 0, `sem "Manter conectado", a sessão tem limite de ${minutes} min sem uso`);
  await idlePage.clock.fastForward((minutes * 60 - 50) * 1000);
  await idlePage.getByText('Você ainda está aí?').waitFor({ timeout: 15000 });
  check(true, 'um minuto antes, o aviso pergunta se a pessoa ainda está ali');
  // 28/10/2026: the card stays until the button (moving the mouse does not answer it), counting 1 s at a time.
  const leftNow = async () => {
    const t = await idlePage.getByText(/Faltam \d+:\d\d/).filter({ visible: true }).first().innerText();
    const [m, sec] = t.match(/(\d+):(\d\d)/).slice(1).map(Number);
    return m * 60 + sec;
  };
  const before = await leftNow();
  await idlePage.mouse.move(200, 200);
  await idlePage.mouse.move(600, 400);
  await idlePage.keyboard.press('Shift');
  await idlePage.clock.fastForward(1000);
  check(await idlePage.getByText('Você ainda está aí?').isVisible(), 'mexer o mouse ou o teclado não fecha o aviso');
  await idlePage.clock.fastForward(1000);
  const after = await leftNow();
  check(after === before - 2, `a contagem desce de 1 em 1 segundo (${before} s → ${after} s em 2 s)`);
  await idlePage.getByRole('button', { name: 'Continuar conectado' }).click();
  await idlePage.getByText('Você ainda está aí?').waitFor({ state: 'hidden' });
  check(true, '"Continuar conectado" mantém a sessão');
  // The server has the last word: its record of use is pushed back past the limit, as if nobody had used it.
  execFileSync(join(BACKEND, '.venv/bin/python'), ['-c', `
from datetime import datetime, timedelta, timezone
from sqlalchemy import select, update
from app.db.models import Account, Session
from app.db.session import get_engine
with get_engine().begin() as c:
    who = c.execute(select(Account.id).where(Account.email == "${emails.admin}")).scalar_one()
    c.execute(update(Session).where(Session.account_id == who).values(last_activity_at=datetime.now(timezone.utc) - timedelta(minutes=${minutes} + 1)))
`], { cwd: BACKEND });
  await idlePage.clock.fastForward((minutes * 60 + 20) * 1000);
  await onLogin(idlePage);
  await idlePage.getByText(/desconectado depois de \d+ minutos sem uso/).filter({ visible: true }).first().waitFor({ timeout: 15000 });
  check(true, 'sem uso até o fim: desconectada, e o login explica por quê');
  await idleCtx.close();

  console.log('10. Fechar o navegador desconecta quem não marcou "Manter conectado", mesmo com o cookie restaurado');
  // The context keeps its cookies after its pages close: exactly what a browser that reopens "where it left off" does.
  const plainCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const keptCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const plain = await plainCtx.newPage();
  const kept = await keptCtx.newPage();
  for (const [page, remember] of [[plain, false], [kept, true]]) {
    await page.goto(new URL('/login', tab1.url()).href);
    await page.getByLabel('E-mail', { exact: true }).filter({ visible: true }).fill(emails.admin);
    await page.getByLabel('Senha', { exact: true }).filter({ visible: true }).fill(PASSWORD);
    if (remember) await page.getByRole('checkbox', { name: /Manter conectado/ }).filter({ visible: true }).click();
    await page.getByRole('button', { name: 'Entrar', exact: true }).filter({ visible: true }).click();
    await area(page, 'ADMINISTRADOR');
  }
  await plain.reload();
  await area(plain, 'ADMINISTRADOR');
  check(true, 'recarregar a página não desconecta');
  const panelUrl = plain.url();
  await plain.close();
  await kept.close();
  await new Promise((r) => setTimeout(r, 17000));   // more than the 15 s a reload has to come back
  const reopened = await plainCtx.newPage();
  await reopened.goto(panelUrl);
  await onLogin(reopened);
  check(true, 'sem "Manter conectado": reabrir o navegador cai no login');
  const reopenedKept = await keptCtx.newPage();
  await reopenedKept.goto(panelUrl);
  await area(reopenedKept, 'ADMINISTRADOR');
  check(true, 'com "Manter conectado": continua conectado');
  await plainCtx.close();
  await keptCtx.close();

  console.log('\nTUDO CERTO — uma conta por navegador, todas as abas seguem essa conta, e o site público mostra quem está conectado.');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
