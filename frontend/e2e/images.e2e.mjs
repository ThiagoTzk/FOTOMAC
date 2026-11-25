// End-to-end test of the photos of an event (upload → review → publish → facial indexing → images →
// download), in a real browser against the real API, YuNet + SFace and SeaweedFS.
//
//   node e2e/images.e2e.mjs <photos-folder> <cover.jpg> [screenshot-folder]
//
// photos-folder must contain: grupo.jpg (a group photo), grupo-copia.jpg (same bytes),
// sem-rosto-1.jpg, sem-rosto-2.jpg and nao-imagem.jpg (a text file with a .jpg name).
// The other photo formats (HEIC, PNG, WebP, RAW) are covered by e2e/formats.e2e.mjs.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const WEB = 'http://localhost:8081';
const API = 'http://localhost:8000/api/v1';
const BACKEND = fileURLToPath(new URL('../../backend/', import.meta.url));
const OUTBOX = join(BACKEND, 'outbox');
const [PHOTOS, COVER, SHOTS = 'e2e-screenshots'] = process.argv.slice(2);
if (!PHOTOS || !COVER) throw new Error('uso: node e2e/images.e2e.mjs <pasta-fotos> <capa.jpg> [pasta]');
mkdirSync(SHOTS, { recursive: true });

const stamp = Date.now();
const email = `e2e.imagens.${stamp}@cesmac.edu.br`;
const PASSWORD = 'Fotomac#2026';
let step = 0;
const check = (ok, msg) => { if (!ok) throw new Error(`FALHOU: ${msg}`); console.log(`  ok  ${msg}`); };

function activationLink() {
  const files = readdirSync(OUTBOX).filter((f) => f.endsWith('.eml')).map((f) => join(OUTBOX, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return readFileSync(files[0], 'utf8').match(/http:\/\/localhost:8081\/primeiro-acesso\?token=[\w-]+/)[0];
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1024 }, acceptDownloads: true });
const page = await context.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/status of 40[0-9]|non-boolean attribute|accessible/.test(m.text())) problems.push(m.text().slice(0, 200));
});
const shot = async (name) => {
  step += 1;
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(SHOTS, `${String(step).padStart(2, '0')}-${name}.png`), fullPage: true });
};
const visible = (loc) => loc.filter({ visible: true });
const button = (name) => visible(page.getByRole('button', { name, exact: true }));
const text = (t) => visible(page.getByText(t)).first();

