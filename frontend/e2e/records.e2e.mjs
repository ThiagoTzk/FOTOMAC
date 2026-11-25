// RF024 and RNF14 in the browser (11/11/2026): the administrator's "Registros" screen, the export of the records
// (ZIP with one CSV per kind of record) and how an atypical-use alert is shown. Also on a phone-sized screen.
//
//   node e2e/records.e2e.mjs [pasta-capturas]
//
// The alert is shown with a simulated answer of the summary: a real alert would stay in the append-only log of the
// development database (and in the bell) for good. The alert logic itself is proven in backend/tests/test_reports.py.
// Creates e2e.registros.* accounts; clean with backend/scripts/cleanup_e2e.py --apply (their audit entries go too).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const SHOTS = resolve(process.argv[2] ?? 'e2e-screenshots/registros');
mkdirSync(SHOTS, { recursive: true });
const API = 'http://localhost:8000/api/v1';
const WEB = 'http://localhost:8081';
const BACKEND = fileURLToPath(new URL('../../backend/', import.meta.url));
const OUTBOX = join(BACKEND, 'outbox');
const PASSWORD = 'Fotomac#2026';
const stamp = Date.now();
const check = (ok, msg) => { if (!ok) throw new Error(`FALHOU: ${msg}`); console.log(`  ok  ${msg}`); };
const problems = [];

