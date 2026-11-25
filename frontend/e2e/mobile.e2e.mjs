// 06/11/2026: the site in a phone's browser. Every screen, opened as visitor, photographer, administrator
// and temporary account, with the windows that open over the page, in six phone and tablet sizes, must fit: nothing
// may cross the left or right edge (a strip that scrolls sideways on purpose is fine). Text fields get the focus ring
// on their rounded box, never a square inside it. Only NASA public-domain photos (backend/tests/fixtures) and
// synthetic files: no real person in the screenshots.
//
//   node e2e/mobile.e2e.mjs <capa.jpg> [pasta-capturas]
//
// Chromium imitating an iPhone, not Safari: check the real phone too.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(join(ROOT, 'frontend/package.json'));
const { chromium } = require('playwright');
const [COVER, OUT = 'e2e-screenshots/mobile'] = process.argv.slice(2);
if (!COVER) throw new Error('uso: node e2e/mobile.e2e.mjs <capa.jpg> [pasta-capturas]');
mkdirSync(OUT, { recursive: true });
const API = 'http://localhost:8000/api/v1';
const WEB = 'http://localhost:8081';
const BACKEND = join(ROOT, 'backend');
const OUTBOX = join(BACKEND, 'outbox');
const FIX = join(BACKEND, 'tests/fixtures');
const PASSWORD = 'Fotomac#2026';
const stamp = Date.now();
const crew = readFileSync(join(FIX, 'apollo11_crew.jpg'));
const eileen = readFileSync(join(FIX, 'astronaut_eileen_collins.png'));
const cover = readFileSync(COVER);
const clip = join(OUT, 'crew.mp4');
execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-loop', '1', '-i', join(FIX, 'apollo11_crew.jpg'), '-t', '4', '-r', '10',
  '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', clip]);

