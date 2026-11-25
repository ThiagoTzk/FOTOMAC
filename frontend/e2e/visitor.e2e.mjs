// End-to-end test of the VISITOR area in a real browser, against the real
// API, YuNet + SFace and SeaweedFS. The photographer part is set up through the API.
//
//   node e2e/visitor.e2e.mjs <photos-folder> [screenshot-folder]
//
// photos-folder: grupo.jpg, grupo2.jpg, paisagem.jpg and capa.jpg.
//
// The search is made ONLY by the guided capture with liveness check — there is no
// gallery upload any more. Chromium's fake camera shows a test pattern (no face, no movement), so a
// browser can prove the whole path (notice → tips → order drawn by the server → frames → refusal →
// camera off) but NOT a search that finds photos: that needs a real head turning. The results, the
// viewer, the download and the removal are covered by backend/tests/test_public.py (real SFace with
// simulated poses) and by the manual test with a real face.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const WEB = 'http://localhost:8081';
const API = 'http://localhost:8000/api/v1';
const BACKEND = fileURLToPath(new URL('../../backend/', import.meta.url));
const OUTBOX = join(BACKEND, 'outbox');
const [PHOTOS, SHOTS = 'e2e-screenshots/visitante'] = process.argv.slice(2);
if (!PHOTOS) throw new Error('uso: node e2e/visitor.e2e.mjs <pasta-fotos> [pasta-capturas]');
mkdirSync(SHOTS, { recursive: true });
const photo = (f) => join(PHOTOS, f);

const stamp = Date.now();
const email = `e2e.visitante.${stamp}@cesmac.edu.br`;
const EVENT = `FeCiAL Edição E2E ${stamp}`;
const PASSWORD = 'Fotomac#2026';
const check = (ok, msg) => { if (!ok) throw new Error(`FALHOU: ${msg}`); console.log(`  ok  ${msg}`); };

