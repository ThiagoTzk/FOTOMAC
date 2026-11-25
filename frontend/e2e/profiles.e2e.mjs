// 05/11/2026: "certifique-se que TODAS as funções estão funcionando para todas as contas". He tests as
// administrator; here every profile opens the same screens of the latest functions, in a real browser:
//   - Imagens: "Selecionar todas" and "Borrar rostos nas selecionadas", with what each profile may blur;
//   - the bar of actions fits the screen (with "Selecionar todas" the last button was cut);
//   - the corner of videos: a collaborator does not publish, so it is never told "Falta publicar";
//   - a video of the hired photographer reaches the administrator (bell, event page, Vídeos tab on the filter).
//
//   node e2e/profiles.e2e.mjs <fotos> [pasta-capturas]
//
// fotos: grupo.jpg, grupo2.jpg, paisagem.jpg, sem-rosto-1.jpg and capa.jpg.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const [PHOTOS, SHOTS = 'e2e-screenshots/profiles'] = process.argv.slice(2);
if (!PHOTOS) throw new Error('uso: node e2e/profiles.e2e.mjs <fotos> [pasta-capturas]');
mkdirSync(SHOTS, { recursive: true });
const API = 'http://localhost:8000/api/v1';
const WEB = 'http://localhost:8081';
const BACKEND = fileURLToPath(new URL('../../backend/', import.meta.url));
const OUTBOX = join(BACKEND, 'outbox');
const PASSWORD = 'Fotomac#2026';
const CPF = '529.982.247-25';   // valid check digits, not of a real person
const stamp = Date.now();
const check = (ok, msg) => { if (!ok) throw new Error(`FALHOU: ${msg}`); console.log(`  ok  ${msg}`); };
const photo = (name) => readFileSync(join(PHOTOS, name));
const problems = [];

// Two different short videos (one per sender: the same file twice in one event is a duplicate).
const base = ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=640x360:rate=15', '-pix_fmt', 'yuv420p', '-c:v', 'libx264'];
const clipA = resolve(SHOTS, 'colaborador.mp4'), clipB = resolve(SHOTS, 'contratado.mp4');
execFileSync('ffmpeg', [...base, clipA]);
execFileSync('ffmpeg', [...base, '-vf', 'negate', clipB]);

