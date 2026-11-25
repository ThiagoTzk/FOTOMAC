// 04/11/2026: a visitor found in a video (RF035). The video is analysed for real by the API (YuNet + SFace, one frame
// per second). The browser's fake camera cannot turn a head, so only the ANSWER of the capture is simulated: the
// per-movement check says "ok" and the search answers with the video the session was given in the database. The
// thumbnail, the player, the download with the mark and the removal then go through the real API, which checks this
// session's result at every request. The search itself is covered by backend/tests/test_video_recognition.py.
//
//   node e2e/video-search.e2e.mjs <fotos> [pasta-capturas]
//
// fotos: grupo.jpg (faces), paisagem.jpg and capa.jpg.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const [PHOTOS, SHOTS = 'e2e-screenshots/video-search'] = process.argv.slice(2);
if (!PHOTOS) throw new Error('uso: node e2e/video-search.e2e.mjs <fotos> [pasta-capturas]');
mkdirSync(SHOTS, { recursive: true });
const API = 'http://localhost:8000/api/v1';
const WEB = 'http://localhost:8081';
const BACKEND = fileURLToPath(new URL('../../backend/', import.meta.url));
const OUTBOX = join(BACKEND, 'outbox');
const PASSWORD = 'Fotomac#2026';
const stamp = Date.now();
const check = (ok, msg) => { if (!ok) throw new Error(`FALHOU: ${msg}`); console.log(`  ok  ${msg}`); };
const photo = (name) => join(PHOTOS, name);
const python = (code) => execFileSync(join(BACKEND, '.venv/bin/python'), ['-c', code], { cwd: BACKEND }).toString().trim();

