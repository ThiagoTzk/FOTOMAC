// End-to-end test of the institutional people, in a real browser against the real API,
// YuNet + SFace and SeaweedFS: the administrator registers a person, the person signs ON THE SCREEN from
// the link, the whole collection is searched, a photographer consults and confirms, the administrator
// downloads the official PDF, and the person revokes.
//
//   node e2e/institutional.e2e.mjs <photos-folder> [screenshot-folder]
//
// photos-folder: grupo.jpg (a group photo), referencia.jpg (one face of that photo) and capa.jpg.
// E-mails are not really sent yet: the links come from backend/outbox (development mode).
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const WEB = 'http://localhost:8081';
const API = 'http://localhost:8000/api/v1';
const BACKEND = fileURLToPath(new URL('../../backend/', import.meta.url));
const OUTBOX = join(BACKEND, 'outbox');
const [PHOTOS, SHOTS = 'e2e-screenshots/institucionais'] = process.argv.slice(2);
if (!PHOTOS) throw new Error('uso: node e2e/institutional.e2e.mjs <pasta-fotos> [pasta-capturas]');
mkdirSync(SHOTS, { recursive: true });

const stamp = Date.now();
const PASSWORD = 'Fotomac#2026';
const personEmail = `e2e.institucional.${stamp}@cesmac.edu.br`;
let step = 0;
const check = (ok, msg) => { if (!ok) throw new Error(`FALHOU: ${msg}`); console.log(`  ok  ${msg}`); };
const problems = [];

/** Draws a signature in the page's signature box (mouse strokes, like a person), in "Desenhar". */
async function draw(page) {
  await page.getByRole('tab', { name: 'Desenhar' }).filter({ visible: true }).click();
  await page.locator('canvas').scrollIntoViewIfNeeded();
  const box = await page.locator('canvas').boundingBox();
  await page.mouse.move(box.x + 40, box.y + box.height * 0.7);
  await page.mouse.down();
  for (const [fx, fy] of [[0.2, 0.3], [0.35, 0.7], [0.5, 0.25], [0.65, 0.75], [0.85, 0.35]]) {
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 12 });
  }
  await page.mouse.up();
}

/** The button's disabled state after the screen settles (the signature box updates a moment later). */
async function settledDisabled(locator) {
  for (let i = 0; i < 20; i++) {
    if (await locator.isDisabled()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function newestMail(to, pattern) {
  const files = readdirSync(OUTBOX).filter((f) => f.endsWith('.eml')).map((f) => join(OUTBOX, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (text.includes(`To: ${to}`) && pattern.test(text)) return text.match(pattern)[0];
  }
  throw new Error(`nenhum e-mail para ${to}`);
}

const browser = await chromium.launch();
async function context() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1024 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 40[0-9]|non-boolean attribute|accessible/.test(m.text())) problems.push(m.text().slice(0, 200));
  });
  return page;
}
const tools = (page) => ({
  text: (t) => page.getByText(t).filter({ visible: true }).first(),
  button: (name) => page.getByRole('button', { name, exact: true }).filter({ visible: true }),
  shot: async (name) => {
    step += 1;
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(SHOTS, `${String(step).padStart(2, '0')}-${name}.png`), fullPage: true });
  },
});

