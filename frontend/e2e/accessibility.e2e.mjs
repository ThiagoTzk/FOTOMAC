// 01/11/2026: the WCAG checks axe cannot do by itself (the author asked whether the site passes WCAG 2). Keyboard only
// (focus always visible, "Pular para o conteúdo", Enter on links, Tab kept inside a window, the arrows in a dropdown),
// zoom 200% and reflow at 320 px, and the accessibility menu (text at 200% with bold, contrast, spacing and
// underlined links, kept only in the browser).
//
//   node e2e/accessibility.e2e.mjs [pasta-capturas]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const SHOTS = process.argv[2] ?? 'e2e-screenshots/accessibility';
mkdirSync(SHOTS, { recursive: true });
const API = 'http://localhost:8000/api/v1', WEB = 'http://localhost:8081';
const BACKEND = fileURLToPath(new URL('../../backend/', import.meta.url));
const OUT = join(BACKEND, 'outbox');
const problems = [];
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok ' : 'XX '} ${msg}`); if (!cond) problems.push(msg); };

function account(role) {
  const email = `e2e.wcag.${role}.${Date.now()}@cesmac.edu.br`;
  execFileSync(join(BACKEND, '.venv/bin/python'), ['scripts/create_account.py', '--name', `Auditoria ${role}`, '--email', email, '--role', role,
                                                    '--signature', 'Auditoria'], { cwd: BACKEND });
  const mail = readdirSync(OUT).filter((x) => x.endsWith('.eml')).map((x) => join(OUT, x))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).find((x) => readFileSync(x, 'utf8').includes(`To: ${email}`));
  return readFileSync(mail, 'utf8').match(/primeiro-acesso\?token=([\w-]+)/)[1];
}

async function staffPage(browser, viewport, a11y) {
  const ctx = await browser.newContext({ viewport });
  if (a11y) await ctx.addInitScript((v) => localStorage.setItem('fotomac-a11y', v), JSON.stringify(a11y));
  const page = await ctx.newPage();
  const r = await page.request.post(`${API}/auth/first-access`, { data: { token: account('admin'), password: 'Fotomac#2026', password_confirmation: 'Fotomac#2026' } });
  if (!r.ok()) throw new Error(`ativação ${r.status()}`);
  return page;
}

const focusInfo = (page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  // A text field shows the ring on its rounded box (data-field, 06/11/2026), not on the <input> inside it.
  const cs = getComputedStyle(el.closest('[data-field]') && el.matches('input, textarea') ? el.closest('[data-field]') : el);
  return { name: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.id || '').trim().slice(0, 50).replace(/\n/g, ' '),
           role: el.getAttribute('role') || el.tagName.toLowerCase(), ring: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2,
           inDialog: !!el.closest('[role="dialog"][aria-label]'), id: el.id };
});

// Something wider than the window that is not inside a box that scrolls sideways on purpose (the theme carousel).
const overflow = (page) => page.evaluate(() => {
  const w = window.innerWidth, out = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.right <= w + 2) continue;
    let p = el.parentElement, scrolls = false;
    while (p) { const s = getComputedStyle(p); if (s.overflowX === 'auto' || s.overflowX === 'scroll' || s.overflowX === 'hidden') { if (p.scrollWidth > p.clientWidth + 2 || s.overflowX === 'hidden') { scrolls = true; break; } } p = p.parentElement; }
    if (!scrolls) out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.innerText || '').trim().slice(0, 30)}" até ${Math.round(r.right)}px`);
  }
  return out.slice(0, 5);
});