function token(email) {
  const files = readdirSync(OUTBOX).filter((f) => f.endsWith('.eml')).map((f) => join(OUTBOX, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const f of files) { const m = readFileSync(f, 'utf8'); if (m.includes(`To: ${email}`)) return m.match(/primeiro-acesso\?token=([\w-]+)/)[1]; }
  throw new Error(`sem link para ${email}`);
}

const browser = await chromium.launch();
async function person(name, role, viewport = { width: 1440, height: 1000 }) {
  const email = `e2e.registros.${name.split(' ')[0].toLowerCase()}.${stamp}@cesmac.edu.br`;
  const args = ['scripts/create_account.py', '--name', name, '--email', email, '--role', role];
  if (role !== 'admin') args.push('--signature', name);
  execFileSync(join(BACKEND, '.venv/bin/python'), args, { cwd: BACKEND });
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const p = await context.newPage();
  p.on('pageerror', (e) => problems.push(e.message));
  const ok = await p.request.post(`${API}/auth/first-access`, { data: { token: token(email), password: PASSWORD, password_confirmation: PASSWORD } });
  check(ok.ok(), `${name} (${role}) ativado`);
  return p;
}
const visible = (loc) => loc.filter({ visible: true });

try {
  console.log('1. Administrador: Registros no menu e os números do período');
  const adao = await person('Adao Administrador', 'admin');
  await adao.goto(`${WEB}/painel`, { waitUntil: 'networkidle' });
  await visible(adao.getByRole('link', { name: 'Registros', exact: true })).click();
  await adao.waitForURL('**/registros');
  await visible(adao.getByText('Operações registradas', { exact: true })).waitFor();
  const summary = await (await adao.request.get(`${API}/admin/reports/summary`)).json();
  check(summary.operations > 0, `o resumo traz as operações do banco (${summary.operations} em todo o período)`);
  for (const label of ['Buscas públicas', 'Provas de vida reprovadas', 'Ciências registradas', 'Consultas institucionais',
                       'Autorizações institucionais', 'Downloads para divulgação']) {
    check(await visible(adao.getByText(label, { exact: true })).count() === 1, `cartão "${label}"`);
  }
  await adao.screenshot({ path: join(SHOTS, 'registros.png'), fullPage: true });

  console.log('2. Exportar: ZIP com uma planilha por tipo de registro');
  const [download] = await Promise.all([adao.waitForEvent('download'),
    visible(adao.getByRole('button', { name: 'Exportar relatório (ZIP)', exact: true })).click()]);
  const zip = join(SHOTS, 'registros.zip');
  await download.saveAs(zip);
  check(/^FOTOMAC - registros .*\.zip$/.test(download.suggestedFilename()), `nome do arquivo: ${download.suggestedFilename()}`);
  const listing = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n').sort();
  check(listing.join(',') === ['1-operacoes.csv', '2-consultas-institucionais.csv', '3-autorizacoes-institucionais.csv',
    '4-ciencia-dos-visitantes.csv', '5-downloads-para-divulgacao.csv', '6-consultas-publicas-por-dia.csv', '7-uso-atipico.csv',
    'LEIA-ME.txt'].join(','), 'as 7 planilhas e o LEIA-ME');
  const ops = execFileSync('unzip', ['-p', zip, '1-operacoes.csv'], { maxBuffer: 256 * 1024 * 1024 });
  check(ops[0] === 0xef && ops[1] === 0xbb && ops[2] === 0xbf, 'planilha com BOM (acentos certos no Excel)');
  check(ops.toString('utf8').includes('Data e hora;Quem;Perfil;Área'), 'cabeçalho em português, separado por ponto e vírgula');
  const readme = execFileSync('unzip', ['-p', zip, 'LEIA-ME.txt'], { encoding: 'utf8' });
  check(readme.includes('Adao Administrador') && readme.includes('nenhum arquivo traz dado pessoal de visitante'),
        'LEIA-ME diz quem gerou e o que não vai no relatório');
  const after = await (await adao.request.get(`${API}/admin/reports/summary`)).json();
  check(after.operations > summary.operations, 'a própria exportação ficou registrada');

  console.log('3. Alerta de uso atípico (resposta simulada): aviso no topo e linha na lista');
  await adao.route('**/api/v1/admin/reports/summary**', async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, alerts_total: 2, alerts: [
      { at: new Date().toISOString(), kind: 'liveness', label: 'Provas de vida reprovadas em sequência', count: 5, minutes: 30, event: 'Colação E2E' },
      { at: new Date().toISOString(), kind: 'searches', label: 'Buscas demais do mesmo endereço', count: 20, minutes: 10, event: null }] } });
  });
  await adao.reload({ waitUntil: 'networkidle' });
  await visible(adao.getByText('2 alertas de uso atípico no período', { exact: true })).waitFor();
  check(await visible(adao.getByText('5 reprovações seguidas em até 30 minutos · Colação E2E', { exact: true })).count() === 1,
        'linha do alerta de prova de vida com o evento');
  check(await visible(adao.getByText('Mais de 20 buscas em 10 minutos', { exact: true })).count() === 1, 'linha do alerta de buscas');
  const notice = await visible(adao.getByText('2 alertas de uso atípico no período')).boundingBox();
  const period = await visible(adao.getByText('Período', { exact: true })).boundingBox();
  check(notice.y < period.y, 'o aviso vem no topo, antes do período e dos números');
  await adao.screenshot({ path: join(SHOTS, 'registros-alerta.png'), fullPage: true });
  await adao.unroute('**/api/v1/admin/reports/summary**');

  console.log('4. Datas escolhidas: inválidas avisam e não exportam');
  await adao.reload({ waitUntil: 'networkidle' });
  await visible(adao.getByLabel('Período', { exact: true })).click();
  await visible(adao.getByText('Escolher as datas…', { exact: true })).click();
  await adao.getByLabel('Data inicial (dd/mm/aaaa)').fill('10112026');
  await adao.getByLabel('Data final (dd/mm/aaaa)').fill('01112026');
  await visible(adao.getByText(/Confira as datas/)).waitFor();
  check(await visible(adao.getByRole('button', { name: 'Exportar relatório (ZIP)' })).isDisabled(), 'final antes da inicial: exportar desligado');

  console.log('5. Fotógrafo não vê nem acessa');
  const olga = await person('Olga Fotografa', 'photographer');
  await olga.goto(`${WEB}/painel`, { waitUntil: 'networkidle' });
  check(await visible(olga.getByRole('link', { name: 'Registros', exact: true })).count() === 0, 'sem "Registros" no menu do fotógrafo');
  check((await olga.request.get(`${API}/admin/reports/export.zip`)).status() === 403, 'exportação recusada pelo servidor (403)');

  console.log('6. Celular (390 px)');
  const phone = await person('Paula Celular', 'admin', { width: 390, height: 844 });
  await phone.goto(`${WEB}/registros`, { waitUntil: 'networkidle' });
  await visible(phone.getByText('Operações registradas', { exact: true })).waitFor();
  const right = await phone.evaluate(() => Math.max(...[...document.querySelectorAll('body *')]
    .filter((el) => el.getClientRects().length).map((el) => el.getBoundingClientRect().right)));
  check(right <= 391, `nada passa da borda da tela (maior borda direita: ${Math.round(right)} px)`);
  await phone.screenshot({ path: join(SHOTS, 'registros-celular.png'), fullPage: true });

  check(problems.length === 0, `console sem erros${problems.length ? `: ${problems.join(' | ')}` : ''}`);
  console.log('\nTUDO CERTO: Registros, exportação e alertas.');
} finally {
  await browser.close();
}