function newestMail(pattern) {
  const files = readdirSync(OUTBOX).filter((f) => f.endsWith('.eml')).map((f) => join(OUTBOX, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const f of files) { const m = readFileSync(f, 'utf8'); if (pattern.test(m)) return m; }
  return null;
}

// Fake camera: Chromium's own test pattern stands in for the webcam (no face in it).
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const problems = [];
let step = 0;

try {
  console.log('1. Fotógrafo publica um evento com 3 fotos (via API)');
  const staff = await browser.newContext();
  const sp = await staff.newPage();
  execFileSync(join(BACKEND, '.venv/bin/python'), ['scripts/create_account.py', '--name', 'Bruno Rocha Teste',
    '--email', email, '--role', 'photographer', '--signature', 'Bruno Rocha'], { cwd: BACKEND });
  const activation = newestMail(new RegExp(email.replace(/\./g, '\\.'))).match(/http:\/\/localhost:8081\/primeiro-acesso\?token=[\w-]+/)[0];
  const token = new URL(activation).searchParams.get('token');
  check((await sp.request.post(`${API}/auth/first-access`, { data: { token, password: PASSWORD, password_confirmation: PASSWORD } })).ok(), 'conta ativada');
  check((await sp.request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } })).ok(), 'login do fotógrafo');
  const themes = await (await sp.request.get(`${API}/themes`)).json();
  const created = await sp.request.post(`${API}/events`, { multipart: {
    name: EVENT, theme_ids: String(themes[0].id), date_precision: 'day', date_start: '2026-09-18', location: 'Centro Cultural',
    description: 'A FeCiAL — Feira de Ciências de Alagoas reúne estudantes e educadores para apresentar projetos e incentivar a ciência.',
    cover: { name: 'capa.jpg', mimeType: 'image/jpeg', buffer: readFileSync(photo('capa.jpg')) } } });
  check(created.status() === 201, 'evento criado');
  const eventId = (await created.json()).id;
  const ids = {};
  for (const f of ['grupo.jpg', 'grupo2.jpg', 'paisagem.jpg']) {
    const r = await sp.request.post(`${API}/events/${eventId}/images`, { multipart: {
      file: { name: f, mimeType: 'image/jpeg', buffer: readFileSync(photo(f)) } } });
    check(r.status() === 201, `foto ${f} enviada`);
    ids[f] = (await r.json()).id;
  }
  check((await sp.request.post(`${API}/events/${eventId}/publish`)).ok(), 'publicação solicitada');
  for (let i = 0; i < 90; i++) {
    if ((await (await sp.request.get(`${API}/events/${eventId}`)).json()).status === 'published') break;
    await sp.waitForTimeout(1000);
  }
  check((await (await sp.request.get(`${API}/events/${eventId}`)).json()).status === 'published', 'YuNet + SFace indexou e o evento foi publicado');
  await staff.close();

  // ---------------------------------------------------------------- visitor: no account, phone width
  const visitor = await browser.newContext({ viewport: { width: 402, height: 900 }, acceptDownloads: true, permissions: ['camera'] });
  const page = await visitor.newPage();
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 4[0-9][0-9]|non-boolean attribute|accessible|shadow\*/.test(m.text())) problems.push(m.text().slice(0, 200));
  });
  const shot = async (name, full = true) => {
    step += 1;
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(SHOTS, `${String(step).padStart(2, '0')}-${name}.png`), fullPage: full });
  };
  const visible = (loc) => loc.filter({ visible: true });
  const button = (name) => visible(page.getByRole('button', { name, exact: true })).first();
  const text = (t) => visible(page.getByText(t)).first();

  console.log('2. Início público e pesquisa de eventos');
  await page.goto(WEB);
  await text('Encontre suas fotos nos eventos do CESMAC').waitFor();
  await text(EVENT).waitFor();
  await shot('inicio');
  await page.getByLabel('Buscar evento pelo nome').fill('fecial edicao');   // no accents
  await text('Resultado da busca').waitFor();
  await text(EVENT).waitFor();
  check(true, 'pesquisa sem acento encontra o evento');
  await page.getByLabel('Buscar evento pelo nome').fill(`fecil ${stamp}`);  // typo
  await text(EVENT).waitFor();
  check(true, 'pesquisa com erro de digitação encontra o evento');
  await button('Tema').click();
  await visible(page.getByRole('checkbox', { name: themes[0].name })).click();
  await text('Tema (1)').waitFor();
  await text(EVENT).waitFor();
  check(true, 'filtro por tema');
  await shot('inicio-busca', false);
  await page.mouse.click(200, 860);           // a click anywhere outside closes the popover
  check(!(await visible(page.getByRole('checkbox')).count()), 'clicar fora fecha o filtro');

  console.log('3. Galeria privada: nada sem busca');
  for (const v of ['thumb', 'preview', 'download']) {
    const r = await page.request.get(`${API}/public/images/${ids['grupo.jpg']}/${v}`, { maxRedirects: 0 });
    check(r.status() === 404, `/${v} de uma foto do evento sem busca → 404`);
  }
  await text(EVENT).click();
  await text('Procure suas fotos').waitFor();
  await text('3 fotos').waitFor();
  check(await text('Bruno Rocha · CESMAC').isVisible(), 'crédito do evento');
  check(await page.locator('img[src*="/public/images/"]').count() === 0, 'nenhuma foto do evento na página antes da busca');
  check(await text(/destinam-se exclusivamente às pessoas nelas retratadas/).isVisible(), 'aviso de uso responsável');
  check(await text('O reconhecimento facial pode errar').first().isVisible(), 'aviso de que o reconhecimento pode errar, junto à busca');
  check(await text(/responsabilização civil, inclusive indenização/).first().isVisible(), 'aviso das consequências do uso indevido da imagem');
  await shot('evento');

  console.log('4. Permissão antes da câmera');
  await button('Buscar minhas fotos').click();
  await text('Permissão para uso de imagem').waitFor();
  check(await page.getByRole('checkbox').count() === 0, 'nenhuma caixa pré-marcada: só a ação "Estou ciente"');
  await text(/o vídeo não é gravado/).waitFor();
  check(true, 'o aviso explica a captura guiada');
  check(!(await text(/menores de 18 anos/).isVisible().catch(() => false)), 'sem parágrafo sobre menores (retirado em 19/10)');
  await shot('permissao', false);
  await button('Agora não').click();
  check(!(await text('Busca pelo seu rosto').isVisible().catch(() => false)), 'sem "Estou ciente", a câmera não abre');
  check(!(await text('Realizar upload').isVisible().catch(() => false)), 'não existe mais envio de foto pela galeria');
  const blocked = await page.request.post(`${API}/public/events/${eventId}/search`, { multipart: {
    frames: { name: 'q.jpg', mimeType: 'image/jpeg', buffer: readFileSync(photo('grupo.jpg')) }, steps: 'frente' } });
  check(blocked.status() === 403, 'o servidor recusa a busca sem ciência (403)');

  console.log('5. Captura guiada: ordem sorteada pelo servidor, quadros, prova de vida');
  await button('Buscar minhas fotos').click();
  await button('Estou ciente').click();
  await text('Busca pelo seu rosto').waitFor();
  await text('Dicas para encontrar suas fotos').waitFor();
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
  await shot('captura-dicas', false);
  // What the voice says, in order (05/11/2026: "Olhe para a câmera" was said twice at the start).
  await page.evaluate(() => {
    window.__said = [];
    if (typeof speechSynthesis === 'undefined') return;
    const speak = speechSynthesis.speak.bind(speechSynthesis);
    speechSynthesis.speak = (u) => { window.__said.push(u.text); speak(u); };
  });
  const drawn = page.waitForResponse((r) => r.url().endsWith('/capture'));
  await button('Começar').click();
  const order = (await (await drawn).json()).order;
  check(order.length === 4 && [...order].sort().join() === 'baixo,cima,direita,esquerda', `ordem sorteada pelo servidor: ${order.join(', ')}`);
  // 04/11/2026 (the coordinator's test): a big written instruction, read aloud, how long to hold, and each movement
  // checked at once. The fake camera has no face: the check says so, the movement is asked again, and after the last
  // try the capture stops and explains, without a search that could not work.
  const searched = [];
  page.on('request', (r) => { if (r.url().endsWith('/search')) searched.push(r.url()); });
  await text('Segure por 3 segundos').waitFor({ timeout: 15000 });
  check(await visible(page.getByRole('switch', { name: 'Instruções faladas' })).isVisible(), 'botão para ligar e desligar a voz');
  const firstCheck = await page.waitForResponse((r) => r.url().endsWith('/capture/check'), { timeout: 30000 });
  const verdict = await firstCheck.json();
  check(verdict.ok === false && verdict.reason === 'no_face', `cada movimento conferido na hora (${verdict.reason})`);
  // 11/11/2026 (a finger over the camera passed "Olhe para a câmera"): the FIRST step is checked too, so the fake
  // camera without a face stops right there.
  await text('Olhe para a câmera de novo').waitFor({ timeout: 10000 });
  check(true, 'sem rosto, a tela pede para olhar para a câmera de novo (não diz "deu certo")');
  const said = await page.evaluate(() => window.__said);
  check(said[0] === 'Vamos começar.' && said.filter((t) => t.startsWith('Olhe para a câmera')).length === 1,
        `a voz diz "Vamos começar." e "Olhe para a câmera" uma vez só (${said.slice(0, 2).join(' | ')})`);
  const chips = await visible(page.locator('[aria-label="Gravação guiada do rosto"], [aria-label="Busca pelo seu rosto"]')).innerText();
  check(chips.indexOf(order[0]) < chips.indexOf(order[3]), 'a tela segue a ordem do servidor');
  await shot('captura-de-novo', false);
  // Without a face at the front step the capture stops after its tries, before any movement.
  await visible(page.getByRole('alert')).first().waitFor({ timeout: 150000 });
  const alertText = await visible(page.getByRole('alert')).first().innerText();
  check(/Não encontramos o seu rosto/.test(alertText), 'depois das tentativas, a captura para e explica');
  check(searched.length === 0, 'nenhuma busca enviada com uma captura que não pode dar certo');
  await shot('captura-recusada', false);
  // What matters for privacy: the camera itself is OFF (every track ended), not just hidden.
  check(await page.evaluate(() => [...document.querySelectorAll('video')]
    .every((v) => !v.srcObject || v.srcObject.getTracks().every((t) => t.readyState === 'ended'))), 'câmera desligada após a captura');
  const replay = () => page.request.post(`${API}/public/events/${eventId}/search`, { multipart: {
    frames: { name: 'q.jpg', mimeType: 'image/jpeg', buffer: readFileSync(photo('grupo.jpg')) }, steps: 'frente' } });
  await replay();   // uses the drawn order up (and is refused: one frame is not a capture)
  check((await (await replay()).json()).detail?.reason === 'challenge', 'a ordem sorteada vale uma vez só');
  await button('Tentar de novo').click();
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some((v) => v.srcObject?.active && v.readyState >= 2));
  await button('Começar').waitFor();
  check(true, '"Tentar de novo" reabre a câmera só com o clique');
  await button('Fechar').click();
  check(await page.evaluate(() => [...document.querySelectorAll('video')]
    .every((v) => !v.srcObject || v.srcObject.getTracks().every((t) => t.readyState === 'ended'))), 'fechar desliga a câmera');

  console.log('6. Sair do evento e voltar: a permissão é pedida de novo (caso relatado em teste)');
  await visible(page.getByRole('link', { name: 'Voltar' })).click();
  await text('Encontre suas fotos nos eventos do CESMAC').waitFor();
  await text(EVENT).click();
  await text('Procure suas fotos').waitFor();
  await page.waitForTimeout(800);
  check(await page.locator('img[src*="/public/images/"]').count() === 0, 'nenhuma imagem de resultado na página');
  await button('Buscar minhas fotos').click();
  await text('Permissão para uso de imagem').waitFor();
  check(true, 'a permissão é pedida de novo');
  await button('Agora não').click();
  const stranger = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const sp2 = await stranger.newPage();

  console.log('10. Política de Privacidade e acesso da equipe');
  await sp2.goto(`${WEB}/privacidade`);
  await sp2.getByText('Por quanto tempo').waitFor();
  // The period comes from the server a moment after the page: wait for it instead of reading too early.
  await sp2.getByText(/ficam disponíveis por (\d+ meses|1 mês)/).waitFor();
  check(true, 'prazo de retenção vindo do servidor');
  await sp2.screenshot({ path: join(SHOTS, `${String(++step).padStart(2, '0')}-privacidade.png`), fullPage: true });
  await sp2.goto(`${WEB}/painel`);
  await sp2.getByText('Acesse sua conta').waitFor();
  check(true, 'sem sessão, /painel vai para o login da equipe');
  await sp2.goto(WEB);
  await sp2.getByText('Participou de um evento do CESMAC? Encontre suas fotos.').waitFor();   // web layout (≥1024 px)
  await sp2.screenshot({ path: join(SHOTS, `${String(++step).padStart(2, '0')}-inicio-desktop.png`), fullPage: true });

  check(problems.length === 0, `sem erros no console${problems.length ? `: ${problems.join(' | ')}` : ''}`);
  console.log('\nTUDO OK');
} finally {
  await browser.close();
}