async function signIn(name, role, signature) {
  const page = await context();
  const email = `e2e.inst.${role}.${stamp}@cesmac.edu.br`;
  const args = ['scripts/create_account.py', '--name', name, '--email', email, '--role', role];
  execFileSync(join(BACKEND, '.venv/bin/python'), signature ? [...args, '--signature', signature] : args, { cwd: BACKEND });
  await page.goto(newestMail(email, /http:\/\/localhost:8081\/primeiro-acesso\?token=[\w-]+/));
  await page.getByLabel('Nova senha', { exact: true }).filter({ visible: true }).fill(PASSWORD);
  await page.getByLabel('Confirmar nova senha', { exact: true }).filter({ visible: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Salvar nova senha', exact: true }).filter({ visible: true }).click();
  await page.getByRole('button', { name: /Continuar para o painel/ }).filter({ visible: true }).click();
  return page;
}

try {
  console.log('1. Fotógrafo publica um evento; administrador ativado');
  const photographer = await signIn('Bruno Rocha Institucional', 'photographer', 'Bruno Rocha');
  const created = await photographer.request.post(`${API}/events`, { multipart: {
    name: `COLAÇÃO E2E ${stamp}`, theme_ids: '1', date_precision: 'day', date_start: '2026-09-18',
    location: 'Campus I', description: 'Evento do teste automatizado.',
    cover: { name: 'capa.jpg', mimeType: 'image/jpeg', buffer: readFileSync(join(PHOTOS, 'capa.jpg')) } } });
  const eventId = (await created.json()).id;
  const sent = await photographer.request.post(`${API}/events/${eventId}/images`, {
    multipart: { file: { name: 'grupo.jpg', mimeType: 'image/jpeg', buffer: readFileSync(join(PHOTOS, 'grupo.jpg')) } } });
  check(sent.status() === 201, 'foto de grupo enviada');
  check((await photographer.request.post(`${API}/events/${eventId}/publish`)).ok(), 'evento publicado');
  for (let i = 0; i < 60; i++) {
    if ((await (await photographer.request.get(`${API}/events/${eventId}`)).json()).status === 'published') break;
    await photographer.waitForTimeout(1000);
  }
  const admin = await signIn('Admin Institucional', 'admin');
  const a = tools(admin);

  console.log('2. Administrador cadastra a pessoa com a foto de referência');
  await admin.goto(`${WEB}/pessoas-institucionais`);
  await admin.getByLabel('Buscar pessoa institucional').filter({ visible: true }).waitFor();
  await a.button('Cadastro de pessoas').click();
  await a.button('Cadastrar pessoa').click();
  await admin.getByLabel('Nome completo').filter({ visible: true }).fill('Maria Silva');
  await admin.getByLabel('Cargo ou função').filter({ visible: true }).fill('Pró-reitora de Extensão');
  await admin.getByLabel('Unidade ou curso').filter({ visible: true }).fill('Reitoria / Campus I');
  await admin.getByLabel('E-mail institucional').filter({ visible: true }).fill(personEmail);
  const [chooser] = await Promise.all([admin.waitForEvent('filechooser'), admin.getByRole('button', { name: 'Adicionar fotografias' }).click()]);
  await chooser.setFiles(join(PHOTOS, 'referencia.jpg'));
  await a.text('Fotografias de referência (1 de 5)').waitFor();
  await a.shot('cadastro-nova');
  await a.button('Cadastrar e enviar o termo').click();
  await a.text('Aguardando a assinatura da pessoa').waitFor();
  check(await a.text(/as fotos não são processadas/).isVisible(), 'aguardando: nada processado antes da assinatura');
  await a.shot('cadastro-aguardando');

  console.log('3. A pessoa abre o link do e-mail, lê, vê a foto e assina na tela');
  const link = newestMail(personEmail, /http:\/\/localhost:8081\/autorizacao\?token=[\w-]+/);
  const holder = await context();
  const h = tools(holder);
  await holder.goto(link);
  await h.text('Fotografias que serão usadas para localizar você').waitFor();
  check(await h.text(/Art\. 11, I/).isVisible(), 'o termo cita a base legal (consentimento específico e destacado)');
  // 25/10/2026: typed (the default, the name already filled in and editable), drawn or a rubrica.
  await holder.getByRole('tab', { name: 'Desenhar' }).filter({ visible: true }).click();
  check(await settledDisabled(h.button('Assinar e autorizar')), 'desenhando, sem traço o botão fica desligado');
  await holder.getByRole('tab', { name: 'Digitar' }).filter({ visible: true }).click();
  const typedName = holder.getByLabel('Nome da assinatura').filter({ visible: true });
  check(await typedName.inputValue() === 'Maria Silva', 'digitada: o nome vem preenchido e pode ser editado');
  await typedName.fill('');
  check(await settledDisabled(h.button('Assinar e autorizar')), 'sem nome digitado, não assina');
  await typedName.fill('Maria S. Silva');
  await holder.getByRole('radio', { name: 'Estilo Elegante' }).click();
  await h.button('Assinar e autorizar').waitFor();
  await holder.waitForFunction(() => !document.querySelector('[aria-label="Assinar e autorizar"]')?.getAttribute('aria-disabled'),
                               null, { timeout: 10000 }).catch(() => undefined);
  await h.shot('assinatura-digitada');
  await h.button('Assinar e autorizar').click();
  await h.text(/Autorização assinada/).waitFor();
  check(true, 'assinada com a assinatura digitada, no estilo escolhido');
  check(!(await holder.evaluate(() => document.body.innerText.includes('revogar?token'))),
        'o link de revogação não aparece na tela (vai só por e-mail)');
  await h.shot('assinado');
  check((await holder.request.get(link.replace(WEB, `${API}/public/institutional`).replace('/autorizacao?', '/authorization?'))).status() === 404,
        'o link é de uso único');

  console.log('4. O sistema procura a pessoa no acervo; a assinatura aparece no site; PDF oficial');
  await admin.reload();
  await a.text('Assinatura eletrônica').waitFor();
  for (let i = 0; i < 40 && await a.text(/Procurando esta pessoa no acervo/).isVisible().catch(() => false); i++) await admin.waitForTimeout(1000);
  await admin.reload();
  // Counted on THIS test's event: the development database may hold real events too.
  for (let i = 0; i < 30; i++) {
    const r = await (await admin.request.get(`${API}/institutional/people`)).json();
    const me = r.find((x) => x.full_name === 'Maria Silva');
    const evs = me ? (await (await admin.request.get(`${API}/institutional/people/${me.id}/profile`)).json()).events : [];
    if (evs.some((e) => e.id === eventId && e.images.length === 1)) break;
    await admin.waitForTimeout(1000);
  }
  await admin.reload();
  await a.text(/\d+ a confirmar/).waitFor({ timeout: 30000 });
  check(true, 'a pessoa foi localizada na foto de grupo do evento');
  await a.text('Assinatura eletrônica').scrollIntoViewIfNeeded();
  await admin.waitForFunction(() => [...document.images].some((i) => i.src.includes('/signature') && i.complete && i.naturalWidth > 0),
                              null, { timeout: 15000 });
  check(true, 'a assinatura aparece no cadastro (imagem carregada do servidor)');
  await a.shot('cadastro-assinado');
  const [pdf] = await Promise.all([admin.waitForEvent('download'), a.button('Baixar formulário (PDF)').click()]);
  const pdfPath = join(SHOTS, 'autorizacao.pdf');
  await pdf.saveAs(pdfPath);
  check(readFileSync(pdfPath).subarray(0, 4).toString() === '%PDF', 'formulário oficial em PDF baixado');

  console.log('5. Fotógrafo busca a pessoa, abre o perfil, confirma em tela cheia e baixa com o nome');
  const p = tools(photographer);
  await photographer.goto(`${WEB}/pessoas-institucionais`);
  const search = photographer.getByLabel('Buscar pessoa institucional').filter({ visible: true });
  const person = () => photographer.getByRole('link', { name: /Maria Silva/ }).filter({ visible: true });
  await search.fill('maria s');                                  // first name + start of the surname
  await person().waitFor();
  check(true, 'busca escrita: "maria s" acha Maria Silva');
  await search.fill('pró-reit');                                 // by role, with or without accents
  await person().waitFor();
  await search.fill('pro reitora exten');
  await person().waitFor();
  check(true, 'busca pelo cargo, sem depender de acento');
  await search.fill('fulano');
  await p.text(/Ninguém encontrado com/).waitFor();
  await search.fill('silva');
  // 31/10/2026: the team that confirms the marks sees the reference photos (term v4), not only the administrator.
  // Waits for the image to finish loading (checking at once raced with the download: 01/11/2026).
  const imageLoaded = (alt) => photographer.waitForFunction((a) => [...document.images].some((i) => i.alt === a && i.complete && i.naturalWidth > 0),
                                                            alt, { timeout: 10000 }).then(() => true, () => false);
  await photographer.waitForFunction(() => [...document.images].some((i) => i.alt === 'Foto de referência de Maria Silva' && i.naturalWidth > 0),
                                     null, { timeout: 10000 });
  check(true, 'o fotógrafo vê a foto de referência na lista');
  await p.shot('busca-por-nome');
  await person().click();
  // 24/10/2026: one page per person — the events, each with the person's photos.
  // The development database may hold real events where the sample face is also found: count on ours.
  await p.text(/\d+ fotos? em \d+ eventos?/).waitFor();
  check(await p.text(/COLAÇÃO E2E/).isVisible(), 'o perfil mostra o evento em que a pessoa aparece');
  // Events start closed when there are several (24/10/2026): the arrow opens ours.
  const closed = photographer.getByRole('button', { name: /COLAÇÃO E2E .*: ver as fotos/ }).filter({ visible: true });
  if (await closed.count()) await closed.first().click();
  check(await photographer.getByText('Cargo', { exact: true }).first().isVisible() && await imageLoaded('Foto de referência 1 de Maria Silva'),
        'cartão da pessoa: foto do termo, nome e cargo');
  await p.shot('perfil');
  await photographer.getByRole('button', { name: /Abrir foto de COLAÇÃO E2E/ }).first().click();
  await p.text(/Maria Silva · foto \d+ de \d+/).waitFor();
  check(await p.button('Não é Maria').isVisible(), 'tela cheia com "Não é Maria"');
  await photographer.waitForFunction(() => [...document.images].filter((i) => i.alt === 'Foto de referência 1 de Maria Silva' && i.naturalWidth > 0).length >= 2,
                                     null, { timeout: 10000 });
  check(await p.text('Fotos do termo').first().isVisible(), 'na tela cheia, as fotos do termo ficam ao lado para comparar');
  check(!(await p.button('Baixar com o nome').isVisible().catch(() => false)), 'sem confirmar, não baixa');
  await p.shot('tela-cheia');
  await p.button('É Maria: confirmar').click();
  // Confirming moves on to the next photo, if there is one (a real event in the dev database): come back.
  await photographer.waitForTimeout(1500);
  if (!(await p.button('Baixar com o nome').isVisible().catch(() => false))) await photographer.keyboard.press('ArrowLeft');
  await p.shot('depois-de-confirmar');
  await p.button('Baixar com o nome').waitFor();
  check(true, 'confirmada por uma pessoa, dentro da tela cheia');
  const [named] = await Promise.all([photographer.waitForEvent('download'), p.button('Baixar com o nome').click()]);
  check(/^Maria Silva - COLAÇÃO E2E .+\.jpg$/.test(named.suggestedFilename()), `arquivo com o nome da pessoa (${named.suggestedFilename()})`);
  const namedPath = join(SHOTS, 'foto-com-nome.jpg');
  await named.saveAs(namedPath);
  check(readFileSync(namedPath).includes(Buffer.from('Maria Silva, Pró-reitora')), 'nome e cargo nos dados da foto');
  await photographer.keyboard.press('Escape');
  await p.text('Confirmada').waitFor();
  // Period by dates: a range without our event leaves it out.
  await photographer.getByRole('button', { name: 'Período' }).filter({ visible: true }).click();
  await p.text('Escolher as datas…').click();
  await photographer.getByLabel('Data inicial (dd/mm/aaaa)').filter({ visible: true }).fill('01012020');
  await photographer.getByLabel('Data final (dd/mm/aaaa)').filter({ visible: true }).fill('31122020');
  const gone = await p.text(/COLAÇÃO E2E/).first().waitFor({ state: 'hidden', timeout: 10000 }).then(() => true, () => false);
  check(gone, 'período 01/01/2020 a 31/12/2020: o evento de 2026 sai da lista');
  await photographer.getByLabel('Data final (dd/mm/aaaa)').filter({ visible: true }).fill('31122026');
  await p.text(/COLAÇÃO E2E/).waitFor();
  check(true, 'até 31/12/2026: o evento volta');

  console.log('5b. O administrador corrige o cargo e troca o e-mail; a pessoa confirma o novo e-mail assinando');
  await admin.reload();
  await a.button('Editar dados').click();
  await admin.getByLabel('Cargo ou função').filter({ visible: true }).fill('Reitora');
  await a.button('Salvar correção').click();
  await a.text(/Dados corrigidos/).waitFor();
  await a.text('alterado').hover();
  await a.text(/Alterado em \d{2}\/\d{2}\/\d{4}/).waitFor();
  check(await a.text('Reitora').isVisible(), 'cargo corrigido, com "alterado" e a data ao passar o mouse');
  await a.shot('dados-alterados');
  const newEmail = personEmail.replace('@', '.novo@');
  await a.button('Trocar e-mail').click();
  await admin.getByLabel('Novo e-mail institucional').filter({ visible: true }).fill(newEmail);
  await a.button('Enviar pedido de confirmação').click();
  await a.text(`Aguardando a pessoa confirmar o novo e-mail: ${newEmail}`).waitFor();
  check(true, 'o e-mail só troca depois da confirmação da pessoa');
  await holder.goto(newestMail(newEmail, /http:\/\/localhost:8081\/autorizacao\/email\?token=[\w-]+/));
  await h.text('Confirmação de troca de e-mail').waitFor();
  await holder.getByRole('tab', { name: 'Desenhar' }).filter({ visible: true }).click();
  check(await settledDisabled(h.button('Assinar e confirmar')), 'desenhando, sem traço não confirma');
  await draw(holder);
  await h.button('Assinar e confirmar').click();
  await h.text(/o e-mail da sua autorização agora é/).waitFor();
  await admin.reload();
  await a.text(newEmail).waitFor();
  check(true, 'a pessoa assinou e o cadastro passou para o novo e-mail');

  console.log('6. A pessoa pede para revogar; a administração envia o termo; ela assina: tudo some, a prova fica');
  await a.button('Enviar termo de revogação').click();
  await a.button('Enviar termo').click();
  await a.text(/Termo de revogação enviado em/).waitFor();
  check(true, 'o termo de revogação foi para o e-mail; nada é apagado antes da assinatura');
  const revokeLink = newestMail(newEmail, /http:\/\/localhost:8081\/autorizacao\/revogar\?token=[\w-]+/);
  await holder.goto(revokeLink);
  await h.text('Termo de revogação').waitFor();
  await holder.getByRole('tab', { name: 'Desenhar' }).filter({ visible: true }).click();
  check(await settledDisabled(h.button('Assinar e revogar')), 'revogar também exige assinatura');
  // The rubrica: initials typed in a handwriting font (the way of those who never sign the full name).
  await holder.getByRole('tab', { name: 'Rubrica' }).filter({ visible: true }).click();
  check(await holder.getByLabel('Iniciais da rubrica').filter({ visible: true }).inputValue() === 'MS', 'rubrica: as iniciais vêm do nome');
  await holder.getByRole('radio', { name: 'Estilo Clássica' }).click();
  await h.shot('rubrica');
  await h.button('Assinar e revogar').click();
  await h.text(/Autorização revogada/).waitFor();
  await h.shot('revogado');
  await admin.reload();
  await a.text(/Autorização revogada em/).waitFor();
  check(!(await admin.getByText('Fotografias de referência', { exact: true }).isVisible().catch(() => false))
        && !(await admin.evaluate(() => [...document.images].some((i) => i.src.includes('/photos/')))), 'fotos de referência eliminadas');
  check(await a.button('Baixar formulário (PDF)').isVisible(), 'o termo assinado continua disponível como prova');
  await photographer.goto(`${WEB}/pessoas-institucionais`);
  // With nobody else registered the page says so; with other (real) people, searching her name finds nobody.
  await search.fill('maria');   // the box is always there; fill waits for the page
  await p.text(/Ninguém encontrado com|Nenhuma pessoa autorizada ainda/).waitFor();
  check(true, 'quem revogou não pode mais ser consultado');

  check(problems.length === 0, `console sem erros${problems.length ? ': ' + problems.join(' | ') : ''}`);
  console.log('\nTUDO CERTO — cadastro, assinatura, busca no acervo, consulta, período, correção dos dados, troca de e-mail, PDF e revogação assinada.');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
