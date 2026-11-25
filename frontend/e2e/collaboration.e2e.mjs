// 01/11/2026: every photographer finds every active event (ten per page, numbered pages), sees only the summary of
// the ones it does not work on, asks the responsible to collaborate (with an optional message and RAW), and each
// side is told on the bell; the responsible confirms before accepting and ticks RAW on purpose.
//
//   node e2e/collaboration.e2e.mjs <capa.jpg> [pasta-capturas]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const [COVER, SHOTS = 'e2e-screenshots/collaboration'] = process.argv.slice(2);
if (!COVER) throw new Error('uso: node e2e/collaboration.e2e.mjs <capa.jpg> [pasta-capturas]');
mkdirSync(SHOTS, { recursive: true });
const API = 'http://localhost:8000/api/v1';
const WEB = 'http://localhost:8081';
const BACKEND = fileURLToPath(new URL('../../backend/', import.meta.url));
const OUTBOX = join(BACKEND, 'outbox');
const PASSWORD = 'Fotomac#2026';
const stamp = Date.now();
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
  const email = `e2e.colab.${role}.${name.split(' ')[0].toLowerCase()}.${stamp}@cesmac.edu.br`;
  execFileSync(join(BACKEND, '.venv/bin/python'),
               ['scripts/create_account.py', '--name', name, '--email', email, '--role', role, '--signature', name], { cwd: BACKEND });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  const ok = await page.request.post(`${API}/auth/first-access`, { data: { token: token(email), password: PASSWORD, password_confirmation: PASSWORD } });
  check(ok.ok(), `${name} ativado`);
  return page;
}