function token(email) {
  const files = readdirSync(OUTBOX).filter((f) => f.endsWith('.eml')).map((f) => join(OUTBOX, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const f of files) { const m = readFileSync(f, 'utf8'); if (m.includes(`To: ${email}`)) return m.match(/primeiro-acesso\?token=([\w-]+)/)[1]; }
  throw new Error(`sem link para ${email}`);
}
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };
async function phone() { return (await browser.newContext(PHONE)).newPage(); }
async function person(name, role, signature = name) {
  const email = `e2e.tour.${name.split(' ')[0].toLowerCase()}.${stamp}@cesmac.edu.br`;
  const args = ['scripts/create_account.py', '--name', name, '--email', email, '--role', role];
  if (role !== 'admin') args.push('--signature', signature);
  execFileSync(join(BACKEND, '.venv/bin/python'), args, { cwd: BACKEND });
  const p = await phone();
  const ok = await p.request.post(`${API}/auth/first-access`, { data: { token: token(email), password: PASSWORD, password_confirmation: PASSWORD } });
  if (!ok.ok()) throw new Error(`ativar ${name}`);
  return p;
}
let n = 0;
const done = [];
const overflow = [];
// 06/11/2026: "o site inteiro tem que caber certinho em diferentes modelos". Every screen is checked in
// these sizes: small phone, common Android, iPhone, large iPhone, tablet upright and tablet lying down. The full
// screenshots are taken at 390 px; the other sizes get one screenshot of the top.
const SIZES = [[390, 844], [320, 568], [360, 780], [430, 932], [768, 1024], [1024, 768]];
async function fits(p, name, w) {
  // Anything wider than the phone: the deepest elements that cross the left or right edge, with their text.
  const over = await p.evaluate(() => {
    const W = document.documentElement.clientWidth, out = [];
    for (const e of document.querySelectorAll('body *')) {
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(e).visibility === 'hidden') continue;
      if (r.right <= W + 1 && r.left >= -1) continue;
      if (r.right < 0 && /Pular para o conteúdo/.test(e.innerText || '')) continue;   // the skip link waits off screen on purpose
      if ([...e.children].some((c) => { const q = c.getBoundingClientRect(); return q.width && (q.right > W + 1 || q.left < -1); })) continue;
      let clip = false;
      for (let a = e.parentElement; a; a = a.parentElement) {
        const cs = getComputedStyle(a);
        // A strip that scrolls sideways on purpose scrolls ONLY sideways: a box that scrolls down (the capture window at
        // 320 px) cut the camera at the sides and passed as "scrolls" (06/11/2026).
        if (/(hidden|auto|scroll|clip)/.test(cs.overflowX) && a !== document.body) { const q = a.getBoundingClientRect(); if (q.right <= W + 1 && q.left >= -1) { clip = /(auto|scroll)/.test(cs.overflowX) && !/(auto|scroll)/.test(cs.overflowY) ? 'rola' : true; break; } }
      }
      if (clip === 'rola') continue;   // inside a strip that scrolls sideways, on purpose
      out.push(`${clip ? '[cortado]' : '[vaza]'} ${Math.round(r.left)}..${Math.round(r.right)} ${(e.innerText || e.getAttribute('aria-label') || e.tagName).replace(/\s+/g, ' ').slice(0, 60)}`);
    }
    return [...new Set(out)].slice(0, 12);
  });
  if (over.length) overflow.push(`${name} @${w}px:\n    ` + over.join('\n    '));
  // A title under a button (06/11/2026: "Baixar acervo" covered the word "Imagens"). The text is measured by its letters,
  // not by its box: the box had shrunk to 30 px and the word ran out of it, under the button.
  const covered = await p.evaluate(() => {
    const out = [];
    const titles = [...document.querySelectorAll('[role="heading"], h1, h2, h3')];
    const buttons = [...document.querySelectorAll('[role="button"], button')].filter((b) => b.getBoundingClientRect().width);
    for (const t of titles) {
      const range = document.createRange(); range.selectNodeContents(t);
      const r = range.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      for (const b of buttons) {
        if (b.contains(t) || t.contains(b)) continue;
        // A button of an open menu or window over a title of the page behind it: on top on purpose.
        const layer = b.closest('[aria-modal="true"]');
        if (layer && !layer.contains(t)) continue;
        const q = b.getBoundingClientRect();
        if (r.left < q.right - 1 && q.left < r.right - 1 && r.top < q.bottom - 1 && q.top < r.bottom - 1) {
          out.push(`"${t.innerText.trim().slice(0, 40)}" sob o botão "${(b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 40)}"`);
        }
      }
    }
    return [...new Set(out)].slice(0, 6);
  });
  if (covered.length) overflow.push(`${name} @${w}px (título coberto):\n    ` + covered.join('\n    '));
  // A title squeezed by something beside it, one word per line (06/11/2026: "Suas fotos" beside "Buscar de novo").
  const squeezed = await p.evaluate(() => [...document.querySelectorAll('[role="heading"], h1, h2, h3')].filter((t) => {
    const r = t.getBoundingClientRect(), line = parseFloat(getComputedStyle(t).lineHeight) || 24;
    return r.width > 0 && r.width < 130 && r.height > line * 1.8 && t.innerText.trim().length > 8;
  }).map((t) => t.innerText.replace(/\s+/g, ' ').trim().slice(0, 40)));
  if (squeezed.length) overflow.push(`${name} @${w}px (título espremido):\n    ` + squeezed.join('\n    '));
  // A list or window over the page must end inside the screen: its end would be out of reach (06/11/2026, the bell).
  const below = await p.evaluate(() => {
    const H = document.documentElement.clientHeight;
    return [...document.querySelectorAll('[aria-modal="true"], [role="menu"]')].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width && r.height && (r.bottom > H + 1 || r.top < -1);
    }).map((e) => (e.getAttribute('aria-label') || e.innerText || '').replace(/\s+/g, ' ').slice(0, 50));
  });
  if (below.length) overflow.push(`${name} @${w}px (janela passa da altura da tela):\n    ` + below.join('\n    '));
}
async function shot(p, name, url) {
  if (url) await p.goto(`${WEB}${url}`, { waitUntil: 'networkidle' }).catch(() => undefined);
  await p.waitForTimeout(900);
  n += 1;
  const file = `${String(n).padStart(2, '0')}-${name}.png`;
  for (const [w, h] of SIZES) {
    if (w !== 390) {
      await p.setViewportSize({ width: w, height: h });
      await p.waitForTimeout(500);
    }
    await fits(p, name, w);
    if (w !== 390) { await p.screenshot({ path: join(OUT, file.replace('.png', `_${w}.png`)) }); continue; }
    // The page scrolls inside a box (React Native Web), not the window: scroll the tallest scrollable box, one screen at a time.
    const steps = await p.evaluate(() => {
      const boxes = [...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 20
        && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.clientHeight > 200);
      const box = boxes.sort((a, b) => b.clientHeight - a.clientHeight)[0] ?? document.scrollingElement;
      window.__box = box;
      box.scrollTop = 0;
      return Math.min(8, Math.ceil(box.scrollHeight / (box.clientHeight * 0.92)));
    });
    for (let k = 0; k < steps; k++) {
      await p.evaluate((k) => { window.__box.scrollTop = k * window.__box.clientHeight * 0.92; }, k);
      await p.waitForTimeout(250);
      await p.screenshot({ path: join(OUT, file.replace('.png', `_p${k}.png`)) });
    }
    await p.evaluate(() => { window.__box.scrollTop = 0; });
  }
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(300);
  done.push(`${file}  ${url ?? '(estado)'}`);
}

