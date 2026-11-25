// 01/11/2026: the event on a map. Whoever creates the event finds the street by CEP, puts the pin on the entrance and
// writes how to find it; the visitor reads it and opens the map with a click. Nothing reaches the outside map service
// before that click, and only the creator sees the controls.
//
//   node e2e/map.e2e.mjs <capa.jpg> [pasta-capturas]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const [COVER, SHOTS = 'e2e-screenshots/map'] = process.argv.slice(2);
if (!COVER) throw new Error('uso: node e2e/map.e2e.mjs <capa.jpg> [pasta-capturas]');
mkdirSync(SHOTS, { recursive: true });
const API = 'http://localhost:8000/api/v1';
const WEB = 'http://localhost:8081';
const BACKEND = fileURLToPath(new URL('../../backend/', import.meta.url));
const OUTBOX = join(BACKEND, 'outbox');
const PASSWORD = 'Fotomac#2026';
const stamp = Date.now();
const NOTE = 'A entrada é vermelha, com a logo do ginásio.';
const check = (ok, msg) => { if (!ok) throw new Error(`FALHOU: ${msg}`); console.log(`  ok  ${msg}`); };

function token(email) {
  const files = readdirSync(OUTBOX).filter((f) => f.endsWith('.eml')).map((f) => join(OUTBOX, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const f of files) {
    const m = readFileSync(f, 'utf8');
    if (m.includes(`To: ${email}`)) return m.match(/primeiro-acesso\?token=([\w-]+)/)[1];
  }
  throw new Error(`sem link para ${email}`);
}

async function person(browser, name, role) {
  const email = `e2e.map.${role}.${name.split(' ')[0].toLowerCase()}.${stamp}@cesmac.edu.br`;
  execFileSync(join(BACKEND, '.venv/bin/python'),
               ['scripts/create_account.py', '--name', name, '--email', email, '--role', role, '--signature', name], { cwd: BACKEND });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  const ok = await page.request.post(`${API}/auth/first-access`, { data: { token: token(email), password: PASSWORD, password_confirmation: PASSWORD } });
  check(ok.ok(), `${name} ativado`);
  return page;
}

/** Every request that leaves this site: the map is ours, so the list must stay empty even with it open (RNF34). */
function watch(page) {
  const sent = [];
  page.on('request', (r) => { if (/^https?:/.test(r.url()) && new URL(r.url()).hostname !== 'localhost') sent.push(r.url()); });
  return sent;
}

const eventOf = async (page, id) => (await page.request.get(`${API}/events/${id}`)).json();
// WebGL with no graphics card, as on a server.
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  console.log('1. Quem criou o evento usa o CEP, o pin e a descrição');
  const bruno = await person(browser, 'Bruno Mapa', 'photographer');
  const themes = await (await bruno.request.get(`${API}/themes`)).json();
  const ev = await (await bruno.request.post(`${API}/events`, { multipart: {
    name: `Mapa E2E ${stamp}`, theme_ids: String(themes[0].id), date_precision: 'day', date_start: '2030-12-20', location: 'Ginásio do Campus I',
    description: 'Evento do teste automatizado.', cover: { name: 'capa.jpg', mimeType: 'image/jpeg', buffer: readFileSync(COVER) } } })).json();
  check(ev.latitude === null && ev.can_edit_map === true, 'o mapa é opcional: o evento nasce sem pin');

  const toService = watch(bruno);
  await bruno.goto(`${WEB}/eventos/${ev.id}/editar`, { waitUntil: 'networkidle' });
  await bruno.getByLabel('CEP do local').waitFor();
  check(toService.length === 0, 'abrir o formulário não fala com o serviço de mapa');

  await bruno.getByRole('button', { name: 'Abrir o mapa' }).click();
  await bruno.locator('.maplibregl-marker').waitFor({ timeout: 20000 });
  check(await bruno.getByRole('button', { name: 'Remover o pin' }).count() === 1, 'abrir o mapa já traz um pin para arrastar');
  await bruno.getByLabel('CEP do local').fill('57051160');
  check(await bruno.getByLabel('CEP do local').inputValue() === '57051-160', 'o CEP ganha o traço ao digitar');
  await bruno.getByRole('button', { name: 'Buscar CEP' }).click();
  await bruno.getByText(/Rua Cônego Machado.*arraste o pin/).waitFor({ timeout: 20000 });
  check(true, 'o CEP real acha a rua');
  await bruno.locator('canvas.maplibregl-canvas').waitFor({ timeout: 20000 });
  await bruno.waitForFunction(() => document.querySelector('.maplibregl-marker'));
  await bruno.waitForTimeout(1500);
  const seen = await bruno.evaluate(() => {
    const m = document.querySelector('.maplibregl-marker').getBoundingClientRect();
    const c = document.querySelector('canvas.maplibregl-canvas').getBoundingClientRect();
    return m.x > c.x && m.right < c.right && m.y > c.y && m.bottom < c.bottom;
  });
  check(seen, 'o CEP leva o pin junto: ele fica na tela, no ponto do CEP');
  check(toService.length === 0, `o mapa abriu com o pin no ponto do CEP, sem sair do FOTOMAC: ${toService[0] ?? 'nenhum pedido'}`);
  await bruno.waitForTimeout(2500);
  check(await bruno.getByLabel('Local', { exact: true }).inputValue() === 'Ginásio do Campus I', 'o local escrito à mão não é trocado pelo CEP');
  await bruno.locator('canvas.maplibregl-canvas').scrollIntoViewIfNeeded();
  await bruno.screenshot({ path: join(SHOTS, '01-cep.png'), fullPage: true });

  const pinAt = () => bruno.evaluate(() => document.querySelector('.maplibregl-marker').getBoundingClientRect().toJSON());
  const before = await pinAt();
  const box = await bruno.locator('canvas.maplibregl-canvas').boundingBox();
  await bruno.mouse.click(box.x + 120, box.y + 90);
  await bruno.waitForTimeout(400);
  const after = await pinAt();
  check(Math.abs(after.x - before.x) > 30, 'um clique no mapa move o pin');
  await bruno.getByRole('button', { name: 'Colocar o pin no centro' }).click();
  await bruno.waitForTimeout(300);
  const centred = await pinAt();
  check(Math.abs(centred.x + centred.width / 2 - (box.x + box.width / 2)) < 3, '"Colocar o pin no centro": o caminho pelo teclado');
  const now = await bruno.locator('canvas.maplibregl-canvas').boundingBox();   // the button scrolled the page
  await bruno.mouse.click(now.x + now.width / 2 + 90, now.y + now.height / 2 - 60);
  await bruno.waitForTimeout(400);
  check(Math.abs((await pinAt()).x - centred.x) > 40, 'depois do botão, um clique no mapa ainda move o pin');
  await bruno.getByRole('button', { name: 'Colocar o pin no centro' }).click();
  await bruno.waitForTimeout(300);
  const again = await pinAt();
  // Dragging the pin, as a person does.
  await bruno.mouse.move(again.x + again.width / 2, again.y + again.height - 4);
  await bruno.mouse.down();
  await bruno.mouse.move(again.x + 100, again.y + 10, { steps: 10 });
  await bruno.mouse.up();
  await bruno.waitForTimeout(400);
  const dragged = await pinAt();
  check(Math.abs(dragged.x - again.x) > 40, 'arrastar move o pin');
  await bruno.getByLabel('Como encontrar o local').fill(NOTE);
  await bruno.getByRole('button', { name: 'Salvar alterações' }).click();
  await bruno.waitForURL(`**/eventos/${ev.id}`);
  const saved = await eventOf(bruno, ev.id);
  check(saved.postal_code === '57051160' && saved.latitude !== null && saved.location_note === NOTE, 'CEP, pin e descrição salvos');
  check(saved.longitude !== -35.73817 && Math.abs(saved.latitude + 9.655) < 0.01 && Math.abs(saved.longitude + 35.738) < 0.01,
        `o pin salvo é o arrastado, não o do CEP (${saved.latitude}, ${saved.longitude})`);

  await bruno.goto(`${WEB}/eventos/${ev.id}/editar`, { waitUntil: 'networkidle' });
  check(await bruno.getByRole('button', { name: 'Abrir o mapa' }).count() === 0, 'com pin salvo, a edição já abre com o mapa');
  await bruno.waitForFunction(() => document.querySelector('.maplibregl-marker'));
  check(await bruno.getByLabel('CEP do local').inputValue() === '57051-160', 'ao editar de novo, o CEP e o pin continuam lá');
  // Lost on the map: the button brings the pin back.
  await bruno.locator('canvas.maplibregl-canvas').evaluate((c) => c.scrollIntoView({ block: 'center' }));
  await bruno.waitForTimeout(300);
  const area = await bruno.locator('canvas.maplibregl-canvas').boundingBox();
  check(area.height / area.width > 0.8, `no formulário, o mapa é quase quadrado (${Math.round(area.width)} x ${Math.round(area.height)})`);
  for (let i = 0; i < 3; i++) {
    await bruno.mouse.move(area.x + area.width - 40, area.y + area.height - 60);
    await bruno.mouse.down();
    await bruno.mouse.move(area.x + 40, area.y + 60, { steps: 6 });
    await bruno.mouse.up();
    await bruno.waitForTimeout(500);
  }
  const inView = () => bruno.evaluate(() => {
    const m = document.querySelector('.maplibregl-marker').getBoundingClientRect();
    const c = document.querySelector('canvas.maplibregl-canvas').getBoundingClientRect();
    return m.x > c.x && m.right < c.right && m.y > c.y && m.bottom < c.bottom;
  });
  check(!(await inView()), 'arrastar o mapa pode deixar o pin fora da tela');
  await bruno.getByRole('button', { name: 'Voltar ao pin' }).click();
  await bruno.waitForTimeout(2500);
  check(await inView(), '"Voltar ao pin" traz o pin de volta');
  await bruno.getByRole('button', { name: 'Remover o pin' }).click();
  check(await bruno.getByRole('button', { name: 'Voltar para Maceió' }).count() === 1, 'sem pin, o botão volta para Maceió');
  await bruno.getByRole('button', { name: 'Cancelar' }).click();

  console.log('2. O visitante lê a descrição e abre o mapa com um clique');
  check((await bruno.request.post(`${API}/events/${ev.id}/images`, { multipart: { file: { name: 'f.jpg', mimeType: 'image/jpeg', buffer: readFileSync(COVER) } } })).ok(), 'foto enviada');
  for (let i = 0; i < 60 && !(await (await bruno.request.post(`${API}/events/${ev.id}/publish`)).ok()); i++) await bruno.waitForTimeout(500);
  for (let i = 0; i < 120 && (await eventOf(bruno, ev.id)).status !== 'published'; i++) await bruno.waitForTimeout(500);
  check((await eventOf(bruno, ev.id)).status === 'published', 'evento publicado');

  // Computer: the description in the band, the search on the left and the place on the right (02/11/2026).
  // Phone: the place never above the search, which starts from the first screen.
  const desktop = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await desktop.goto(`${WEB}/evento/${ev.id}`, { waitUntil: 'networkidle' });
  await desktop.getByText(NOTE).first().waitFor();
  const about = await desktop.getByText('Sobre o evento').first().boundingBox();
  const card = await desktop.getByText('Procure suas fotos').first().boundingBox();
  const placeBox = await desktop.getByText('Como encontrar o local').first().boundingBox();
  check(about.y < card.y, 'computador: a descrição fica na faixa, acima da busca');
  check(placeBox.x > card.x + card.width && placeBox.y >= card.y - 8, 'computador: o local fica à direita da busca');
  // Both cards end at the same line, and everything about the search sits in the left one.
  const heights = await desktop.evaluate(() => {
    const cardOf = (text) => {
      let e = [...document.querySelectorAll('*')].find((d) => d.children.length === 0 && d.textContent === text);
      while (e && !getComputedStyle(e).boxShadow.includes('rgba')) e = e.parentElement;
      return e;
    };
    const left = cardOf('Procure suas fotos'), right = cardOf('Como encontrar o local');
    return { left: left.getBoundingClientRect().height, right: right.getBoundingClientRect().height,
             notice: left.textContent.includes('destinam-se exclusivamente'), map: right.querySelector('canvas').getBoundingClientRect().height,
             gap: right.getBoundingClientRect().bottom - right.querySelector('canvas').getBoundingClientRect().bottom };
  });
  check(heights.gap <= 24, `computador: o mapa preenche o cartão, sem espaço vazio embaixo (sobram ${Math.round(heights.gap)} px)`);
  check(Math.abs(heights.left - heights.right) < 1, `computador: os dois cartões têm a mesma altura (${Math.round(heights.left)} e ${Math.round(heights.right)} px)`);
  check(heights.notice, 'computador: o aviso de uso responsável fica dentro do cartão da busca');
  check(await desktop.getByRole('button', { name: 'Buscar minhas fotos', exact: true }).count() === 1, 'computador: a busca tem um botão só');
  await desktop.context().close();
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 600 } })).newPage();
  await phone.goto(`${WEB}/evento/${ev.id}`, { waitUntil: 'networkidle' });
  await phone.getByText(NOTE).first().waitFor();
  const start = await phone.getByRole('button', { name: 'Buscar minhas fotos', exact: true }).first().boundingBox();
  const noteAt = await phone.getByText(NOTE).first().boundingBox();
  check(start.y + start.height <= 600, 'celular: a busca aparece sem rolar a página');
  check(noteAt.y > start.y, 'celular: o local não fica acima da busca');
  // 06/11/2026: the map came only at the end of the page, after the whole explanation of the search.
  const explanation = await phone.getByText('Procure suas fotos').first().boundingBox();
  check(noteAt.y < explanation.y, 'celular: o local vem logo depois das informações, antes da explicação da busca');
  await phone.getByRole('button', { name: 'Buscar minhas fotos', exact: true }).first().click();
  await phone.getByRole('button', { name: 'Estou ciente' }).first().waitFor();
  check(await phone.getByRole('button', { name: 'Estou ciente' }).first().isVisible(), 'celular: o botão pede a permissão antes da câmera');
  await phone.context().close();

  const visitor = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  const fromVisitor = watch(visitor);
  await visitor.goto(`${WEB}/evento/${ev.id}`, { waitUntil: 'networkidle' });
  await visitor.getByText(NOTE).first().waitFor();
  check(await visitor.getByLabel('CEP do local').count() === 0, 'o visitante não vê campos de edição');
  await visitor.waitForFunction(() => document.querySelector('.maplibregl-marker'), null, { timeout: 20000 });
  await visitor.waitForTimeout(2500);
  check(await visitor.getByRole('button', { name: 'Ver no mapa' }).count() === 0, 'com pin, o mapa abre sem clique');
  check(fromVisitor.length === 0, `com o mapa aberto, nada sai do FOTOMAC (LGPD): ${fromVisitor[0] ?? 'nenhum pedido'}`);
  await visitor.screenshot({ path: join(SHOTS, '02-visitante.png'), fullPage: true });
  const marker = await visitor.evaluate(() => document.querySelector('.maplibregl-marker').getBoundingClientRect().toJSON());
  await visitor.mouse.move(marker.x + 13, marker.y + 30);
  await visitor.mouse.down();
  await visitor.mouse.move(marker.x + 150, marker.y + 90, { steps: 8 });
  await visitor.mouse.up();
  await visitor.waitForTimeout(600);
  const shown = await visitor.evaluate(() => {
    const m = document.querySelector('.maplibregl-marker').getBoundingClientRect();
    const c = document.querySelector('canvas.maplibregl-canvas').getBoundingClientRect();
    return { draggable: document.querySelector('.maplibregl-marker').classList.contains('maplibregl-marker-draggable'), inside: m.x >= c.x };
  });
  check(!shown.draggable, 'para o visitante, o pin não se arrasta');
  check(await visitor.evaluate(() => /OpenStreetMap/.test(document.querySelector('.maplibregl-ctrl-attrib-inner').textContent)), 'os créditos do mapa aparecem');

  // An event with no pin (the map outside Brazil too): the written location takes its place.
  const noPin = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await noPin.route(`${API}/public/events/${ev.id}`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), latitude: null, longitude: null, location_note: null } });
  });
  await noPin.goto(`${WEB}/evento/${ev.id}`, { waitUntil: 'networkidle' });
  await noPin.getByText('Como encontrar o local').first().waitFor();
  check(await noPin.locator('.maplibregl-canvas').count() === 0, 'sem pin, não há mapa');
  check(await noPin.getByText('Ginásio do Campus I').count() >= 2, 'sem pin, aparece o local escrito');
  await noPin.context().close();

  // 02/11/2026: the panel page fits one screen. Photo and progress on the left, the details on the right.
  await bruno.setViewportSize({ width: 1366, height: 768 });
  await bruno.goto(`${WEB}/eventos/${ev.id}`, { waitUntil: 'networkidle' });
  await bruno.locator('.maplibregl-marker').first().waitFor({ timeout: 20000 });
  const details = bruno.getByRole('heading', { name: 'Detalhes do Evento' });
  const progress = bruno.getByText('Andamento do evento');
  const cover = bruno.locator(`img[src*="/events/${ev.id}/cover"]`).first();
  const [c, p, d] = [await cover.boundingBox(), await progress.boundingBox(), await details.boundingBox()];
  check(c.width >= 480, `foto maior no painel (${Math.round(c.width)} x ${Math.round(c.height)})`);
  check(p.y > c.y + c.height && p.x < c.x + c.width, 'o andamento fica embaixo da foto');
  check(d.x > c.x + c.width && d.y < c.y + c.height, '"Detalhes do Evento" fica à direita da foto');
  const panelSizes = await bruno.evaluate(() => {
    const canvas = document.querySelector('canvas.maplibregl-canvas').getBoundingClientRect();
    const box = document.querySelectorAll('*');
    const bottom = (text) => { for (const el of box) if (el.children.length === 0 && el.textContent === text) return el.getBoundingClientRect().bottom; return 0; };
    return { map: canvas.bottom, stage4: bottom('No site'), expires: bottom('Expiração do acervo'), page: document.documentElement.scrollHeight };
  });
  console.log(`  medidas ${JSON.stringify(panelSizes)}`);
  const cardBottom = (el) => { for (let n = el; n; n = n.parentElement) if (getComputedStyle(n).borderTopLeftRadius !== '0px' && getComputedStyle(n).borderTopWidth !== '0px') return n.getBoundingClientRect().bottom; return 0; };
  const [progressEnd, detailsEnd] = [await progress.evaluate(cardBottom), await details.evaluate(cardBottom)];
  check(Math.abs(progressEnd - detailsEnd) <= 1, `andamento e detalhes terminam na mesma linha (${Math.round(progressEnd)} e ${Math.round(detailsEnd)})`);
  // The whole site is scaled on a computer: a menu must still open right under its field.
  await bruno.goto(`${WEB}/eventos`, { waitUntil: 'networkidle' });
  const field = bruno.getByRole('button', { name: 'Status' }).first();
  await field.scrollIntoViewIfNeeded();
  const fieldBox = await field.boundingBox();
  await field.click();
  const menuBox = await bruno.getByRole('menu').first().boundingBox();
  check(Math.abs(menuBox.x - fieldBox.x) <= 2 && Math.abs(menuBox.width - fieldBox.width) <= 2, 'com o site em escala, o menu abre alinhado ao campo');
  check(menuBox.y >= fieldBox.y + fieldBox.height - 2 && menuBox.y <= fieldBox.y + fieldBox.height + 16, 'e logo abaixo dele');
  await bruno.keyboard.press('Escape');
  await bruno.goto(`${WEB}/eventos/${ev.id}`, { waitUntil: 'networkidle' });
  await bruno.setViewportSize({ width: 1440, height: 960 });
  await bruno.waitForTimeout(800);
  await bruno.screenshot({ path: join(SHOTS, 'panel-1440.png') });

  console.log('3. Quem não criou o evento lê, mas não altera');
  const rafael = await person(browser, 'Rafael Colega', 'photographer');
  await rafael.goto(`${WEB}/eventos/${ev.id}`, { waitUntil: 'networkidle' });
  await rafael.getByText(NOTE).first().waitFor();
  await rafael.locator('.maplibregl-marker').first().waitFor({ timeout: 20000 });
  check(await rafael.locator('.maplibregl-marker-draggable').count() === 0, 'no painel, outro fotógrafo vê o mapa aberto, sem poder mover o pin');
  check(await rafael.getByRole('button', { name: 'Editar evento' }).count() === 0, 'e não tem como editar');
  const admin = await person(browser, 'Ana Administradora', 'admin');
  await admin.goto(`${WEB}/eventos/${ev.id}/editar`, { waitUntil: 'networkidle' });
  await admin.getByText('Só quem criou o evento altera o mapa').waitFor();
  check(await admin.getByLabel('CEP do local').count() === 0, 'com o criador ativo, nem o administrador altera o mapa');

  console.log('\nTUDO CERTO: CEP, pin, descrição, visitante e permissões do mapa.');
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