const browser = await chromium.launch();
try {
  const shot = (page, n) => page.screenshot({ path: join(SHOTS, `${n}.png`), fullPage: true });
  const notices = async (page) => (await (await page.request.get(`${API}/notifications`)).json()).items;

  console.log('1. Bruno cria eventos; Rafael não trabalha em nenhum deles');
  const bruno = await person(browser, 'Bruno Rocha E2E', 'photographer');
  const rafael = await person(browser, 'Rafael Colaborador E2E', 'photographer');
  const themes = await (await bruno.request.get(`${API}/themes`)).json();
  const newEvent = async (name, day) => (await (await bruno.request.post(`${API}/events`, { multipart: {
    name, theme_ids: String(themes[0].id), date_precision: 'day', date_start: day, location: 'Campus I',
    description: 'Evento do teste automatizado.', cover: { name: 'capa.jpg', mimeType: 'image/jpeg', buffer: readFileSync(COVER) } } })).json());
  // 2033: a year no other suite uses, so an event left by an earlier suite of the same round is never newer (06/11/2026:
  // the second event of videos.e2e, 21/12/2030, came first).
  const ev = await newEvent(`Colaboração E2E ${stamp}`, '2033-12-20');   // the newest: first in the list
  for (let i = 1; i <= 10; i++) await newEvent(`Paginação E2E ${stamp} ${i}`, `2033-11-${String(i).padStart(2, '0')}`);
  check(ev.collaboration_open === false && ev.raw_enabled === false, 'colaboração e RAW desligados');

  console.log('2. Rafael encontra todos os eventos ativos, dez por página, do mais recente ao mais antigo');
  await rafael.goto(`${WEB}/eventos`);
  await rafael.getByRole('link', { name: `Abrir ${ev.name}` }).waitFor();
  check(await rafael.getByRole('link', { name: /^Abrir / }).count() === 10, 'dez eventos na página');
  check((await rafael.getByRole('link', { name: /^Abrir / }).first().getAttribute('aria-label')) === `Abrir ${ev.name}`,
        'o evento mais recente vem primeiro');
  check(await rafael.getByText('Responsável: Bruno Rocha E2E').first().isVisible(), 'diz de quem é o evento');
  const cover = rafael.locator(`img[src*="/events/${ev.id}/cover"]`).first();
  await rafael.waitForFunction((el) => el.complete && el.naturalWidth > 0, await cover.elementHandle(), { timeout: 15000 });
  check(true, 'a capa do evento de outro aparece na lista');
  await rafael.getByRole('button', { name: 'Página 2' }).click();
  await rafael.waitForFunction(() => document.querySelector('[aria-current="page"][aria-label="Página 2"]'));
  check(true, 'a página 2 fica marcada');
  await shot(rafael, '01-lista-pagina-2');
  await rafael.getByRole('button', { name: 'Página 1' }).click();
  await rafael.getByRole('button', { name: 'Quais eventos' }).click();
  await rafael.getByRole('menuitem', { name: 'Habilitados para mim' }).click();
  // (Events of the development database with the collaboration open may stay: those he may work on.)
  await rafael.getByRole('link', { name: `Abrir ${ev.name}` }).waitFor({ state: 'detached' });
  check(await rafael.getByText(/Paginação E2E/).count() === 0, '"Habilitados para mim" esconde os eventos em que ele não trabalha');

  console.log('3. No evento de outro, só o resumo; as imagens ficam fechadas');
  await rafael.goto(`${WEB}/eventos/${ev.id}`);
  await rafael.getByText('Você não trabalha neste evento').waitFor();
  check(await rafael.getByRole('tab').filter({ visible: true }).count() === 1, 'só a aba "Visão geral"');
  check((await rafael.request.get(`${API}/events/${ev.id}/images`)).status() === 404, 'o servidor recusa as imagens');
  await rafael.getByRole('button', { name: 'Pedir para colaborar' }).click();
  await rafael.getByText('Pedir a Bruno para colaborar?').waitFor();
  check(true, 'antes de enviar, pergunta se ele tem certeza');
  await rafael.getByRole('checkbox', { name: /Usar arquivos RAW/ }).click();
  await rafael.getByLabel('Mensagem para Bruno Rocha E2E').fill('Quero enviar 24 imagens deste evento.');
  await shot(rafael, '02-pedido');
  await rafael.getByRole('button', { name: 'Enviar pedido' }).click();
  await rafael.getByText(/Pedido enviado a Bruno Rocha E2E: enviar imagens e usar arquivos RAW/).waitFor();
  check(true, 'o pedido fica à espera, com a opção de cancelar');
  await rafael.getByRole('button', { name: 'Abrir conversa com Bruno Rocha E2E' }).click();
  await rafael.getByLabel('Mensagem na conversa com Bruno Rocha E2E').fill('Posso mandar ainda hoje?');
  await rafael.getByRole('button', { name: 'Enviar mensagem' }).click();
  await rafael.getByText('Posso mandar ainda hoje?', { exact: true }).waitFor();
  check(true, 'o chat do pedido envia a mensagem e ela fica na conversa');

  console.log('4. Bruno é avisado no sino e responde em Configuração');
  const asked = (await notices(bruno)).find((n) => n.kind === 'collab_request');
  check(asked && asked.title.includes('Rafael pediu para enviar imagens e usar arquivos RAW')
        && asked.description.includes('Quero enviar 24 imagens'), 'o sino de Bruno mostra o pedido e a mensagem');
  const chat = (await notices(bruno)).find((n) => n.kind === 'collab_chat');
  check(chat && chat.description.includes('Posso mandar ainda hoje?'), 'o sino de Bruno avisa a mensagem do chat');
  await bruno.goto(`${WEB}${chat.href}`);
  await bruno.getByText('Posso mandar ainda hoje?', { exact: true }).waitFor();
  check(true, 'o link do aviso abre a conversa');
  await bruno.getByLabel('Mensagem na conversa com Rafael Colaborador E2E').fill('Pode, sim. Vou aceitar agora.');
  await bruno.getByRole('button', { name: 'Enviar mensagem' }).click();
  await bruno.getByText('Pode, sim. Vou aceitar agora.', { exact: true }).waitFor();
  await shot(bruno, '03a-chat');
  check(!(await notices(bruno)).some((n) => n.kind === 'collab_chat'), 'conversa aberta: o aviso sai do sino');
  await bruno.goto(`${WEB}${asked.href}`);
  await bruno.getByText('Pedidos de colaboração (1)').waitFor();
  check(await bruno.getByRole('tab', { name: 'Configuração (1)' }).isVisible(), 'a aba Configuração conta o pedido');
  await bruno.getByRole('button', { name: 'Aceitar', exact: true }).click();
  await bruno.getByText('Aceitar o pedido de Rafael?').waitFor();
  const raw = bruno.getByRole('checkbox', { name: /Ligar "Aceitar arquivos RAW"/ });
  check(await raw.getAttribute('aria-checked') === 'false', 'ligar o RAW vem desmarcado: é escolha dele');
  await raw.click();
  await bruno.getByLabel('Mensagem para Rafael Colaborador E2E').fill('Aceitei, pode enviar.');
  await shot(bruno, '03-aceitar');
  await bruno.getByRole('button', { name: 'Aceitar pedido' }).click();
  await bruno.getByText('RESPONDIDOS (FICAM 90 DIAS DEPOIS DA ÚLTIMA MENSAGEM)').waitFor();
  await bruno.getByText('Rafael Colaborador E2E', { exact: true }).waitFor();
  check(true, 'Rafael entra em "Quem trabalha neste evento"');
  const after = await (await bruno.request.get(`${API}/events/${ev.id}`)).json();
  check(after.raw_enabled === true && after.requests_waiting === 0, 'RAW ligado e nenhum pedido pendente');

  console.log('5. Rafael é avisado da resposta e passa a trabalhar no evento');
  const answer = (await notices(rafael)).find((n) => n.kind === 'collab_answer');
  check(answer && answer.title.startsWith('Bruno Rocha E2E aceitou a sua participação')
        && answer.description.includes('Aceitei, pode enviar.'), 'o sino de Rafael mostra quem aceitou e a resposta');
  await rafael.goto(`${WEB}${answer.href}`);
  await rafael.getByText(/Bruno Rocha E2E aceitou o seu pedido/).waitFor();
  check(await rafael.getByRole('tab', { name: 'Imagens' }).isVisible(), 'a aba Imagens aparece');
  await rafael.getByText('Pode, sim. Vou aceitar agora.', { exact: true }).waitFor();   // opens by itself: news
  check(await rafael.getByText(/aceitou o pedido/).isVisible(), 'a conversa guarda o pedido, as mensagens e a resposta');
  await shot(rafael, '04-aceito');
  await rafael.waitForTimeout(800);
  check(!(await notices(rafael)).some((n) => n.kind === 'collab_answer'), 'aberto o evento, o aviso sai do sino');
  check((await (await rafael.request.get(`${API}/events/${ev.id}`)).json()).can_upload === true, 'pode enviar imagens');

  console.log('\nTUDO CERTO: pedido de colaboração, chat salvo, aviso nos dois lados, RAW por escolha e páginas numeradas.');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