function token(email) {
  const files = readdirSync(OUTBOX).filter((f) => f.endsWith('.eml')).map((f) => join(OUTBOX, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const f of files) { const m = readFileSync(f, 'utf8'); if (m.includes(`To: ${email}`)) return m.match(/primeiro-acesso\?token=([\w-]+)/)[1]; }
  throw new Error(`sem link para ${email}`);
}

const browser = await chromium.launch();
const pages = [];
async function page() {
  const p = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  p.on('pageerror', (e) => problems.push(e.message));
  pages.push(p);
  return p;
}
async function person(name, role) {
  const email = `e2e.perfis.${name.split(' ')[0].toLowerCase()}.${stamp}@cesmac.edu.br`;
  const args = ['scripts/create_account.py', '--name', name, '--email', email, '--role', role];
  if (role !== 'admin') args.push('--signature', name);
  execFileSync(join(BACKEND, '.venv/bin/python'), args, { cwd: BACKEND });
  const p = await page();
  const ok = await p.request.post(`${API}/auth/first-access`, { data: { token: token(email), password: PASSWORD, password_confirmation: PASSWORD } });
  check(ok.ok(), `${name} (${role}) ativado`);
  return p;
}
const visible = (loc) => loc.filter({ visible: true });
const button = (p, name) => visible(p.getByRole('button', { name, exact: true })).first();
const upload = async (p, eventId, name, bytes) => {
  const r = await p.request.post(`${API}/events/${eventId}/images`, { multipart: { file: { name, mimeType: 'image/jpeg', buffer: bytes } } });
  check(r.status() === 201, `foto ${name} enviada`);
};

/** Opens Imagens, "Selecionar" > "Selecionar todas" and returns what the bar offers; checks the bar fits the screen. */
async function selectAll(p, eventId, who, total, blurrable) {
  await p.goto(`${WEB}/eventos/${eventId}/imagens`, { waitUntil: 'networkidle' });
  await button(p, 'Selecionar').click();
  await button(p, `Selecionar todas (${total})`).click();
  await visible(p.getByText(`${total} ${total === 1 ? 'selecionada' : 'selecionadas'}`)).waitFor();
  const blur = visible(p.getByRole('button', { name: /^Borrar rostos nas selecionadas/ }));
  if (blurrable) {
    check(await button(p, `Borrar rostos nas selecionadas (${blurrable})`).isVisible(), `${who}: "Selecionar todas" marca ${total} e pode borrar ${blurrable}`);
  } else {
    check(await blur.count() === 0, `${who}: "Selecionar todas" marca ${total}; sem "Borrar rostos" (o contratado envia uma nova versão)`);
  }
  const width = p.viewportSize().width;
  const edges = await visible(p.getByRole('button')).evaluateAll((all) => all.map((b) => b.getBoundingClientRect().right));
  check(Math.max(...edges) <= width + 1, `${who}: nenhum botão passa da borda da tela`);
  await p.screenshot({ path: join(SHOTS, `imagens-${who.replace(/\W+/g, '-')}.png`) });
  await button(p, 'Desmarcar todas').click();
  await visible(p.getByText('0 selecionadas')).waitFor();
}

try {
  console.log('1. As contas e o evento com colaboração aberta');
  const owner = await person('Olga Responsavel', 'photographer');
  const admin = await person('Adao Administrador', 'admin');
  const collab = await person('Caio Colaborador', 'photographer');
  const mkt = await person('Mara Marketing', 'marketing');
  const theme = (await (await owner.request.get(`${API}/themes`)).json())[0];
  const ev = await (await owner.request.post(`${API}/events`, { multipart: {
    name: `Perfis E2E ${stamp}`, theme_ids: String(theme.id), date_precision: 'day', date_start: '2030-12-20',
    location: 'Campus I', description: 'Evento do teste automatizado.', cover: { name: 'capa.jpg', mimeType: 'image/jpeg', buffer: photo('capa.jpg') } } })).json();
  check((await owner.request.put(`${API}/events/${ev.id}/collaboration`, { data: { open: true } })).ok(), 'colaboração aberta');
  const acc = await admin.request.post(`${API}/admin/accounts`, { data: {
    full_name: 'Teo Contratado', email: `e2e.perfis.contractor.${stamp}@cesmac.edu.br`, role: 'contractor', photographer_signature: 'Teo C.',
    bound_event_id: ev.id, contract_number: 'CT-2026/077' } });
  check(acc.status() === 201, 'conta temporária criada pelo administrador');
  const hired = await page();
  const first = await hired.request.post(`${API}/auth/first-access`, { data: { token: token(`e2e.perfis.contractor.${stamp}@cesmac.edu.br`),
    password: PASSWORD, password_confirmation: PASSWORD, cpf: CPF, birth_date: '1990-05-20' } });
  check(first.ok(), 'contratado ativado com CPF');

  console.log('2. Cada perfil envia uma foto');
  await upload(owner, ev.id, 'grupo.jpg', photo('grupo.jpg'));
  await upload(collab, ev.id, 'grupo2.jpg', photo('grupo2.jpg'));
  await upload(mkt, ev.id, 'paisagem.jpg', photo('paisagem.jpg'));
  await upload(hired, ev.id, 'sem-rosto-1.jpg', photo('sem-rosto-1.jpg'));

  console.log('3. Imagens: "Selecionar todas" e "Borrar rostos" em cada perfil');
  // The responsible and the administrator manage the 4; a collaborator, its own; the hired photographer sees only its own
  // photo and never blurs (it sends a new version).
  await selectAll(owner, ev.id, 'responsável', 4, 4);
  await selectAll(admin, ev.id, 'administrador', 4, 4);
  const seenByCollab = (await (await collab.request.get(`${API}/events/${ev.id}/images`)).json()).items.length;
  await selectAll(collab, ev.id, 'colaborador', seenByCollab, 1);
  const seenByMkt = (await (await mkt.request.get(`${API}/events/${ev.id}/images`)).json()).items.length;
  await selectAll(mkt, ev.id, 'marketing', seenByMkt, 1);
  await selectAll(hired, ev.id, 'contratado', 1, 0);

  console.log('4. O colaborador envia um vídeo: o quadro não manda ele publicar');
  await collab.goto(`${WEB}/eventos/${ev.id}/videos`, { waitUntil: 'networkidle' });
  await collab.locator('input[type=file]').first().setInputFiles(clipA);
  await visible(collab.getByText(/Pronto\. Quem publica é o responsável pelo evento|pronto\. Quem publica é o responsável pelo evento/)).first().waitFor({ timeout: 120000 });
  check(await visible(collab.getByText(/Falta publicar/)).count() === 0 && await visible(collab.getByText(/^Publicar em Vídeos/)).count() === 0,
        'colaborador: "Quem publica é o responsável pelo evento", sem "Falta publicar"');
  await collab.screenshot({ path: join(SHOTS, 'quadro-colaborador.png') });
  const ownerBell = (await (await owner.request.get(`${API}/notifications`)).json()).items;
  check(ownerBell.some((n) => n.kind === 'videos_ready' && n.href === `/eventos/${ev.id}/videos`), 'o responsável é avisado de que há vídeo pronto para publicar');

  console.log('5. O contratado envia um vídeo: chega ao administrador');
  // The administrator's overview counts the whole system: compare before and after.
  const totalBefore = (await (await admin.request.get(`${API}/dashboard`)).json()).approvals_total;
  await hired.goto(`${WEB}/eventos/${ev.id}/videos`, { waitUntil: 'networkidle' });
  await hired.locator('input[type=file]').first().setInputFiles(clipB);
  // Everything waiting for the administrator, the corner closes to its summary line.
  await visible(hired.getByText(/Pronto\. Aguarda a aprovação|pronto, aguarda a aprovação da administração/)).first().waitFor({ timeout: 120000 });
  check(await visible(hired.getByText(/Falta publicar/)).count() === 0, 'contratado: o quadro diz que aguarda a aprovação, sem "Falta publicar"');
  await hired.screenshot({ path: join(SHOTS, 'quadro-contratado.png') });
  const hiredBell = (await (await hired.request.get(`${API}/notifications`)).json()).items;
  check(hiredBell.some((n) => n.kind === 'own_pending' && /vídeo aguarda aprovação/.test(n.title)), 'o sino do contratado diz que o vídeo aguarda aprovação');
  const adminBell = (await (await admin.request.get(`${API}/notifications`)).json()).items;
  const notice = adminBell.find((n) => n.kind === 'video_approval');
  check(notice && notice.href === `/eventos/${ev.id}/videos?filtro=pending_approval`, 'o sino do administrador avisa o vídeo a aprovar');
  check((await (await admin.request.get(`${API}/dashboard`)).json()).approvals_total === totalBefore + 1, 'Visão geral: "Aguardando aprovação" passa a contar o vídeo também');
  await admin.goto(`${WEB}/eventos/${ev.id}`, { waitUntil: 'networkidle' });
  await visible(admin.getByText('1 vídeo aguarda a sua aprovação')).waitFor();
  await admin.screenshot({ path: join(SHOTS, 'evento-administrador.png') });
  await visible(admin.getByText('1 vídeo aguarda a sua aprovação').locator('xpath=ancestor::*[.//*[@role="button"]][1]')
    .getByRole('button', { name: 'Revisar' })).first().click();
  await admin.waitForURL(/\/videos\?filtro=pending_approval/);
  await visible(admin.getByText('Aguardando aprovação · 1')).waitFor();
  await button(admin, 'Aprovar').waitFor();
  check(true, 'no evento, "Revisar" abre Vídeos já no filtro do vídeo a aprovar, com o botão Aprovar');
  await admin.screenshot({ path: join(SHOTS, 'videos-administrador.png') });
  await button(admin, 'Aprovar').click();
  for (let i = 0; i < 20 && (await (await admin.request.get(`${API}/notifications`)).json()).items.some((n) => n.kind === 'video_approval'); i++) await admin.waitForTimeout(300);
  check(!(await (await admin.request.get(`${API}/notifications`)).json()).items.some((n) => n.kind === 'video_approval'), 'aprovado, o aviso some');

  check(problems.length === 0, `sem erros na página${problems.length ? `: ${problems.join(' | ')}` : ''}`);
  console.log('\nTUDO OK');
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
  for (const [n, p] of pages.entries()) await p.screenshot({ path: join(SHOTS, `falha-${n}.png`) }).catch(() => undefined);
} finally {
  await browser.close();
}