try {
  console.log('1. Fotógrafo ativado e evento criado');
  execFileSync(join(BACKEND, '.venv/bin/python'), ['scripts/create_account.py', '--name', 'Bruno Rocha Teste',
    '--email', email, '--role', 'photographer', '--signature', 'Bruno Rocha'], { cwd: BACKEND });
  await page.goto(activationLink());
  await visible(page.getByLabel('Nova senha', { exact: true })).fill(PASSWORD);
  await visible(page.getByLabel('Confirmar nova senha', { exact: true })).fill(PASSWORD);
  await button('Salvar nova senha').click();
  await visible(page.getByRole('button', { name: /Continuar para o painel/ })).click();
  await text('Olá, Bruno!').waitFor();
  // The event itself is created through the API (the screen was covered by panel.e2e.mjs).
  const created = await page.request.post(`${API}/events`, { multipart: {
    name: `FECIAL E2E ${stamp}`, theme_ids: '1', date_precision: 'day', date_start: '2026-09-18',
    location: 'Campus I', description: 'Evento do teste automatizado.',
    cover: { name: 'capa.jpg', mimeType: 'image/jpeg', buffer: readFileSync(COVER) } } });
  check(created.status() === 201, 'evento criado');
  const eventId = (await created.json()).id;

  console.log('2. Envio: validação antes de enviar (06)');
  await page.goto(`${WEB}/eventos/${eventId}/enviar`);
  await text('Arraste suas fotos e vídeos aqui').waitFor();
  // 19/10/2026: everything about minors left the system until the official answer of the advisor.
  check(!(await text(/menores de 18 anos/).isVisible().catch(() => false)), 'sem advertência de menores (retirada em 19/10)');
  await page.locator('input[type=file]').setInputFiles(['grupo.jpg', 'sem-rosto-1.jpg', 'sem-rosto-2.jpg', 'nao-imagem.jpg']
    .map((f) => join(PHOTOS, f)));
  await text('Arquivos selecionados · 4').waitFor();
  await visible(page.getByRole('button', { name: 'Iniciar envio (3)' })).waitFor();
  check(await text('Inválido').isVisible(), 'arquivo que não é imagem, com nome .jpg, recusado pela assinatura binária');
  await shot('envio-selecao');

  console.log('3. Acompanhamento do envio (07)');
  await visible(page.getByRole('button', { name: 'Iniciar envio (3)' })).click();
  await text('Envio concluído').waitFor({ timeout: 60000 });
  check(await text('3 de 3 imagens enviadas').isVisible(), '3 de 3 enviadas');
  await shot('envio-concluido');

  console.log('4. Duplicata detectada antes de enviar');
  await page.goto(`${WEB}/eventos/${eventId}/enviar`);
  await page.locator('input[type=file]').setInputFiles([join(PHOTOS, 'grupo-copia.jpg')]);
  await text('Arquivo duplicado').waitFor();
  check(true, 'cópia da foto já enviada marcada como duplicada');
  await shot('envio-duplicado');

  console.log('5. Conferência na aba Imagens (a tela antiga "Conferir imagens" saiu em 22/10/2026)');
  await page.goto(`${WEB}/eventos/${eventId}/imagens?filtro=in_review`);
  await text('3 imagens prontas para publicação').waitFor();
  // Discard one photo WITHOUT faces: the upload order varies, so it is chosen by data
  // (the group photo is the biggest file), never by position alone.
  const listed = (await (await page.request.get(`${API}/events/${eventId}/images?filter=in_review`)).json()).items;
  const biggest = Math.max(...listed.map((i) => i.size_bytes));
  const target = listed.find((i) => i.size_bytes !== biggest);
  await page.goto(`${WEB}/eventos/${eventId}/imagens/${target.id}?filtro=in_review`);
  await text(/Foto \d de 3/).waitFor();
  await button('Descartar').click();
  await button('Desfazer descarte').waitFor();
  check(true, 'descarte pontual');
  const before = await text(/Foto \d de/).textContent();
  await page.keyboard.press(before.startsWith('Foto 1') ? 'ArrowRight' : 'ArrowLeft');
  await page.waitForFunction((b) => !document.body.innerText.includes(b), before);
  check(true, 'navegação sequencial pelo teclado');
  // 24/10/2026: changing photo keeps the page where it is (it used to jump to the top) …
  const scroller = () => page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].filter((d) => d.scrollHeight > d.clientHeight + 20
      && /auto|scroll/.test(getComputedStyle(d).overflowY)).sort((a, b) => b.clientHeight - a.clientHeight)[0];
    return el ? { top: el.scrollTop, max: el.scrollHeight - el.clientHeight } : null;
  });
  await page.setViewportSize({ width: 1440, height: 640 });
  // Wait for the page to settle in the new size: measured at once it still scrolled 156 px of its 333, the scroll sat
  // at the end, and when the page grew the browser moved it (failed twice, 06/11/2026; the site never went to the top).
  let settled = -1;
  for (let i = 0; i < 20; i++) {
    const now = (await scroller())?.max ?? 0;
    if (now === settled) break;
    settled = now;
    await page.waitForTimeout(300);
  }
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].filter((d) => d.scrollHeight > d.clientHeight + 20
      && /auto|scroll/.test(getComputedStyle(d).overflowY)).sort((a, b) => b.clientHeight - a.clientHeight)[0];
    // Half of what the page scrolls: away from both ends.
    el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) / 2);
  });
  const beforeMove = await scroller();
  const shownNow = await text(/Foto \d de/).textContent();
  await page.keyboard.press(shownNow.startsWith('Foto 1') ? 'ArrowRight' : 'ArrowLeft');
  await page.waitForFunction((b) => !document.body.innerText.includes(b), shownNow);
  await page.waitForTimeout(500);
  check(beforeMove && beforeMove.top > 0 && (await scroller()).top === beforeMove.top, `trocar de foto não volta a página para o topo (rolagem em ${beforeMove?.top} px)`);
  await page.setViewportSize({ width: 1440, height: 1024 });
  // "Detalhes" (24/10/2026): the main data of the file and, on "Ver mais detalhes", every tag.
  await text('Arquivo original').waitFor();
  check(await text(/^JPEG · /).isVisible() && await text('Removida no envio, por privacidade').isVisible(),
        'detalhes: tamanho do original e a localização removida');
  await button('Ver mais detalhes').click();
  await text('Todos os detalhes do arquivo').waitFor();
  await shot('todos-os-detalhes');
  await button('Fechar').last().click();
  await text('Todos os detalhes do arquivo').waitFor({ state: 'hidden' });
  check(true, '"Ver mais detalhes" mostra todos os dados do arquivo');
  // … and a click on the photo opens it in full screen, with zoom, ← → and Esc.
  await button('Ver a foto em tela cheia').click();
  await text(/← → trocam de foto/).waitFor();
  const fsTitle = await text(/^Foto \d de 3$/).textContent();
  await page.keyboard.press(fsTitle.startsWith('Foto 1') ? 'ArrowRight' : 'ArrowLeft');
  await page.waitForFunction((b) => ![...document.querySelectorAll('div')].some((d) => d.textContent === b), fsTitle);
  check(true, 'tela cheia: clicar na foto abre, ← → trocam de foto');
  await button('Detalhes da foto').click();
  await page.getByText('Arquivo original').filter({ visible: true }).last().waitFor();
  check(true, 'tela cheia: o botão "Detalhes" abre os dados do arquivo ao lado da foto');
  await shot('tela-cheia');
  await page.keyboard.press('Escape');
  await text(/← → trocam de foto/).waitFor({ state: 'hidden' });
  await shot('visualizacao-individual');
  await page.goto(`${WEB}/eventos/${eventId}/imagens?filtro=in_review`);
  await text('2 imagens prontas para publicação').waitFor();
  await shot('conferencia');

  console.log('6. Publicação (10) e indexação facial com o YuNet + SFace (11)');
  await button('Publicar todas (2)').click();
  await text('Publicar 2 imagens?').waitFor();
  await shot('confirmar-publicacao');
  await button('Publicar 2 imagens').last().click();
  await text('Processamento das imagens').waitFor();
  // 24/10/2026: the processing screen shows the photos just published, not the first ones of the event.
  await text('Imagens desta publicação (2)').waitFor();
  check(true, 'processamento mostra as imagens desta publicação');
  await text('Processamento concluído').waitFor({ timeout: 90000 });
  check(await text(/6 rostos indexados/).isVisible(), 'a foto de grupo gerou 6 vetores faciais');
  await shot('processamento-concluido');
  const ev = await (await page.request.get(`${API}/events/${eventId}`)).json();
  check(ev.status === 'published', 'evento passou para "Publicado" sozinho');

  console.log('7. Gerenciamento (12), imagem publicada (13) e confirmação de exclusão (14)');
  await page.goto(`${WEB}/eventos/${eventId}/imagens`);
  await text('Faces indexadas').waitFor();
  check(await text('Sem faces detectadas · 1').isVisible(), 'paisagem sem rosto classificada');
  await shot('imagens');
  // The actions follow the scroll (24/10/2026): with the page scrolled to the end, "Selecionar" is on screen.
  await page.setViewportSize({ width: 1440, height: 560 });
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].filter((d) => d.scrollHeight > d.clientHeight + 20
      && /auto|scroll/.test(getComputedStyle(d).overflowY)).sort((a, b) => b.clientHeight - a.clientHeight)[0];
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(400);
  const bar = await button('Selecionar').boundingBox();
  check(bar && bar.y >= 0 && bar.y + bar.height <= 560, 'a barra de ações acompanha a rolagem');
  await page.setViewportSize({ width: 1440, height: 1024 });
  await visible(page.getByRole('tab', { name: /Publicada/ })).click();
  const images = await (await page.request.get(`${API}/events/${eventId}/images?filter=published`)).json();
  const group = images.items.find((i) => i.faces_count === 6);
  await page.goto(`${WEB}/eventos/${eventId}/imagens/${group.id}`);
  await text('6 rostos detectados e indexados').waitFor();
  check(await text('Fotografia por: Bruno Rocha · Centro Universitário CESMAC').isVisible(), 'crédito no formato oficial');
  await shot('imagem-publicada');
  await button('Excluir imagem').click();
  await text('Excluir imagem?').waitFor();
  await shot('confirmar-exclusao');
  await button('Cancelar').click();

  console.log('8. Download do acervo (15)');
  await page.goto(`${WEB}/eventos/${eventId}/download`);
  await button('Preparar arquivo').click();
  await text('Seu arquivo está pronto').waitFor({ timeout: 60000 });
  await shot('download-pronto');
  const [download] = await Promise.all([page.waitForEvent('download'), button('Baixar arquivo ZIP').click()]);
  // The server of the address, not "8333" anywhere in it: a random part of the link can contain those digits.
  const zipLink = new URL(download.url());
  check(zipLink.host === new URL(API).host && !/X-Amz/i.test(zipLink.search), 'ZIP vem pela API: o endereço não expõe o armazenamento');
  check((await (await browser.newContext()).request.get(download.url())).status() === 401, 'o link não funciona fora da sessão');
  const zipPath = join(SHOTS, 'acervo.zip');
  await download.saveAs(zipPath);
  const inspect = execFileSync(join(BACKEND, '.venv/bin/python'), ['-c', `
import zipfile, piexif, sys
z = zipfile.ZipFile(sys.argv[1]); names = z.namelist()
artist = piexif.load(z.read(names[0]))['0th'].get(piexif.ImageIFD.Artist, b'').decode()
gps = any(piexif.load(z.read(n))['GPS'] for n in names)
print(len(names), len({n.split('/')[0] for n in names}), artist, gps)`, zipPath]).toString().trim().split(' ');
  check(inspect[0] === '2' && inspect[1] === '1', 'ZIP com as 2 fotos publicadas em uma única pasta');
  check(inspect.slice(2, -1).join(' ') === 'Bruno Rocha' && inspect.at(-1) === 'False', 'crédito nos metadados e sem GPS');

  check(problems.length === 0, `console sem erros${problems.length ? ': ' + problems.join(' | ') : ''}`);
  console.log('\nTUDO CERTO — envio, conferência, publicação, indexação facial, imagens e download.');
} catch (err) {
  await shot('FALHA');
  console.error(`\n${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