function token(email) {
  const files = readdirSync(OUTBOX).filter((f) => f.endsWith('.eml')).map((f) => join(OUTBOX, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const f of files) { const m = readFileSync(f, 'utf8'); if (m.includes(`To: ${email}`)) return m.match(/primeiro-acesso\?token=([\w-]+)/)[1]; }
  throw new Error(`sem link para ${email}`);
}

// 4 seconds of the group photo: the faces on every frame.
const crew = resolve(SHOTS, 'grupo.mp4');
execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-loop', '1', '-i', photo('grupo.jpg'), '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
  '-t', '4', '-r', '10', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', crew]);

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const problems = [];
try {
  console.log('1. Evento com um vídeo publicado e analisado');
  const email = `e2e.videobusca.${stamp}@cesmac.edu.br`;
  execFileSync(join(BACKEND, '.venv/bin/python'), ['scripts/create_account.py', '--name', 'Vitor Video', '--email', email,
    '--role', 'photographer', '--signature', 'Vitor Video'], { cwd: BACKEND });
  const owner = await (await browser.newContext()).newPage();
  check((await owner.request.post(`${API}/auth/first-access`, { data: { token: token(email), password: PASSWORD, password_confirmation: PASSWORD } })).ok(), 'fotógrafo ativado');
  const theme = (await (await owner.request.get(`${API}/themes`)).json())[0];
  const ev = await (await owner.request.post(`${API}/events`, { multipart: {
    name: `Busca em video E2E ${stamp}`, theme_ids: String(theme.id), date_precision: 'day', date_start: '2026-10-21',
    location: 'Auditório', description: 'Evento do teste automatizado.', cover: { name: 'capa.jpg', mimeType: 'image/jpeg', buffer: readFileSync(photo('capa.jpg')) } } })).json();
  const still = await (await owner.request.post(`${API}/events/${ev.id}/images`, { multipart: { file: { name: 'paisagem.jpg', mimeType: 'image/jpeg', buffer: readFileSync(photo('paisagem.jpg')) } } })).json();
  const sent = await owner.request.post(`${API}/events/${ev.id}/videos`, { multipart: { file: { name: 'grupo.mp4', mimeType: 'video/mp4', buffer: readFileSync(crew) } } });
  check(sent.ok(), 'vídeo enviado');
  const video = await sent.json();
  for (let n = 0; n < 90 && (await (await owner.request.get(`${API}/videos/${video.id}`)).json()).processing_status !== 'ready'; n++) await owner.waitForTimeout(1000);
  check((await owner.request.post(`${API}/events/${ev.id}/publish`, { data: {} })).ok(), 'foto publicada');
  check((await owner.request.post(`${API}/events/${ev.id}/videos/publish`, { data: {} })).ok(), 'vídeo publicado');
  let analysed;
  for (let n = 0; n < 120; n++) {
    analysed = await (await owner.request.get(`${API}/videos/${video.id}`)).json();
    if (['processed', 'no_faces', 'failed'].includes(analysed.indexing_status)) break;
    await owner.waitForTimeout(1000);
  }
  check(analysed.indexing_status === 'processed' && analysed.face_seconds === 4, `o vídeo publicado foi analisado (rostos em ${analysed.face_seconds} segundos)`);
  // grupo.jpg shows 6 people (the children suite finds the same 6 faces): 6 people, not 6 faces x 4 seconds.
  check(analysed.face_people === 6, `conta as pessoas, não os rostos de cada segundo (${analysed.face_people} pessoas)`);
  await owner.goto(`${WEB}/eventos/${ev.id}/videos`, { waitUntil: 'networkidle' });
  await owner.getByText(/6 pessoas encontradas, com o rosto visível em 4 de 4 segundos/).waitFor();
  check(true, 'a aba Vídeos diz quantas pessoas e em quantos segundos');
  // 05/11/2026: below the player of the panel, one face per person; a click takes the video to that moment.
  await owner.getByRole('button', { name: /Assistir ao vídeo de/ }).first().click();
  const people = owner.getByRole('region', { name: 'Pessoas neste vídeo' });
  await people.getByText('6 pessoas').waitFor({ timeout: 30000 });
  check(await people.getByRole('button', { name: /Pessoa \d+: ir para/ }).count() === 6, 'embaixo do player, uma foto de cada pessoa do vídeo');
  await owner.screenshot({ path: join(SHOTS, '00-pessoas.png') });
  await owner.waitForFunction(() => document.querySelector('video')?.readyState >= 1);
  await people.getByRole('button', { name: /Pessoa 1: ir para/ }).click();
  await owner.waitForTimeout(800);
  check(await owner.evaluate(() => document.querySelector('video').currentTime >= 0), 'clicar na pessoa leva o vídeo ao momento dela');
  await owner.getByRole('button', { name: 'Fechar', exact: true }).last().click();
  for (let n = 0; n < 60 && (await owner.request.get(`${API}/public/events/${ev.id}`)).status() !== 200; n++) await owner.waitForTimeout(1000);

  console.log('2. A busca do visitante encontra o vídeo');
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })).newPage();
  page.on('pageerror', (e) => problems.push(e.message));
  const visible = (loc) => loc.filter({ visible: true });
  const button = (name) => visible(page.getByRole('button', { name, exact: true })).first();
  await page.goto(`${WEB}/evento/${ev.id}`, { waitUntil: 'networkidle' });
  await button('Buscar minhas fotos').click();
  await button('Estou ciente').click();
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
  // This visitor's session gets the video as its result, as the search would; the routes check THIS list.
  python(`
from sqlalchemy import text
from app.db.session import get_engine
with get_engine().begin() as c:
    c.execute(text("UPDATE visitor_sessions SET result_video_ids = ARRAY[CAST(:v AS uuid)], result_ids = ARRAY[CAST(:p AS uuid)] WHERE event_id = :e"), {"v": "${video.id}", "p": "${still.id}", "e": "${ev.id}"})`);
  // 05/11/2026: up never finds the face here (as a head thrown back), the rest works: up and down are a bonus, so the
  // capture goes on after their tries and the search still happens.
  // The checks follow the order drawn by the server, like the screen (a request with files has no readable body here).
  const asked = [];
  let order = [], at = 0, tries = 0;
  page.on('response', async (r) => { if (r.url().endsWith('/capture')) order = (await r.json()).order; });
  await page.route('**/capture/check', (r) => {
    const step = order[at];
    asked.push(step);
    if (step === 'cima') {
      if (++tries === 3) { at += 1; tries = 0; }
      return r.fulfill({ json: { ok: false, reason: 'no_face' } });
    }
    at += 1;
    return r.fulfill({ json: { ok: true, reason: null } });
  });
  await page.route('**/search', (r) => r.fulfill({ json: { items: [{ id: still.id, captured_at: null, credit: 'Foto por: Vitor Video · Centro Universitário CESMAC' }], videos: [{ id: video.id, duration_seconds: analysed.duration_seconds, captured_at: null, credit: 'Vídeo por: Vitor Video · Centro Universitário CESMAC' }] } }));
  // Messages that show for a moment: noted as they appear.
  await page.evaluate(() => {
    window.__seen = new Set();
    new MutationObserver(() => {
      for (const t of ['Deu certo!', 'Mexa a cabeça um pouco menos']) if (document.body.innerText.includes(t)) window.__seen.add(t);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await button('Começar').click();
  await visible(page.getByText('1 foto encontrada e 1 vídeo encontrado')).waitFor({ timeout: 150000 });
  const seen = await page.evaluate(() => [...window.__seen]);
  check(seen.includes('Deu certo!'), 'cada movimento que deu certo é confirmado na tela');
  check(seen.includes('Mexa a cabeça um pouco menos'), 'para cima sem rosto: a tela pede para mexer a cabeça um pouco menos');
  check(asked.filter((st) => st === 'cima').length === 3 && asked.includes('baixo'),
        `depois de 3 tentativas para cima, a captura segue e a busca acontece (${asked.join(', ')})`);
  // 05/11/2026: photos and videos in two tabs, photos first; 50 videos no longer push the photos down.
  const tabs = visible(page.getByRole('tab'));
  check(await tabs.count() === 2 && (await tabs.first().getAttribute('aria-selected')) === 'true' && /Fotos · 1/.test(await tabs.first().innerText()),
        'fotos e vídeos em duas abas, abrindo nas fotos');
  check(await visible(page.getByRole('button', { name: /Abrir foto 1 de 1/ })).isVisible(), 'a aba Fotos mostra a foto');
  await visible(page.getByRole('tab', { name: /Vídeos · 1/ })).click();
  check(await visible(page.getByRole('button', { name: /Assistir ao vídeo 1 de 1/ })).isVisible(), 'a aba Vídeos mostra o vídeo');
  await page.screenshot({ path: join(SHOTS, '01-resultado.png'), fullPage: true });

  console.log('3. Assistir, baixar inteiro com a marca e pedir a remoção');
  const parts = [];
  page.on('response', (r) => { if (r.url().includes(`/public/videos/${video.id}/play`)) parts.push(r.status()); });
  await visible(page.getByRole('button', { name: /Assistir ao vídeo 1 de 1/ })).click();
  await visible(page.getByText(/O vídeo pode mostrar outras pessoas/)).waitFor();
  await page.waitForTimeout(2500);
  check(parts.length > 0 && parts.every((s) => s === 206 || s === 200), `o player pede o vídeo em partes (${parts.join(', ')})`);
  await page.screenshot({ path: join(SHOTS, '02-player.png') });
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), button('Baixar vídeo').click()]);
  const saved = resolve(SHOTS, 'baixado.mp4');
  await download.saveAs(saved);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:format_tags', '-of', 'json', saved]).toString());
  check(Number(probe.format.duration) > 3.5, `o vídeo inteiro foi baixado (${Number(probe.format.duration).toFixed(1)} s)`);
  check(JSON.stringify(probe.format.tags ?? {}).includes('CESMAC'), 'com o aviso de propriedade do CESMAC no arquivo');
  await page.getByRole('button', { name: 'Solicitar remoção deste vídeo' }).click();
  await visible(page.getByText(/este vídeo será retirado imediatamente/)).waitFor();
  await visible(page.getByLabel('E-mail para contato')).fill('pessoa@exemplo.com');
  await button('Enviar').click();
  await visible(page.getByText(/O vídeo foi retirado dos resultados de busca/)).waitFor();
  await button('Entendi').click();
  check(await visible(page.getByText(/vídeo encontrado/)).count() === 0 && await visible(page.getByText('1 foto encontrada')).isVisible(),
        'o vídeo sai do resultado na hora, a foto fica');
  check((await page.request.get(`${API}/public/videos/${video.id}/play`)).status() === 404, 'e não toca mais');
  check(!!(await (await owner.request.get(`${API}/videos/${video.id}`)).json()).removal_deadline, 'o painel mostra o prazo da exclusão');

  check(problems.length === 0, `sem erros na página${problems.length ? `: ${problems.join(' | ')}` : ''}`);
  console.log('\nTUDO OK');
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
