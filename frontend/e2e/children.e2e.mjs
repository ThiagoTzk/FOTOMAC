// 04/11/2026: events with children and the blur tool, after the answer of the coordinator and the advisor.
// The switch "Este evento contém imagens com crianças" asks for the declaration of the guardians' authorisation and
// where the terms are; the team and the visitor see the notice; "Borrar rostos" hides a face IN the file.
//
//   node e2e/children.e2e.mjs <fotos> [pasta-capturas]
//
// fotos: grupo.jpg (faces) and capa.jpg.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const [PHOTOS, SHOTS = 'e2e-screenshots/children'] = process.argv.slice(2);
if (!PHOTOS) throw new Error('uso: node e2e/children.e2e.mjs <fotos> [pasta-capturas]');
mkdirSync(SHOTS, { recursive: true });
const API = 'http://localhost:8000/api/v1';
const WEB = 'http://localhost:8081';
const BACKEND = fileURLToPath(new URL('../../backend/', import.meta.url));
const OUTBOX = join(BACKEND, 'outbox');
const PASSWORD = 'Fotomac#2026';
const stamp = Date.now();
const EVENT = `OBR E2E ${stamp}`;
const TERMS = 'Secretaria do curso, pasta OBR 2026';
const check = (ok, msg) => { if (!ok) throw new Error(`FALHOU: ${msg}`); console.log(`  ok  ${msg}`); };
const photo = (name) => join(PHOTOS, name);

