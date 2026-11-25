// 02/11/2026: videos in the collection (RF034). A phone video with location goes in; the file that comes out has no
// location; the browser gets it in parts; only the teams reach it, never a visitor. The files are made here by FFmpeg.
//
//   node e2e/videos.e2e.mjs <capa.jpg> [pasta-capturas]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const [COVER, SHOTS = 'e2e-screenshots/videos'] = process.argv.slice(2);
if (!COVER) throw new Error('uso: node e2e/videos.e2e.mjs <capa.jpg> [pasta-capturas]');
mkdirSync(SHOTS, { recursive: true });
const API = 'http://localhost:8000/api/v1';
const WEB = 'http://localhost:8081';
const BACKEND = fileURLToPath(new URL('../../backend/', import.meta.url));
const OUTBOX = join(BACKEND, 'outbox');
const PASSWORD = 'Fotomac#2026';
const stamp = Date.now();
const check = (ok, msg) => { if (!ok) throw new Error(`FALHOU: ${msg}`); console.log(`  ok  ${msg}`); };

const GPS = '+48.8584+002.2945/';
const base = ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=640x360:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-shortest', '-pix_fmt', 'yuv420p'];
const iphone = resolve(SHOTS, 'iphone.mov'), plain = resolve(SHOTS, 'pronto.mp4'), fake = resolve(SHOTS, 'falso.mp4'), camera = resolve(SHOTS, 'camera.mts');
execFileSync('ffmpeg', [...base, '-c:v', 'libx265', '-tag:v', 'hvc1', '-c:a', 'aac', '-metadata', `location=${GPS}`, '-metadata', `com.apple.quicktime.location.ISO6709=${GPS}`, '-movflags', 'use_metadata_tags', iphone]);
execFileSync('ffmpeg', [...base, '-c:v', 'libx264', '-c:a', 'aac', plain]);
execFileSync('ffmpeg', [...base, '-c:v', 'libx264', '-c:a', 'ac3', '-f', 'mpegts', camera]);
const another = resolve(SHOTS, 'outro.mp4');
execFileSync('ffmpeg', [...base, '-vf', 'negate', '-c:v', 'libx264', '-c:a', 'aac', another]);
writeFileSync(fake, Buffer.alloc(4000, 7));
const hasLocation = (bytes) => bytes.includes('ISO6709') || bytes.includes(Buffer.from([0xa9, 0x78, 0x79, 0x7a]));
check(hasLocation(readFileSync(iphone)), 'o vídeo de teste tem localização gravada');

function token(email) {
  const files = readdirSync(OUTBOX).filter((f) => f.endsWith('.eml')).map((f) => join(OUTBOX, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const f of files) { const m = readFileSync(f, 'utf8'); if (m.includes(`To: ${email}`)) return m.match(/primeiro-acesso\?token=([\w-]+)/)[1]; }
  throw new Error(`sem link para ${email}`);
}

async function person(browser, name, role) {
  const email = `e2e.video.${role}.${stamp}@cesmac.edu.br`;
  execFileSync(join(BACKEND, '.venv/bin/python'), ['scripts/create_account.py', '--name', name, '--email', email, '--role', role, '--signature', name], { cwd: BACKEND });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })).newPage();
  const ok = await page.request.post(`${API}/auth/first-access`, { data: { token: token(email), password: PASSWORD, password_confirmation: PASSWORD } });
  check(ok.ok(), `${name} ativado`);
  return page;
}