try {
  // A long credit, as when several photographers cover an event: it ran past the edge of the event page (06/11/2026).
  const owner = await person('Olivia Fotografa', 'photographer', 'Olivia Fotografa de Albuquerque, Equipe de Comunicação e Marketing');
  const admin = await person('Artur Admin', 'admin');
  const theme = (await (await owner.request.get(`${API}/themes`)).json())[0];
  const ev = await (await owner.request.post(`${API}/events`, { multipart: {
    name: `Tour celular ${stamp}`, theme_ids: String(theme.id), date_precision: 'day', date_start: '2026-10-21',
    location: 'Ginásio do Campus I', description: 'Evento de teste para as fotos de tela do celular.',
    cover: { name: 'capa.jpg', mimeType: 'image/jpeg', buffer: cover } } })).json();
  if (!ev.id) throw new Error('evento não criado: ' + JSON.stringify(ev));
  const img = await (await owner.request.post(`${API}/events/${ev.id}/images`, { multipart: { file: { name: 'crew.jpg', mimeType: 'image/jpeg', buffer: crew } } })).json();
  await owner.request.post(`${API}/events/${ev.id}/images`, { multipart: { file: { name: 'eileen.png', mimeType: 'image/png', buffer: eileen } } });
  const video = await (await owner.request.post(`${API}/events/${ev.id}/videos`, { multipart: { file: { name: 'crew.mp4', mimeType: 'video/mp4', buffer: readFileSync(clip) } } })).json();
  for (let i = 0; i < 90 && (await (await owner.request.get(`${API}/videos/${video.id}`)).json()).processing_status !== 'ready'; i++) await owner.waitForTimeout(1000);
  await owner.request.post(`${API}/events/${ev.id}/publish`, { data: {} });
  await owner.request.post(`${API}/events/${ev.id}/videos/publish`, { data: {} });
  for (let i = 0; i < 120 && (await owner.request.get(`${API}/public/events/${ev.id}`)).status() !== 200; i++) await owner.waitForTimeout(1000);
  for (let i = 0; i < 120 && (await (await owner.request.get(`${API}/videos/${video.id}`)).json()).indexing_status !== 'processed'; i++) await owner.waitForTimeout(1000);
  // A second event, under review, for the "Enviar" and review screens.
  const ev2 = await (await owner.request.post(`${API}/events`, { multipart: {
    name: `Tour conferência ${stamp}`, theme_ids: String(theme.id), date_precision: 'day', date_start: '2026-11-01',
    location: 'Auditório', description: 'Evento em conferência.', cover: { name: 'capa.jpg', mimeType: 'image/jpeg', buffer: cover } } })).json();
  await owner.request.post(`${API}/events/${ev2.id}/images`, { multipart: { file: { name: 'crew.jpg', mimeType: 'image/jpeg', buffer: crew } } });
  for (const [n, t] of [['eileen.png', 'image/png'], ['formats/sample.png', 'image/png'], ['formats/sample.webp', 'image/webp']]) {
    await owner.request.post(`${API}/events/${ev2.id}/images`, { multipart: { file: { name: n.split('/').pop(), mimeType: t, buffer: readFileSync(join(FIX, n === 'eileen.png' ? 'astronaut_eileen_collins.png' : n)) } } });
  }

  // ---------------------------------------------------------------- visitor
  const v = await phone();
  await shot(v, 'inicio', '/');
  await shot(v, 'explorar', '/explorar');
  // 06/11/2026: the "Período" window opened from its left edge and ran off the right side of the phone (seen in the app).
  await v.getByRole('button', { name: /^Filtrar/ }).filter({ visible: true }).first().click().catch(() => undefined);
  await v.getByRole('button', { name: /^Período/ }).filter({ visible: true }).first().click().catch(() => undefined);
  await shot(v, 'explorar-periodo');
  await shot(v, 'evento-visitante', `/evento/${ev.id}`);
  await shot(v, 'como-funciona', '/como-funciona');
  await shot(v, 'privacidade', '/privacidade');
  await shot(v, 'login', '/login');
  await shot(v, 'recuperar-senha', '/recuperar-senha');
  await shot(v, 'primeiro-acesso-link-invalido', '/primeiro-acesso?token=invalido');
  await shot(v, 'redefinir-senha-link-invalido', '/redefinir-senha?token=invalido');
  await shot(v, 'autorizacao-link-invalido', '/autorizacao?token=invalido');
  await shot(v, 'autorizacao-email-link-invalido', '/autorizacao/email?token=invalido');
  await shot(v, 'autorizacao-revogar', '/autorizacao/revogar');
  // The windows over the page (06/11/2026: the bell ran past the edge; nothing may).
  await v.goto(`${WEB}/`, { waitUntil: 'networkidle' });
  await v.getByRole('button', { name: 'Menu', exact: true }).filter({ visible: true }).first().click().catch(() => undefined);
  await shot(v, 'site-menu-aberto');
  await v.goto(`${WEB}/`, { waitUntil: 'networkidle' });
  await v.getByRole('button', { name: 'Acessibilidade', exact: true }).filter({ visible: true }).first().click().catch(() => undefined);
  await shot(v, 'site-acessibilidade');
  // The search: notice, camera, result (the answer of the capture is simulated, as in the e2e suites).
  await v.goto(`${WEB}/evento/${ev.id}`, { waitUntil: 'networkidle' });
  const button = (p, name) => p.getByRole('button', { name, exact: true }).filter({ visible: true }).first();
  await button(v, 'Buscar minhas fotos').click();
  await shot(v, 'busca-aviso');
  await button(v, 'Estou ciente').click();
  await v.waitForFunction(() => document.querySelector('video')?.readyState >= 2, null, { timeout: 20000 }).catch(() => undefined);
  await shot(v, 'busca-camera');
  // 06/11/2026: "Começar" right under the doll's face, before the tips, in every size.
  for (const [w, h] of SIZES) {
    await v.setViewportSize({ width: w, height: h });
    await v.waitForTimeout(400);
    const doll = await v.getByLabel(/^Bonequinho/).filter({ visible: true }).first().boundingBox();
    const start = await button(v, 'Começar').boundingBox();
    const tips = await v.getByText('Dicas para encontrar suas fotos').filter({ visible: true }).first().boundingBox();
    // …and on screen without scrolling, even on the smallest phone.
    if (!(doll && start && tips && start.y >= doll.y + doll.height - 30 && start.y - (doll.y + doll.height) < 80 && start.y < tips.y
      && start.y + start.height <= h)) {
      throw new Error(`FALHOU @${w}px: "Começar" não está logo abaixo do rosto do bonequinho (${JSON.stringify({ doll, start, tips })})`);
    }
  }
  await v.setViewportSize({ width: 390, height: 844 });
  console.log('  ok  "Começar" logo abaixo do rosto do bonequinho e visível sem rolar, nos 6 tamanhos');
  execFileSync(join(BACKEND, '.venv/bin/python'), ['-c', `
from sqlalchemy import text
from app.db.session import get_engine
with get_engine().begin() as c:
    c.execute(text("UPDATE visitor_sessions SET result_video_ids = ARRAY[CAST(:v AS uuid)], result_ids = ARRAY[CAST(:p AS uuid)] WHERE event_id = :e"), {"v": "${video.id}", "p": "${img.id}", "e": "${ev.id}"})`], { cwd: BACKEND });
  await v.route('**/capture/check', (r) => r.fulfill({ json: { ok: true, reason: null } }));
  await v.route('**/search', (r) => r.fulfill({ json: { items: [{ id: img.id, captured_at: null, credit: 'Foto por: Olivia Fotografa · Centro Universitário CESMAC' }],
    videos: [{ id: video.id, duration_seconds: 4, captured_at: null, credit: 'Vídeo por: Olivia Fotografa · Centro Universitário CESMAC' }] } }));
  await button(v, 'Começar').click();
  await v.waitForTimeout(2500);
  await shot(v, 'busca-captura-em-andamento');
  // Strict (06/11/2026): it used to swallow the wait, and the "result" screenshots showed the capture starting over.
  // The capture above went through every size, upright tablet to lying down included: it must survive that.
  await v.getByText(/encontrad/).filter({ visible: true }).first().waitFor({ timeout: 150000 })
    .catch(() => { throw new Error('FALHOU: o resultado da busca não apareceu (a captura recomeçou ao mudar o tamanho da tela?)'); });
  await shot(v, 'busca-resultado-fotos');
  // 06/11/2026: with the result on screen, "Procure suas fotos" goes away; "Buscar de novo" is by the result.
  for (const [w, h] of [[390, 844], [1440, 900]]) {
    await v.setViewportSize({ width: w, height: h });
    await v.waitForTimeout(500);
    if (await v.getByText('Procure suas fotos').filter({ visible: true }).count()) throw new Error(`FALHOU @${w}px: "Procure suas fotos" continua depois da busca`);
    if (!(await v.getByRole('button', { name: 'Buscar de novo' }).filter({ visible: true }).count())) throw new Error(`FALHOU @${w}px: sem "Buscar de novo" no resultado`);
    if (!(await v.getByText(/Use apenas a sua própria imagem/).filter({ visible: true }).count())) throw new Error(`FALHOU @${w}px: o aviso de uso some com o quadro`);
  }
  await v.setViewportSize({ width: 390, height: 844 });
  console.log('  ok  depois da busca: sem "Procure suas fotos", com "Buscar de novo" e o aviso de uso (celular e computador)');
  await v.getByRole('tab', { name: /Vídeos/ }).filter({ visible: true }).first().click().catch(() => undefined);
  await shot(v, 'busca-resultado-videos');
  await v.getByRole('tab', { name: /Fotos/ }).filter({ visible: true }).first().click().catch(() => undefined);
  await v.getByRole('button', { name: /Abrir foto 1/ }).filter({ visible: true }).first().click().catch(() => undefined);
  await shot(v, 'busca-foto-aberta');

  await v.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
  for (const label of ['E-mail', 'Senha']) {
    await v.getByLabel(label, { exact: true }).filter({ visible: true }).click();
    const ring = await v.evaluate(() => {
      const i = document.activeElement, box = i.closest('[data-field]');
      return { input: getComputedStyle(i).outlineStyle, box: box ? getComputedStyle(box).outlineStyle : 'sem caixa' };
    });
    if (ring.input !== 'none' || ring.box !== 'solid') throw new Error(`FALHOU: contorno do campo ${label}: ${JSON.stringify(ring)}`);
    console.log(`  ok  campo ${label}: contorno na borda arredondada, sem quadrado dentro`);
  }

  // ---------------------------------------------------------------- photographer
  await shot(owner, 'painel-visao-geral', '/painel');
  await owner.getByRole('button', { name: /menu/i }).filter({ visible: true }).first().click({ timeout: 3000 }).then(() => shot(owner, 'painel-menu-aberto')).catch(() => undefined);
  await shot(owner, 'painel-eventos', '/eventos');
  await shot(owner, 'painel-evento-novo', '/eventos/novo');
  await shot(owner, 'painel-evento', `/eventos/${ev.id}`);
  await shot(owner, 'painel-evento-editar', `/eventos/${ev.id}/editar`);
  await shot(owner, 'painel-enviar', `/eventos/${ev2.id}/enviar`);
  await shot(owner, 'painel-imagens', `/eventos/${ev2.id}/imagens`);
  // A published event also has "Baixar acervo" in the header, beside "Enviar imagens".
  await shot(owner, 'painel-imagens-publicado', `/eventos/${ev.id}/imagens`);
  await button(owner, 'Selecionar').click().catch(() => undefined);
  await owner.getByRole('button', { name: /^Selecionar todas/ }).filter({ visible: true }).first().click().catch(() => undefined);
  await shot(owner, 'painel-imagens-selecao');
  await owner.getByRole('button', { name: /^Borrar rostos nas selecionadas/ }).filter({ visible: true }).first().click().catch(() => undefined);
  await owner.waitForTimeout(3000);
  await shot(owner, 'painel-borrar-sequencia');
  await shot(owner, 'painel-imagem', `/eventos/${ev.id}/imagens/${img.id}`);
  await shot(owner, 'painel-videos', `/eventos/${ev.id}/videos`);
  await owner.getByRole('button', { name: /Assistir ao vídeo de/ }).filter({ visible: true }).first().click().catch(() => undefined);
  await owner.waitForTimeout(4000);
  await shot(owner, 'painel-video-player');
  await shot(owner, 'painel-processamento', `/eventos/${ev.id}/processamento`);
  await shot(owner, 'painel-download', `/eventos/${ev.id}/download`);
  await shot(owner, 'painel-configuracao', `/eventos/${ev.id}?aba=configuracao`);
  await shot(owner, 'painel-perfil', '/perfil');
  await shot(owner, 'painel-suporte', '/suporte');
  await owner.goto(`${WEB}/painel`, { waitUntil: 'networkidle' });
  await owner.getByRole('button', { name: /^Notificações/ }).filter({ visible: true }).first().click();
  await shot(owner, 'painel-sino-aberto');
  await owner.goto(`${WEB}/painel`, { waitUntil: 'networkidle' });
  await owner.getByRole('button', { name: 'Menu da conta' }).filter({ visible: true }).first().click();
  await shot(owner, 'painel-menu-da-conta');
  await owner.goto(`${WEB}/painel`, { waitUntil: 'networkidle' });
  await owner.getByRole('button', { name: 'Acessibilidade', exact: true }).filter({ visible: true }).first().click();
  await shot(owner, 'painel-acessibilidade');
  await owner.goto(`${WEB}/`, { waitUntil: 'networkidle' });
  await owner.getByRole('button', { name: 'Menu', exact: true }).filter({ visible: true }).first().click().catch(() => undefined);
  await shot(owner, 'site-menu-com-conta');

  // ---------------------------------------------------------------- administrator
  const created = await admin.request.post(`${API}/admin/institutional`, { multipart: {
    full_name: 'Eileen Collins Teste', position: 'Astronauta', unit: 'NASA', email: `e2e.tour.pessoa.${stamp}@cesmac.edu.br`,
    photos: { name: 'eileen.png', mimeType: 'image/png', buffer: eileen } } });
  const personId = created.ok() ? (await created.json()).id : null;
  await shot(admin, 'admin-visao-geral', '/painel');
  await shot(admin, 'admin-contas', '/contas');
  await shot(admin, 'admin-conta-nova', '/contas/nova');
  const mine = (await (await admin.request.get(`${API}/auth/me`)).json()).id;
  await shot(admin, 'admin-conta', `/contas/${mine}`);
  await shot(admin, 'admin-temas', '/temas');
  await shot(admin, 'admin-reconhecimento', '/reconhecimento');
  await shot(admin, 'admin-pessoas', '/pessoas-institucionais');
  await shot(admin, 'admin-pessoas-cadastro', '/pessoas-institucionais/cadastro');
  await shot(admin, 'admin-pessoa-nova', '/pessoas-institucionais/cadastro/nova');
  if (personId) await shot(admin, 'admin-pessoa-cadastro', `/pessoas-institucionais/cadastro/${personId}`);
  await shot(admin, 'admin-evento', `/eventos/${ev.id}`);

  // ---------------------------------------------------------------- temporary account (06/11/2026: its clock pushed
  // the photo and the name off the screen)
  const hiredEmail = `e2e.tour.contratado.${stamp}@cesmac.edu.br`;
  const acc = await admin.request.post(`${API}/admin/accounts`, { data: {
    full_name: 'Teo Contratado', email: hiredEmail, role: 'contractor', photographer_signature: 'Teo C.',
    bound_event_id: ev2.id, contract_number: 'CT-2026/077' } });
  if (acc.status() !== 201) throw new Error('conta temporária não criada: ' + await acc.text());
  const hired = await phone();
  const first = await hired.request.post(`${API}/auth/first-access`, { data: { token: token(hiredEmail), password: PASSWORD,
    password_confirmation: PASSWORD, cpf: '529.982.247-25', birth_date: '1990-05-20' } });   // valid digits, not a real person
  if (!first.ok()) throw new Error('ativar o contratado: ' + await first.text());
  await shot(hired, 'contratado-visao-geral', '/painel');
  if (!(await hired.getByText(/Conta temporária/).filter({ visible: true }).count())) throw new Error('FALHOU: o contador da conta temporária não aparece');
  await hired.getByRole('button', { name: /^Notificações/ }).filter({ visible: true }).first().click();
  await shot(hired, 'contratado-sino-aberto');
  await shot(hired, 'contratado-evento', `/eventos/${ev2.id}`);
  await shot(hired, 'contratado-enviar', `/eventos/${ev2.id}/enviar`);
  await shot(hired, 'contratado-imagens', `/eventos/${ev2.id}/imagens`);
  await shot(hired, 'contratado-perfil', '/perfil');
  if (overflow.length) throw new Error('FALHOU: passam da borda do celular ou cobrem um título:\n' + overflow.join('\n'));
  console.log(`  ok  ${done.length} telas: nada passa da borda do celular nem cobre um título`);
  console.log('\nTUDO OK');
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