const browser = await chromium.launch();
try {
  console.log('1. Teclado no painel');
  const admin = await staffPage(browser, { width: 1366, height: 900 });
  const ev = (await (await admin.request.get(`${API}/events?scope=all`)).json()).items[0];
  await admin.goto(`${WEB}/painel`, { waitUntil: 'networkidle' });
  await admin.keyboard.press('Tab');
  let f = await focusInfo(admin);
  ok(f?.name === 'Pular para o conteúdo', `primeira parada do Tab: "Pular para o conteúdo" (achou "${f?.name}")`);
  await admin.screenshot({ path: `${SHOTS}/01-pular.png` });
  await admin.keyboard.press('Enter');
  f = await focusInfo(admin);
  ok(f?.id === 'conteudo', 'Enter leva o foco ao conteúdo da página');
  await admin.keyboard.press('Tab');
  f = await focusInfo(admin);
  ok(f && !['Visão geral', 'Eventos'].includes(f.name), `depois de pular, o próximo Tab já está no conteúdo ("${f?.name}")`);

  for (const path of ['/painel', '/eventos', `/eventos/${ev.id}`, `/eventos/${ev.id}?aba=configuracao`, '/contas', '/suporte', '/perfil', '/pessoas-institucionais']) {
    await admin.goto(WEB + path, { waitUntil: 'networkidle' });
    await admin.waitForTimeout(800);
    const noRing = new Set(), visited = [];
    for (let i = 0; i < 80; i++) {
      await admin.keyboard.press('Tab');
      const x = await focusInfo(admin);
      if (!x) continue;
      const key = `${x.role}:${x.name}`;
      if (visited[0] === key && i > 3) break;
      visited.push(key);
      if (!x.ring) noRing.add(key);
    }
    ok(noRing.size === 0, `${path}: ${visited.length} paradas do Tab, todas com o contorno de foco${noRing.size ? ` (sem: ${[...noRing].slice(0, 4).join(' | ')})` : ''}`);
  }
  await admin.goto(`${WEB}/painel`, { waitUntil: 'networkidle' });
  await admin.keyboard.press('Tab');
  await admin.screenshot({ path: `${SHOTS}/02-foco.png` });

  console.log('2. Janelas (diálogos) pelo teclado');
  await admin.getByRole('button', { name: 'Acessibilidade' }).focus();
  await admin.keyboard.press('Enter');
  await admin.getByRole('dialog', { name: 'Acessibilidade' }).waitFor();
  await admin.waitForTimeout(300);
  let inside = true;
  for (let i = 0; i < 14; i++) { await admin.keyboard.press('Tab'); inside = inside && !!(await focusInfo(admin))?.inDialog; }
  ok(inside, 'com a janela aberta, o Tab fica dentro dela');
  await admin.screenshot({ path: `${SHOTS}/03-janela-foco.png` });
  await admin.keyboard.press('Escape');
  await admin.waitForTimeout(400);
  ok(await admin.getByRole('dialog', { name: 'Acessibilidade' }).count() === 0, 'Esc fecha a janela');
  ok((await focusInfo(admin))?.name === 'Acessibilidade', `o foco volta ao botão que abriu (achou "${(await focusInfo(admin))?.name}")`);

  await admin.goto(`${WEB}/eventos`, { waitUntil: 'networkidle' });
  await admin.getByRole('button', { name: 'Quais eventos' }).focus();
  await admin.keyboard.press('Enter');
  await admin.getByRole('menuitem').first().waitFor();
  await admin.waitForTimeout(200);
  const firstOpt = await focusInfo(admin);
  ok(firstOpt?.role === 'menuitem', `lista suspensa: ao abrir, o foco vai para a primeira opção ("${firstOpt?.name}")`);
  await admin.keyboard.press('ArrowDown');
  const second = await focusInfo(admin);
  ok(second?.role === 'menuitem' && second.name !== firstOpt?.name, `lista suspensa: seta para baixo vai à próxima ("${second?.name}")`);
  await admin.keyboard.press('Enter');
  await admin.waitForTimeout(500);
  ok(await admin.getByRole('menuitem').count() === 0 && (await focusInfo(admin))?.name === 'Quais eventos',
     `lista suspensa: Enter escolhe, fecha e devolve o foco ao campo ("${(await focusInfo(admin))?.name}")`);
  await admin.keyboard.press('Enter');
  await admin.getByRole('menuitem').first().waitFor();
  await admin.keyboard.press('Escape');
  await admin.waitForTimeout(300);
  ok(await admin.getByRole('menuitem').count() === 0 && (await focusInfo(admin))?.name === 'Quais eventos', 'lista suspensa: Esc fecha e devolve o foco');

  console.log('2b. Enter nos links');
  const kb = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  await kb.goto(WEB + '/', { waitUntil: 'networkidle' });
  await kb.getByRole('link', { name: 'Eventos', exact: true }).first().focus();
  await kb.keyboard.press('Enter');
  await kb.waitForURL('**/explorar', { timeout: 5000 }).catch(() => undefined);
  ok(kb.url().endsWith('/explorar'), `Enter num link do menu abre a página (${kb.url()})`);
  await kb.goto(WEB + '/', { waitUntil: 'networkidle' });
  await kb.keyboard.press('Tab');
  await kb.keyboard.press('Enter');
  await kb.waitForTimeout(300);
  ok((await focusInfo(kb))?.id === 'conteudo', 'site público: "Pular para o conteúdo" com Enter');

  await admin.getByRole('button', { name: /Notificações|Avisos/ }).first().focus().catch(() => undefined);
  console.log('2c. Menu de acessibilidade: vale na hora, fica neste navegador, "Restaurar o padrão" desfaz');
  await kb.goto(WEB + '/', { waitUntil: 'networkidle' });
  const sent = [];
  kb.on('request', (r) => { if ((r.postData() ?? '').includes('a11y') || r.url().includes('a11y')) sent.push(r.url()); });
  await kb.getByRole('button', { name: 'Acessibilidade' }).click();
  await kb.getByRole('button', { name: 'Aumentar o texto' }).click();
  await kb.getByRole('switch', { name: 'Alto contraste' }).click();
  // On a computer the text sits inside the scaled page (theme/accessibility.ts): 125% of 0.93, relative to 0.875.
  ok(await kb.evaluate(() => Math.abs(Number(document.documentElement.style.getPropertyValue('--fm-text-scale')) - (1.25 * 0.93) / 0.875) < 0.001
                      && document.documentElement.hasAttribute('data-a11y-contrast')), 'texto em 125% e alto contraste valem na hora');
  ok(await kb.getByRole('switch', { name: 'Alto contraste' }).getAttribute('aria-checked') === 'true', 'o leitor de tela ouve "ligado"');
  const bold = kb.getByRole('switch', { name: 'Texto em negrito' });
  await bold.focus();
  await kb.keyboard.press('Space');
  const boldOn = await bold.getAttribute('aria-checked');
  await kb.keyboard.press('Space');
  ok(boldOn === 'true' && await bold.getAttribute('aria-checked') === 'false', 'a tecla Espaço liga e desliga a chave');
  await kb.reload({ waitUntil: 'networkidle' });
  ok(await kb.evaluate(() => document.documentElement.hasAttribute('data-a11y-contrast')), 'a escolha continua depois de recarregar');
  await kb.getByRole('button', { name: 'Acessibilidade' }).click();
  await kb.getByRole('button', { name: 'Restaurar o padrão' }).click();
  ok(await kb.evaluate(() => !document.documentElement.hasAttribute('data-a11y-contrast') && !localStorage.getItem('fotomac-a11y')?.includes('true')),
     '"Restaurar o padrão" volta tudo');
  ok((await focusInfo(kb))?.name === 'Aumentar o texto', `depois de "Restaurar o padrão", o foco continua na janela ("${(await focusInfo(kb))?.name}")`);
  for (let i = 0; i < 5; i++) { await kb.keyboard.press('Enter'); await kb.waitForTimeout(250); }   // past 200%: off, still focused
  ok((await focusInfo(kb))?.name === 'Aumentar o texto', 'no teclado, chegar a 200% não tira o foco da janela');
  await kb.getByRole('button', { name: 'Restaurar o padrão' }).focus();
  await kb.keyboard.press('Enter');
  await kb.waitForTimeout(250);
  await kb.keyboard.press('Escape');
  await kb.waitForTimeout(400);
  ok(await kb.getByRole('dialog', { name: 'Acessibilidade' }).count() === 0, 'Esc fecha o menu depois de usar só o teclado');
  ok(sent.length === 0, 'nenhuma escolha de acessibilidade vai ao servidor (LGPD)');

  // 01/11/2026, the author's test: after a few pages, each A+ opened one more window (one per page kept in the history).
  for (const name of ['Eventos', 'Como funciona', 'Início']) {
    await kb.getByRole('link', { name, exact: true }).first().click();
    await kb.waitForTimeout(800);
  }
  await kb.getByRole('button', { name: 'Acessibilidade' }).last().click();
  const windows = [];
  for (const dir of ['Aumentar', 'Aumentar', 'Aumentar', 'Aumentar', 'Diminuir', 'Diminuir', 'Diminuir', 'Diminuir']) {
    await kb.getByRole('button', { name: `${dir} o texto` }).last().click();
    await kb.waitForTimeout(500);
    windows.push(await kb.getByRole('dialog', { name: 'Acessibilidade' }).count());
  }
  ok(windows.every((n) => n === 1), `depois de passar por várias páginas, A+ e A- mantêm uma janela só (${windows.join(',')})`);
  await kb.getByRole('button', { name: 'Fechar', exact: true }).click();
  await kb.waitForTimeout(400);
  ok(await kb.getByRole('dialog', { name: 'Acessibilidade' }).count() === 0, 'um "Fechar" fecha o menu');

  console.log('2d. Chaves salvas no servidor: o leitor de tela ouve o estado novo no toque');
  const mine = await (await admin.request.post(`${API}/events`, { multipart: {
    name: `Acessibilidade E2E ${Date.now()}`, theme_ids: String((await (await admin.request.get(`${API}/themes`)).json())[0].id),
    date_precision: 'day', date_start: '2030-12-20', location: 'Campus I', description: 'Evento do teste automatizado.',
    cover: { name: 'capa.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(await admin.evaluate(() => {   // a plain JPEG drawn here
      const c = Object.assign(document.createElement('canvas'), { width: 1200, height: 800 });
      const g = c.getContext('2d'); g.fillStyle = '#0070B0'; g.fillRect(0, 0, 1200, 800);
      return c.toDataURL('image/jpeg', 0.9).split(',')[1];
    }), 'base64') } } })).json();
  if (!mine.id) throw new Error(`evento de teste não foi criado: ${JSON.stringify(mine).slice(0, 200)}`);
  await admin.goto(`${WEB}/eventos/${mine.id}?aba=configuracao`, { waitUntil: 'networkidle' });
  const sw = admin.getByRole('switch', { name: 'Colaboração' });
  ok(await sw.getAttribute('aria-checked') === 'false', 'ao abrir, a chave já diz o estado salvo (desligada)');
  await admin.route('**/collaboration', async (r) => { await new Promise((done) => setTimeout(done, 1200)); await r.continue(); });   // a slow server
  const states = [];
  for (const want of [true, false]) {
    await sw.focus();
    await admin.keyboard.press('Space');
    await admin.waitForTimeout(100);
    states.push((await sw.getAttribute('aria-checked')) === String(want));
    await admin.waitForTimeout(1600);
    states.push((await (await admin.request.get(`${API}/events/${mine.id}`)).json()).collaboration_open === want);
  }
  ok(states.every(Boolean), 'a chave mostra o estado novo já no toque, e o servidor guarda o mesmo (ligar e desligar)');
  await admin.unroute('**/collaboration');
  await admin.route('**/collaboration', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"falhou"}' }));
  await sw.focus();
  await admin.keyboard.press('Space');
  await admin.waitForTimeout(800);
  ok(await sw.getAttribute('aria-checked') === 'false', 'se o servidor falha, a chave volta ao estado salvo');
  await admin.unroute('**/collaboration');

  console.log('3. Zoom de 200% (janela de 683 px) e 320 px de largura');
  const pub = await (await browser.newContext({ viewport: { width: 683, height: 450 } })).newPage();
  for (const [page, path, w] of [[pub, '/', 683], [pub, '/explorar', 683], [pub, '/como-funciona', 683], [pub, '/privacidade', 683], [pub, `/evento/${ev.id}`, 683],
                                [pub, '/login', 683], [pub, '/', 320], [pub, `/evento/${ev.id}`, 320], [pub, '/login', 320]]) {
    await page.setViewportSize({ width: w, height: w === 320 ? 640 : 450 });
    await page.goto(WEB + path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    const o = await overflow(page);
    ok(o.length === 0, `${w}px ${path}: nada passa da largura da janela${o.length ? ` (${o.join('; ')})` : ''}`);
    await page.screenshot({ path: `${SHOTS}/zoom-${w}-${path.replace(/\W+/g, '_') || 'home'}.png`, fullPage: false });
  }
  for (const w of [683, 320]) {
    await admin.setViewportSize({ width: w, height: w === 320 ? 640 : 450 });
    for (const path of ['/painel', '/eventos', `/eventos/${ev.id}`, '/contas', '/suporte']) {
      await admin.goto(WEB + path, { waitUntil: 'networkidle' });
      await admin.waitForTimeout(800);
      const o = await overflow(admin);
      ok(o.length === 0, `${w}px painel ${path}: nada passa da largura da janela${o.length ? ` (${o.join('; ')})` : ''}`);
      await admin.screenshot({ path: `${SHOTS}/zoom-${w}-painel${path.replace(/\W+/g, '_')}.png` });
    }
  }

  console.log('4. Texto em 200% e espaçamento (menu de acessibilidade), janela de 1366 px');
  const big = await staffPage(browser, { width: 1366, height: 900 }, { text: 2, bold: true, contrast: true, spacing: true, underline: true });
  for (const path of ['/', '/explorar', `/evento/${ev.id}`, '/login', '/painel', '/eventos', `/eventos/${ev.id}`, '/contas', '/suporte']) {
    await big.goto(WEB + path, { waitUntil: 'networkidle' });
    await big.waitForTimeout(1200);
    const o = await overflow(big);
    ok(o.length === 0, `texto 200% ${path}: nada passa da largura da janela${o.length ? ` (${o.join('; ')})` : ''}`);
    await big.screenshot({ path: `${SHOTS}/texto200${path.replace(/\W+/g, '_') || '_home'}.png` });
  }
} catch (e) {
  console.error(e.message);
  problems.push(e.message);
} finally {
  await browser.close();
  console.log(problems.length ? `\n${problems.length} problema(s)` : '\nTUDO CERTO: teclado, zoom de 200%, 320 px e o menu de acessibilidade.');
  if (problems.length) process.exitCode = 1;
}