function token(email) {
  const files = readdirSync(OUTBOX).filter((f) => f.endsWith('.eml')).map((f) => join(OUTBOX, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const f of files) { const m = readFileSync(f, 'utf8'); if (m.includes(`To: ${email}`)) return m.match(/primeiro-acesso\?token=([\w-]+)/)[1]; }
  throw new Error(`sem link para ${email}`);
}

const browser = await chromium.launch();
const problems = [];
try {
  console.log('1. Criar o evento com crianças');
  const email = `e2e.criancas.${stamp}@cesmac.edu.br`;
  execFileSync(join(BACKEND, '.venv/bin/python'), ['scripts/create_account.py', '--name', 'Clara Criancas', '--email', email,
    '--role', 'photographer', '--signature', 'Clara Criancas'], { cwd: BACKEND });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  page.on('pageerror', (e) => problems.push(e.message));
  const ok = await page.request.post(`${API}/auth/first-access`, { data: { token: token(email), password: PASSWORD, password_confirmation: PASSWORD } });
  check(ok.ok(), 'fotógrafa ativada');
  const visible = (loc) => loc.filter({ visible: true });
  const button = (name) => visible(page.getByRole('button', { name, exact: true })).first();
  const field = (label) => visible(page.getByLabel(label, { exact: true })).first();

  await page.goto(`${WEB}/eventos/novo`, { waitUntil: 'networkidle' });
  await field('Nome do evento').fill(EVENT);
  await visible(page.getByRole('button', { name: 'Temas' })).click();
  await visible(page.getByRole('menuitem')).first().click();
  await visible(page.getByRole('button', { name: 'Concluir' })).click();
  await field('Data do evento').fill('20102026');
  await field('Local').fill('Ginásio do Campus I');
  await field('Descrição').fill('Olimpíada de robótica com escolas.');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'),
                                       visible(page.getByRole('button', { name: 'Selecionar capa JPEG' })).click()]);
  await chooser.setFiles(photo('capa.jpg'));
  const box = visible(page.getByRole('checkbox', { name: 'Este evento contém imagens com crianças' }));
  check(await box.getAttribute('aria-checked') === 'false', 'a chave das crianças começa desligada (nada marcado de antemão)');
  await box.click();
  await visible(page.getByText('Onde estão guardados os termos assinados')).first().waitFor();
  await button('Criar evento').click();
  await visible(page.getByText('Marque a declaração de que a autorização dos responsáveis foi coletada.')).waitFor();
  check(true, 'sem a declaração, o evento não é criado');
  await visible(page.getByRole('checkbox', { name: /Declaro que a autorização/ })).click();
  await field('Onde estão guardados os termos assinados').fill(TERMS);
  await page.screenshot({ path: join(SHOTS, '01-formulario.png'), fullPage: true });
  await button('Criar evento').click();
  await visible(page.getByRole('heading', { name: EVENT })).waitFor();
  const eventId = page.url().split('/eventos/')[1].split(/[/?#]/)[0];
  await visible(page.getByText('Este evento contém imagens com crianças')).first().waitFor();
  check(await visible(page.getByText(new RegExp(`Termos: ${TERMS}`))).isVisible(), 'o aviso do painel diz quem declarou e onde estão os termos');
  await page.screenshot({ path: join(SHOTS, '02-aviso-painel.png'), fullPage: true });

  console.log('2. Configuração do evento: desligar e ligar de novo');
  await visible(page.getByRole('tab', { name: 'Configuração' })).click();
  const sw = visible(page.getByRole('switch', { name: 'Este evento contém imagens com crianças' }));
  await sw.waitFor();
  check(await sw.getAttribute('aria-checked') === 'true', 'a chave aparece ligada');
  await visible(page.getByText(/Declarado por Clara Criancas em/)).waitFor();
  await sw.click();
  await page.waitForResponse((r) => r.url().endsWith('/children') && r.request().method() === 'PUT');
  check(!(await (await page.request.get(`${API}/events/${eventId}`)).json()).has_children, 'desligada, salva na hora');
  await sw.click();
  await visible(page.getByRole('button', { name: 'Confirmar' })).click();
  await visible(page.getByText('Marque a declaração de que a autorização dos responsáveis foi coletada.')).waitFor();
  check(!(await (await page.request.get(`${API}/events/${eventId}`)).json()).has_children, 'ligar pede a declaração de novo, sem salvar antes');
  await visible(page.getByRole('checkbox', { name: /Declaro que a autorização/ })).click();
  await field('Onde estão guardados os termos assinados').fill(TERMS);
  await page.screenshot({ path: join(SHOTS, '03-configuracao.png'), fullPage: true });
  await visible(page.getByRole('button', { name: 'Confirmar' })).click();
  await visible(page.getByText(/Declarado por Clara Criancas em/)).waitFor();
  check((await (await page.request.get(`${API}/events/${eventId}`)).json()).children_authorization_ref === TERMS, 'ligada de novo, com a declaração');

  console.log('3. Borrar o rosto de uma criança no arquivo');
  const up = await page.request.post(`${API}/events/${eventId}/images`, { multipart: {
    file: { name: 'grupo.jpg', mimeType: 'image/jpeg', buffer: readFileSync(photo('grupo.jpg')) } } });
  check(up.ok(), 'foto com rostos enviada');
  const image = await up.json();
  const before = (await (await page.request.get(`${API}/images/${image.id}`)).json()).version;
  check((await page.request.post(`${API}/events/${eventId}/images`, { multipart: {
    file: { name: 'capa.jpg', mimeType: 'image/jpeg', buffer: readFileSync(photo('capa.jpg')) } } })).ok(), 'foto sem rosto enviada');
  // 05/11/2026: where the photos are checked, with the way written out; several photos one after the other.
  await page.goto(`${WEB}/eventos/${eventId}/imagens`, { waitUntil: 'networkidle' });
  await visible(page.getByText('Evento com crianças: confira os rostos')).waitFor();
  check(await visible(page.getByText(/Borrar rostos nas selecionadas/)).first().isVisible(), 'o aviso no topo explica como borrar');
  await page.screenshot({ path: join(SHOTS, '03b-conferir.png'), fullPage: true });
  await button('Selecionar fotos para borrar').click();
  // 05/11/2026: "selecionar todas > borrar rostos".
  await button('Selecionar todas (2)').click();
  await visible(page.getByText('2 selecionadas')).waitFor();
  await button('Desmarcar todas').click();
  await visible(page.getByText('0 selecionadas')).waitFor();
  await button('Selecionar todas (2)').click();
  check(await button('Borrar rostos nas selecionadas (2)').isVisible(), '"Selecionar todas" marca todas, "Desmarcar todas" desfaz');
  await page.screenshot({ path: join(SHOTS, '03c-selecionar-todas.png') });
  await button('Borrar rostos nas selecionadas (2)').click();
  let count = 0;
  for (let n = 1; n <= 2; n++) {
    await visible(page.getByText(`Foto ${n} de 2`)).waitFor();
    await visible(page.getByText(/rosto\(s\) detectado\(s\)/)).waitFor({ timeout: 30000 });
    const faces = page.getByTestId('blur-face');
    const here = await faces.count();
    if (here >= 2) {
      count = here;
      const target = await faces.first().boundingBox();
      await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
      await page.getByTestId('blur-face-on').first().waitFor();
      await page.screenshot({ path: join(SHOTS, '04-borrar.png') });
      await button(n === 2 ? 'Borrar e concluir' : 'Borrar e ir para a próxima').click();
    } else {
      await button(n === 2 ? 'Nada a borrar: concluir' : 'Nada a borrar: próxima foto').click();
    }
  }
  await visible(page.getByText('1 foto borrada, 1 sem nada a borrar.')).waitFor({ timeout: 30000 });
  check(count >= 2, `as fotos abrem uma por uma: rostos localizados, sem vetor (${count}), e a sem rosto é pulada`);
  const after = await (await page.request.get(`${API}/images/${image.id}`)).json();
  check(after.faces_blurred === 1 && after.version !== before, 'o arquivo foi substituído com o rosto borrado');
  const faceList = await (await page.request.get(`${API}/images/${image.id}/faces`)).json();
  check(faceList.faces.length === count - 1, `o rosto borrado não é mais encontrado (${faceList.faces.length} de ${count})`);

  console.log('4. O visitante vê o aviso, nunca onde estão os termos');
  check((await page.request.post(`${API}/events/${eventId}/publish`, { data: {} })).ok(), 'evento publicado');
  for (let n = 0; n < 60 && (await page.request.get(`${API}/public/events/${eventId}`)).status() !== 200; n++) await page.waitForTimeout(1000);
  check((await page.request.get(`${API}/public/events/${eventId}`)).status() === 200, 'o reconhecimento terminou e o evento está no site');
  const visitor = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  visitor.on('pageerror', (e) => problems.push(e.message));
  await visitor.goto(`${WEB}/evento/${eventId}`, { waitUntil: 'networkidle' });
  await visitor.getByText(/Este evento contém imagens com crianças\. O uso dessas imagens tem a autorização dos responsáveis/).first().waitFor();
  check(true, 'aviso na página do evento');
  check(!(await visitor.content()).includes(TERMS), 'o local dos termos não chega ao visitante');
  // 05/11/2026: with the event's information, in the blue band beside the cover.
  const cover = await visitor.getByText(EVENT, { exact: true }).first().boundingBox();
  const search = await visitor.getByRole('button', { name: 'Buscar minhas fotos' }).first().boundingBox();
  const note = await visitor.getByText(/Este evento contém imagens com crianças/).first().boundingBox();
  check(note.y > cover.y && note.y < search.y && note.x >= cover.x - 2, 'o aviso fica na faixa azul, com as informações do evento');
  check(await visitor.getByText('Este evento não possui mapa.').isVisible(), 'sem pin, o espaço do mapa diz que o evento não possui mapa');
  await visitor.screenshot({ path: join(SHOTS, '05-visitante.png'), fullPage: true });
  await visitor.goto(`${WEB}/privacidade`, { waitUntil: 'networkidle' });
  await visitor.getByText('Crianças', { exact: true }).first().waitFor();
  check(await visitor.getByText(/rosto borrado não gera vetor facial/).isVisible(), 'a Política explica o tratamento das crianças');

  check(problems.length === 0, `sem erros na página${problems.length ? `: ${problems.join(' | ')}` : ''}`);
  console.log('\nTUDO OK');
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
