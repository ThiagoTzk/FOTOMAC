// 28/10/2026: the support page (the team writes, the administration answers — a conversation with statuses since
// 31/10/2026), the optional profile photo,
// the bell (newest first; its counter goes out once opened) and the browser tab named after the page.
//
//   node e2e/support.e2e.mjs <foto.jpg> [pasta-capturas]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const [PHOTO, SHOTS = 'e2e-screenshots/support'] = process.argv.slice(2);
if (!PHOTO) throw new Error('uso: node e2e/support.e2e.mjs <foto.jpg> [pasta-capturas]');
mkdirSync(SHOTS, { recursive: true });
const API = 'http://localhost:8000/api/v1';
const WEB = 'http://localhost:8081';
const BACKEND = fileURLToPath(new URL('../../backend/', import.meta.url));
const OUTBOX = join(BACKEND, 'outbox');
const PASSWORD = 'Fotomac#2026';
const stamp = Date.now();
const check = (ok, msg) => { if (!ok) throw new Error(`FALHOU: ${msg}`); console.log(`  ok  ${msg}`); };

function activationLink(email) {
  const files = readdirSync(OUTBOX).filter((f) => f.endsWith('.eml')).map((f) => join(OUTBOX, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (text.includes(`To: ${email}`)) return text.match(/http:\/\/localhost:8081\/primeiro-acesso\?token=[\w-]+/)[0];
  }
  throw new Error(`sem e-mail para ${email}`);
}

async function activate(page, name, role) {
  const email = `e2e.suporte.${role}.${stamp}@cesmac.edu.br`;
  const args = ['scripts/create_account.py', '--name', name, '--email', email, '--role', role];
  execFileSync(join(BACKEND, '.venv/bin/python'), role === 'admin' ? args : [...args, '--signature', name], { cwd: BACKEND });
  await page.goto(activationLink(email));
  await page.getByLabel('Nova senha', { exact: true }).filter({ visible: true }).fill(PASSWORD);
  await page.getByLabel('Confirmar nova senha', { exact: true }).filter({ visible: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Salvar nova senha', exact: true }).filter({ visible: true }).click();
  await page.getByRole('button', { name: /Continuar para o painel/ }).filter({ visible: true }).click();
  await page.getByText('Visão geral').filter({ visible: true }).first().waitFor();
}

const browser = await chromium.launch();
try {
  const photographer = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const admin = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
  const title = async (page, expected) => {
    await page.waitForFunction((t) => document.title === t, expected, { timeout: 10000 });
    check(true, `aba do navegador: "${expected}"`);
  };

  console.log('1. Contas ativadas; a aba do navegador tem o nome da página');
  await activate(photographer, 'Fotógrafa Suporte', 'photographer');
  await activate(admin, 'Admin Suporte', 'admin');
  await title(admin, 'FOTOMAC - Painel');
  const icon = await admin.evaluate(() => document.querySelector('link[rel~="icon"]')?.getAttribute('href'));
  const iconFile = await admin.request.get(new URL(icon ?? '/favicon.ico', WEB).href);
  check(iconFile.ok() && (await iconFile.body()).length > 1000, 'o ícone da aba é a câmera do FOTOMAC (não o padrão do Expo)');

  console.log('2. Foto de perfil, opcional, no lugar das iniciais');
  await photographer.goto(`${WEB}/perfil`);
  await title(photographer, 'FOTOMAC - Meu perfil');
  check(await photographer.getByText('FS', { exact: true }).first().isVisible(), 'sem foto, ficam as iniciais');
  const chooser = photographer.waitForEvent('filechooser');
  await photographer.getByRole('button', { name: 'Enviar foto' }).click();
  await (await chooser).setFiles(PHOTO);
  await photographer.getByRole('button', { name: 'Trocar foto' }).waitFor({ timeout: 15000 });
  const photos = photographer.locator('img[src*="/auth/me/photo"]');
  await photos.first().waitFor({ timeout: 10000 });
  check(await photos.count() >= 2, 'a foto aparece no perfil e no topo do painel');
  await shot(photographer, '01-perfil-com-foto');
  // 30/10/2026: the role is plain text (it cannot be changed here), not a field that waits for typing.
  check(await photographer.getByRole('textbox', { name: 'Perfil' }).count() === 0
        && await photographer.getByText('Fotógrafo', { exact: true }).filter({ visible: true }).count() > 0,
        '"Perfil" é texto fixo, não um campo');

  console.log('2b. Na lista de contas, o administrador vê a foto de quem tem; os outros ficam com as iniciais');
  await admin.goto(`${WEB}/contas`);
  await admin.getByText('Fotógrafa Suporte').filter({ visible: true }).first().waitFor();
  const listed = admin.locator('img[src*="/admin/accounts/"][src*="/photo"]');
  await listed.first().waitFor({ timeout: 10000 });
  check(await listed.count() >= 1, 'a foto da fotógrafa aparece na lista');
  check(await admin.getByText('AS', { exact: true }).filter({ visible: true }).count() > 0, 'quem não tem foto mostra as iniciais');
  check((await photographer.request.get(new URL(await listed.first().getAttribute('src')).href)).status() === 403,
        'só o administrador abre a foto de outra conta');
  await shot(admin, '01b-contas-com-foto');

  console.log('3. A fotógrafa escreve para o suporte');
  await photographer.getByRole('link', { name: 'Suporte' }).filter({ visible: true }).first().click();
  await title(photographer, 'FOTOMAC - Suporte');
  // 01/11/2026: the page opens on "Nova mensagem", the first tab, before "Mensagens (n)".
  await photographer.getByRole('tab', { name: 'Nova mensagem' }).waitFor();
  check(await photographer.getByRole('tab', { name: 'Nova mensagem' }).getAttribute('aria-selected') === 'true',
        'o Suporte abre em "Nova mensagem"');
  const tabNames = await photographer.getByRole('tab').filter({ visible: true }).allInnerTexts();
  check(tabNames[0]?.startsWith('Nova mensagem') && /^Mensagens \(0\)/.test(tabNames[1] ?? ''),
        '"Nova mensagem" vem à esquerda de "Mensagens (0)"');
  await photographer.getByRole('button', { name: 'Enviar', exact: true }).click();
  await photographer.getByText('Escreva o assunto.').waitFor();
  check(true, 'sem assunto, o envio explica o que falta');
  await photographer.getByLabel('Assunto').fill('Envio de fotos para no meio');
  await photographer.getByLabel('Mensagem').fill('No evento de teste, ao enviar 300 fotos, a barra parou em 90%.');
  await photographer.getByLabel('Onde aconteceu').fill('Eventos › Enviar imagens');
  await photographer.getByRole('button', { name: 'Enviar', exact: true }).click();
  await photographer.getByText(/Mensagem enviada/).waitFor();
  await photographer.getByText('Aberta', { exact: true }).waitFor();
  await photographer.getByRole('tab', { name: /^Mensagens \(1\)/ }).waitFor();
  check(await photographer.getByRole('tab', { name: /^Mensagens \(1\)/ }).getAttribute('aria-selected') === 'true',
        'depois de enviar, a página passa para a divisão "Mensagens", com a conversa aberta');
  check(await photographer.getByRole('tab', { name: 'Nova mensagem' }).isVisible(), 'o formulário fica na divisão "Nova mensagem"');
  await shot(photographer, '02-suporte-equipe');

  console.log('4. O sino do administrador: mais nova primeiro, e o número some ao abrir');
  await admin.reload();
  const bell = admin.getByRole('button', { name: /^Notificações/ }).filter({ visible: true }).first();
  await admin.waitForFunction(() => /Notificações: \d+ nova/.test(
    [...document.querySelectorAll('[aria-label^="Notificações"]')].map((e) => e.getAttribute('aria-label')).join(' ')), null, { timeout: 15000 });
  check(true, `o sino mostra novidades (${await bell.getAttribute('aria-label')})`);
  await bell.click();
  const first = admin.getByRole('menuitem').first();
  await first.waitFor();
  check((await first.innerText()).includes('Suporte: nova mensagem de Fotógrafa'), 'o aviso mais novo vem primeiro');
  await shot(admin, '03-sino-aberto');
  await admin.waitForFunction(() => [...document.querySelectorAll('[aria-label^="Notificações"]')]
    .every((e) => e.getAttribute('aria-label') === 'Notificações'), null, { timeout: 10000 });
  check(true, 'ao abrir o sino, o número some');
  // 08/11/2026: clicking outside closes the bell; each notice can be dismissed; the overview keeps it.
  await admin.mouse.click(600, 400);
  await admin.getByRole('menuitem').first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined);
  check(await admin.getByRole('menuitem').count() === 0, 'clicando fora, o sino fecha');
  await bell.click();
  const dismiss = admin.getByRole('button', { name: /^Dispensar o aviso: Suporte: nova mensagem de Fotógrafa/ }).first();
  await dismiss.waitFor();
  await dismiss.click();
  await admin.waitForFunction(() => ![...document.querySelectorAll('[role="menuitem"]')]
    .some((e) => e.textContent.includes('Suporte: nova mensagem de Fotógrafa')), null, { timeout: 10000 });
  check(true, 'o X dispensa o aviso: ele sai do sino');
  check(await admin.getByText(/aviso(s)? dispensado(s)? continua/).filter({ visible: true }).count() === 1,
        'o sino diz que o aviso dispensado continua na Visão geral');
  await admin.keyboard.press('Escape');
  await admin.goto(`${WEB}/painel`);
  await admin.getByText(/Suporte: nova mensagem de Fotógrafa/).filter({ visible: true }).first().waitFor({ timeout: 10000 });
  check(true, 'a Visão geral continua mostrando o aviso dispensado');
  await shot(admin, '03b-sino-dispensado');
  await admin.reload();
  await admin.getByText('Visão geral').filter({ visible: true }).first().waitFor();
  await admin.waitForTimeout(1500);
  check(await admin.getByRole('button', { name: 'Notificações', exact: true }).filter({ visible: true }).count() === 1,
        'recarregando, o número continua apagado (visto fica guardado no servidor)');

  console.log('5. Uma conversa: o administrador muda a situação e escreve; quem enviou responde (31/10/2026)');
  const conversation = (page) => page.getByRole('button', { name: /conversa: Envio de fotos para no meio/ }).first();
  await admin.goto(`${WEB}/suporte`);
  await conversation(admin).waitFor();
  check(await admin.getByText(/Fotógrafa Suporte · Fotógrafo/).first().isVisible(), 'aparece quem mandou (nome, perfil e e-mail)');
  check(await admin.getByText('Uso restrito').isVisible(), 'o aviso de uso restrito fica no topo da página');
  await conversation(admin).click();
  const adminBox = admin.getByLabel('Mensagem na conversa Envio de fotos para no meio');
  await adminBox.fill('Em qual navegador aconteceu?');
  await admin.getByRole('button', { name: 'Situação de Envio de fotos para no meio' }).click();
  // 31/10/2026: the list of statuses opened behind the block below it. Nothing may cover any option.
  const covered = await admin.getByRole('menuitem').evaluateAll((items) => items.filter((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !(top && el.contains(top));
  }).length);
  check(covered === 0, 'a lista de situações abre por cima de tudo, nenhuma opção coberta');
  await admin.getByRole('menuitem', { name: 'Em análise' }).click();
  await admin.getByRole('button', { name: 'Mudar situação' }).click();
  await admin.getByText(/Você mudou a situação para “Em análise”/).waitFor();
  check(true, 'situação “Em análise”, registrada na conversa');
  const sentBubbles = await admin.locator('div[dir="auto"]').getByText('Em qual navegador aconteceu?', { exact: true }).count();
  const stillTyped = await adminBox.inputValue();
  console.log(`    (balões com o texto: ${sentBubbles}; caixa: "${stillTyped}")`);
  check(sentBubbles === 0 && stillTyped === 'Em qual navegador aconteceu?', 'mudar a situação não envia o texto que está sendo escrito');
  await admin.getByRole('button', { name: 'Enviar mensagem' }).click();
  await admin.getByText('Em qual navegador aconteceu?').waitFor();
  check(true, 'mensagem enviada antes de resolver');

  console.log('6. Quem enviou recebe o aviso, abre a conversa e responde');
  await photographer.reload();
  const pBell = photographer.getByRole('button', { name: /^Notificações/ }).filter({ visible: true }).first();
  await pBell.click();
  await photographer.getByText('Suporte: a administração respondeu').click();
  await photographer.getByText('Em qual navegador aconteceu?').waitFor();
  check(new URL(photographer.url()).searchParams.get('conversa'), 'o aviso abre a conversa certa');
  check(await photographer.getByText('Em análise', { exact: true }).first().isVisible(), 'a situação aparece para quem enviou');
  await photographer.getByLabel('Mensagem na conversa Envio de fotos para no meio').fill('No Chrome, no Mac.');
  await photographer.getByRole('button', { name: 'Enviar mensagem' }).click();
  await photographer.getByText('No Chrome, no Mac.').waitFor();
  await shot(photographer, '03b-conversa-equipe');

  console.log('7. O administrador vê a resposta e resolve, com uma observação');
  await admin.reload();
  await conversation(admin).click();
  await admin.getByText('No Chrome, no Mac.').waitFor();
  check(true, 'a resposta chegou ao administrador');
  await admin.getByLabel('Mensagem na conversa Envio de fotos para no meio').fill('Corrigido: os arquivos excedentes aguardam a vez.');
  await admin.getByRole('button', { name: 'Enviar mensagem' }).click();
  await admin.getByText('Corrigido: os arquivos excedentes aguardam a vez.').waitFor();
  await admin.getByRole('button', { name: 'Situação de Envio de fotos para no meio' }).click();
  await admin.getByRole('menuitem', { name: 'Resolvida' }).click();
  await admin.getByRole('button', { name: 'Mudar situação' }).click();
  // (Real conversations of the development database may stay in "Em andamento": only ours must leave.)
  await conversation(admin).waitFor({ state: 'detached' });
  await admin.getByRole('tab', { name: 'Resolvidas' }).click();
  await conversation(admin).click();
  await admin.getByText('Corrigido: os arquivos excedentes aguardam a vez.').waitFor();
  check(true, 'resolvida, com a observação, na aba "Resolvidas"');
  await shot(admin, '04-suporte-admin');
  await photographer.goto(`${WEB}/suporte`);   // without ?conversa=… (that address opens it already)
  await photographer.getByRole('tab', { name: /^Mensagens \(1\)/ }).click();
  await conversation(photographer).click();
  await photographer.getByText(/Conversa resolvida e encerrada/).waitFor();
  check(true, 'para quem enviou, a conversa resolvida fica encerrada');

  console.log('8. Um evento dá nome à aba');
  const found = await (await admin.request.get(`${API}/events?scope=all`)).json();
  if (found.items?.length) {
    const ev = found.items[0];
    await admin.goto(`${WEB}/eventos/${ev.id}`);
    await title(admin, `FOTOMAC - ${ev.name}`);
    await admin.goto(`${WEB}/eventos/${ev.id}/imagens`);
    await title(admin, `FOTOMAC - ${ev.name} · Imagens`);
  } else {
    console.log('  (sem eventos no banco: passo pulado)');
  }

  console.log('\nTUDO CERTO — suporte, foto de perfil, sino e nome da aba.');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