const browser = await chromium.launch();
try {
  console.log('1. Enviar');
  const owner = await person(browser, 'Vera Video', 'photographer');
  const theme = (await (await owner.request.get(`${API}/themes`)).json())[0];
  const ev = await (await owner.request.post(`${API}/events`, { multipart: {
    name: `Video E2E ${stamp}`, theme_ids: String(theme.id), date_precision: 'day', date_start: '2030-12-20',
    location: 'Ginásio do Campus I', description: 'Evento do teste automatizado.', cover: { name: 'capa.jpg', mimeType: 'image/jpeg', buffer: readFileSync(COVER) } } })).json();
  await owner.goto(`${WEB}/eventos/${ev.id}`, { waitUntil: 'networkidle' });
  await owner.getByRole('tab', { name: 'Vídeos' }).or(owner.getByText('Vídeos', { exact: true })).first().click();
  await owner.getByText('Os vídeos publicados entram na busca facial').waitFor();
  check(owner.url().endsWith(`/eventos/${ev.id}/videos`), 'a aba Vídeos abre a página do evento');
  check(await owner.getByText(/MP4, MOV, MKV.*até 1 GB e 10 minutos/).isVisible(), 'a tela mostra os formatos e os limites');
  const input = owner.locator('input[type=file]').first();
  await input.setInputFiles(fake);
  await owner.getByText(/Este arquivo não é um vídeo aceito/).waitFor({ timeout: 20000 });
  check(true, 'arquivo falso é recusado pela assinatura, com o motivo');

  await input.setInputFiles([iphone, plain]);
  await owner.getByText(/Todos · 2/).waitFor({ timeout: 60000 });
  check(true, 'os dois vídeos foram recebidos');
  await owner.getByRole('button', { name: 'Assistir ao vídeo de 0:03' }).nth(1).waitFor({ timeout: 90000 });
  await owner.waitForFunction(() => document.querySelectorAll('[aria-label^="Assistir ao vídeo"]:not([aria-disabled="true"]) img, [aria-label^="Assistir ao vídeo"]:not([aria-disabled="true"]) [style*="background-image"]').length >= 2, null, { timeout: 90000 });
  await owner.getByText(/Convertendo · 0/).waitFor({ timeout: 90000 });
  check(true, 'a conversão termina e a tela acompanha sozinha');
  check(await owner.getByText('+ cópia', { exact: false }).count() === 1, 'só o vídeo do celular ganhou cópia convertida');
  await owner.screenshot({ path: join(SHOTS, 'lista.png'), fullPage: true });

  console.log('2. Assistir');
  const parts = [];
  owner.on('response', (r) => { if (r.url().includes('/play')) parts.push(r.status()); });
  await owner.getByRole('button', { name: 'Assistir ao vídeo de 0:03' }).first().click();
  const video = owner.locator('video');
  await video.waitFor();
  await owner.waitForTimeout(2500);
  check(parts.length > 0 && parts.every((s) => s === 206 || s === 200), `o navegador pede o vídeo em partes (${parts.join(', ')})`);
  check(await video.evaluate((v) => !!v.controls), 'o player tem controles');
  const codec = await video.evaluate((v) => v.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'));
  if (codec) {
    const played = await video.evaluate(async (v) => {
      v.muted = true;
      await v.play();
      await new Promise((r) => setTimeout(r, 1200));
      return { time: v.currentTime, error: v.error?.code ?? null };
    });
    check(played.error === null && played.time > 0.3, `o vídeo toca de verdade (${played.time.toFixed(1)} s)`);
  } else console.log('  este navegador de teste não traz o codec H.264: a reprodução fica para o Safari e o Firefox');
  await owner.getByRole('button', { name: 'Fechar', exact: true }).last().click();

  console.log('3. Publicar e baixar');
  const list = await (await owner.request.get(`${API}/events/${ev.id}/videos`)).json();
  const phone = list.items.find((v) => v.source_format === 'mov');
  const marketing = await person(browser, 'Bia Marketing', 'marketing');
  check((await marketing.request.get(`${API}/events/${ev.id}/videos`)).status() === 404, 'o marketing não vê vídeo em conferência');
  await owner.getByRole('button', { name: /Publicar 2 vídeos prontos/ }).click();
  await owner.getByRole('button', { name: 'Publicar', exact: true }).click();
  await owner.getByText('Vídeos publicados.').waitFor();
  check((await (await marketing.request.get(`${API}/events/${ev.id}/videos`)).json()).items.length === 2, 'publicados, o marketing vê');
  const { url } = await (await marketing.request.post(`${API}/videos/${phone.id}/download-link`)).json();
  const file = await marketing.request.get(`http://localhost:8000${url}`);
  check(file.ok() && !hasLocation(await file.body()), 'o arquivo baixado não tem localização');

  console.log('4. Quem não pode');
  const visitor = await (await browser.newContext()).newPage();
  for (const path of [`/events/${ev.id}/videos`, `/videos/${phone.id}`, `/videos/${phone.id}/play`, `/videos/${phone.id}/thumb`]) {
    check((await visitor.request.get(`${API}${path}`)).status() === 401, `visitante recusado em ${path.split('/').at(-1)}`);
  }
  await visitor.goto(`${WEB}/evento/${ev.id}`, { waitUntil: 'networkidle' });
  check(await visitor.locator('video').count() === 0, 'a página pública não tem vídeo');

  console.log('5. Pela tela Enviar, onde a pessoa vai primeiro');
  await owner.goto(`${WEB}/eventos/${ev.id}/enviar`, { waitUntil: 'networkidle' });
  await owner.getByText('Arraste suas fotos e vídeos aqui').waitFor();
  check(await owner.getByText('Vídeos MP4, MOV e outros, até 1 GB e 10 minutos').isVisible(), 'a tela Enviar diz que vídeo também entra');
  const count = async () => (await (await owner.request.get(`${API}/events/${ev.id}/videos`)).json()).items.length;
  await owner.locator('input[type=file]').first().setInputFiles([
    { name: 'IMG_0001.MOV', mimeType: 'video/quicktime', buffer: readFileSync(join(BACKEND, 'tests/fixtures/apple_writer.mov')) },
    { name: 'foto.jpg', mimeType: 'image/jpeg', buffer: readFileSync(COVER) },
    { name: '00012.MTS', mimeType: 'model/vnd.mts', buffer: readFileSync(camera) },
  ]);
  await owner.getByText('2 vídeos na fila de envio').waitFor();
  check(await owner.getByText(/As fotos vão primeiro/).isVisible(), 'o aviso explica que as fotos vão primeiro, no topo');
  const corner = owner.getByRole('region', { name: 'Envio de vídeos' });
  check(await corner.getByText('Vídeos: 0 de 2 prontos').isVisible(), 'a contagem aparece no canto: 0 de 2');
  check(await corner.getByText(`2 vídeos para ${ev.name}`).isVisible(), 'o canto diz para qual evento vão os vídeos');
  await corner.getByText('2 vídeos na fila, depois das fotos.').waitFor();
  await owner.waitForTimeout(3000);
  check(await count() === 2, 'enquanto há fotos para enviar, nenhum vídeo sai');
  await owner.screenshot({ path: join(SHOTS, 'enviar-fila.png') });
  await owner.getByRole('button', { name: 'Iniciar envio (1)' }).click();
  await owner.getByText('Envio concluído').first().waitFor({ timeout: 30000 });
  // Leaving through "Conferir e publicar" used to stop the videos without a word.
  await owner.getByRole('button', { name: 'Conferir e publicar' }).click();
  await owner.waitForURL(/\/imagens/);
  // 05/11/2026: converted is not done; the block says what is missing until the videos are published.
  await corner.getByText('Os 2 vídeos terminaram de enviar. Falta publicar.').waitFor({ timeout: 90000 });
  check(true, 'depois das fotos os vídeos seguem sozinhos, mesmo trocando de tela, e o canto diz que falta publicar');
  check(await corner.getByText('Vídeos: 2 para publicar').isVisible(), 'o título conta o que falta publicar');
  check(await corner.getByRole('button', { name: /Fechar o aviso/ }).count() === 0, 'sem X enquanto falta publicar');
  const sent = (await (await owner.request.get(`${API}/events/${ev.id}/videos`)).json()).items;
  check(sent.filter((v) => v.processing_status === 'ready').length === 4, 'os dois convertem até o fim');
  check(sent.some((v) => v.source_format === 'mkv'), 'o MTS fica guardado em MKV');

  // Another event: its own block, its own button (05/11/2026).
  const ev2 = await (await owner.request.post(`${API}/events`, { multipart: {
    name: `Outro E2E ${stamp}`, theme_ids: String(theme.id), date_precision: 'day', date_start: '2030-12-21',
    location: 'Auditório', description: 'Evento do teste automatizado.', cover: { name: 'capa.jpg', mimeType: 'image/jpeg', buffer: readFileSync(COVER) } } })).json();
  // Inside the site, as a person does: a reload (goto) would forget the line, which lives only in the tab.
  await owner.getByRole('link', { name: 'Eventos' }).first().click();
  await owner.getByRole('link', { name: `Abrir ${ev2.name}` }).click();
  await owner.getByRole('tab', { name: 'Vídeos' }).or(owner.getByText('Vídeos', { exact: true })).first().click();
  await owner.waitForURL(new RegExp(`/eventos/${ev2.id}/videos`));
  await owner.getByText('Os vídeos publicados entram na busca facial').waitFor();
  await owner.locator('input[type=file]').first().setInputFiles(another);
  await corner.getByText(`1 vídeo para ${ev2.name}`).waitFor();
  check(await corner.getByText(`2 vídeos para ${ev.name}`).isVisible(), 'cada evento tem o seu bloco no canto');
  await corner.getByText('O vídeo terminou de enviar. Falta publicar.').waitFor({ timeout: 90000 });
  await owner.getByText(/Todos · 1/).waitFor({ timeout: 20000 });
  check(true, 'a aba Vídeos se atualiza sozinha quando o vídeo chega');
  await owner.screenshot({ path: join(SHOTS, 'canto-dois-eventos.png') });

  await corner.getByRole('link', { name: `Publicar em Vídeos de ${ev.name}` }).click();
  await owner.waitForURL(new RegExp(`/eventos/${ev.id}/videos`));
  await owner.getByText(/Todos · 4/).waitFor({ timeout: 20000 });
  check(await corner.getByText(`2 vídeos para ${ev.name}`).isVisible(), 'abrir a aba não apaga o aviso: ele espera a publicação');
  await owner.getByRole('button', { name: /Publicar 2 vídeos prontos/ }).click();
  await owner.getByRole('button', { name: 'Publicar', exact: true }).click();
  await corner.getByText(`2 vídeos para ${ev.name}`).waitFor({ state: 'detached', timeout: 15000 });
  check(true, 'publicados, o bloco do evento sai do canto');
  check(await corner.getByText(`1 vídeo para ${ev2.name}`).isVisible(), 'o bloco do outro evento continua');

  console.log('5b. A Visão geral lembra do vídeo não publicado');
  await owner.getByRole('link', { name: 'Visão geral' }).first().click();
  await owner.getByText(`${ev2.name}: 1 vídeo pronto para publicação`).waitFor({ timeout: 20000 });
  check(true, 'o aviso do vídeo pronto aparece em Avisos e pendências');
  check(await owner.getByText('1 vídeo a publicar').first().isVisible(), 'e na linha do evento');
  check(await owner.getByText('REMOÇÃO PENDENTE').isVisible(), 'a tabela tem a coluna de remoção pendente');
  await owner.screenshot({ path: join(SHOTS, 'visao-geral.png') });
  check((await owner.request.post(`${API}/events/${ev2.id}/videos/publish`, { data: {} })).ok(), 'o outro evento publicado');
  await corner.waitFor({ state: 'detached', timeout: 15000 });
  check(true, 'tudo publicado, o canto some sozinho');

  console.log('5c. Fechar a aba ou sair no meio de um envio pergunta antes');
  await owner.goto(`${WEB}/eventos/${ev2.id}/videos`, { waitUntil: 'networkidle' });
  let held = null;
  await owner.route('**/api/v1/events/*/videos', (r) => { if (r.request().method() === 'POST') held = r; else void r.continue(); });
  await owner.locator('input[type=file]').first().setInputFiles({ name: 'lento.mp4', mimeType: 'video/mp4', buffer: readFileSync(plain) });
  await corner.getByText(/Enviando 1 de 1/).waitFor();
  const dialogs = [];
  owner.on('dialog', (d) => { dialogs.push(d.type()); void d.dismiss(); });
  await owner.getByRole('button', { name: 'Sair' }).first().click();
  await owner.waitForTimeout(500);
  check(dialogs.includes('confirm') && (await corner.isVisible()), 'sair da conta durante o envio pergunta, e "Cancelar" mantém o envio');
  await owner.close({ runBeforeUnload: true });
  await owner.waitForTimeout(500);
  check(dialogs.includes('beforeunload') && !owner.isClosed(), 'fechar a aba durante o envio pergunta antes');
  await held?.abort();
  await owner.getByText(/Falha de transmissão|Envio interrompido/).first().waitFor({ timeout: 15000 });
  await owner.unroute('**/api/v1/events/*/videos');
  await owner.goto(`${WEB}/eventos/${ev.id}/videos`, { waitUntil: 'networkidle' });

  console.log('6. Excluir');
  await owner.getByRole('button', { name: 'Excluir', exact: true }).first().click();
  await owner.getByRole('button', { name: 'Excluir vídeo' }).click();
  await owner.getByText('Vídeo excluído.').waitFor();
  check((await (await owner.request.get(`${API}/events/${ev.id}/videos`)).json()).items.length === 3, 'o vídeo saiu');
  check(await owner.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'sem rolagem lateral');
  console.log('\nTUDO CERTO: envio, localização, conversão, reprodução, publicação, download e permissões do vídeo.');
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
