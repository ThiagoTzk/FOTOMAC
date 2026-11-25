import { useLocalSearchParams } from 'expo-router';
import {
  Camera, ChevronDown, ChevronUp, CircleCheck, Handshake, MessageSquare, MessagesSquare, Send, Square, SquareCheck, TriangleAlert, X,
} from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState, type ReactNode, type ComponentRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import {
  askCollaboration, cancelCollaborationRequest, decideCollaborationRequest, getCollaborationChat, getEvent,
  listCollaborationRequests, markCollaborationAnswerSeen, markCollaborationChatRead, writeCollaborationChat,
  type Chat, type CollaborationRequest, type EventItem,
} from '@/api/events';
import { formatDateTime } from '@/api/images';
import { Modal } from '@/components/panel/Modal';
import { Button, Card, Field, Input, Notice, Pill, SectionTitle } from '@/components/panel/ui';
import { fonts, panel } from '@/theme/tokens';

const MAX = 500;
const CHAT_MAX = 1000;
const POLL_MS = 10_000;   // an open conversation looks for new messages, like a chat
const first = (name: string) => name.split(' ')[0];

/** What was asked, in words: "enviar imagens", "aceitar arquivos RAW" or both. */
function asked(r: { wants_upload: boolean; wants_raw: boolean }) {
  return r.wants_upload && r.wants_raw ? 'enviar imagens e usar arquivos RAW' : r.wants_upload ? 'enviar imagens' : 'aceitar arquivos RAW';
}

function Check({ label, help, value, onChange }: { label: string; help?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: value }} aria-checked={value} accessibilityLabel={label}
               onPress={() => onChange(!value)} style={styles.check}>
      {value ? <SquareCheck size={22} color={panel.primary} strokeWidth={1.8} absoluteStrokeWidth />
        : <Square size={22} color={panel.muted} strokeWidth={1.8} absoluteStrokeWidth />}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.name}>{label}</Text>
        {help && <Text style={styles.text}>{help}</Text>}
      </View>
    </Pressable>
  );
}

/**
 * The conversation inside a request (01/11/2026: "um chat de verdade para ficar salvo o que foi
 * conversado"): the request, the answer and every message in order, mine on the right. While it is on the screen it
 * looks for new messages every few seconds and counts as read (the bell stops telling about it).
 */
function ChatThread({ eventId, requestId, other }: { eventId: string; requestId: string; other: string }) {
  const [chat, setChat] = useState<Chat | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<ComponentRef<typeof ScrollView>>(null);

  const load = useCallback(() => getCollaborationChat(eventId, requestId).then(setChat).catch(() => undefined), [eventId, requestId]);
  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  const count = chat?.items.length ?? 0;
  useEffect(() => { if (count) markCollaborationChatRead(eventId, requestId).catch(() => undefined); }, [count, eventId, requestId]);

  async function send() {
    setError(null);
    if (!text.trim()) return setError('Escreva a mensagem.');
    setBusy(true);
    try {
      setChat(await writeCollaborationChat(eventId, requestId, text.trim()));
      setText('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível enviar. Tente novamente.');
    } finally { setBusy(false); }
  }

  if (!chat) return <Text style={styles.text}>Carregando a conversa...</Text>;
  return (
    <View style={{ gap: 10 }}>
      <ScrollView ref={box} style={styles.thread} contentContainerStyle={{ gap: 10, padding: 12 }}
                  onContentSizeChange={() => box.current?.scrollToEnd({ animated: false })}>
        <View role="list" style={{ gap: 10 }}>
          {chat.items.map((i, n) => (
            <View key={n} role="listitem" style={[styles.bubble, i.mine ? styles.mine : styles.theirs]}>
              <Text style={styles.who}>{i.author_name}{i.note ? ` ${i.note}` : ''} · {formatDateTime(i.created_at)}</Text>
              {i.text && <Text style={styles.body}>{i.text}</Text>}
            </View>
          ))}
        </View>
      </ScrollView>
      {error && <Notice tone="danger" icon={TriangleAlert} title={error} />}
      {chat.closed ? <Text style={styles.text}>{chat.closed}</Text> : (
        <>
          <Field label={`Mensagem para ${other}`}
                 help={`${first(other)} recebe um aviso no sino. A conversa fica salva neste pedido e só vocês dois a veem (a administração só entra se a conta do responsável deixar de estar ativa).`}>
            <Input multiline value={text} onChangeText={setText} maxLength={CHAT_MAX} accessibilityLabel={`Mensagem na conversa com ${other}`} />
          </Field>
          <View style={styles.actions}>
            <Button icon={Send} label="Enviar mensagem" loading={busy} onPress={send} />
          </View>
        </>
      )}
    </View>
  );
}

/** "Conversa com X": closed it shows how many messages and whether there is something new; open, the thread. */
function ChatToggle({ eventId, r, other, startOpen }: { eventId: string; r: CollaborationRequest; other: string; startOpen: boolean }) {
  // What the person clicked wins; until then, open when a notice of the bell pointed here (or something is new).
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? startOpen;
  const count = r.messages ? `${r.messages} ${r.messages === 1 ? 'mensagem' : 'mensagens'}` : 'nenhuma mensagem ainda';
  return (
    <View style={{ gap: 10, alignSelf: 'stretch' }}>
      <Pressable accessibilityRole="button" aria-expanded={open} accessibilityLabel={`${open ? 'Fechar' : 'Abrir'} conversa com ${other}`}
                 onPress={() => setChosen(!open)} style={styles.toggle}>
        <MessagesSquare size={16} color={panel.primary} strokeWidth={1.8} absoluteStrokeWidth />
        <Text style={styles.toggleText}>Conversa com {other} ({count})</Text>
        {r.unread && !open && <Pill label="Nova mensagem" bg={panel.danger} fg="#FFFFFF" />}
        {open ? <ChevronUp size={16} color={panel.primary} strokeWidth={1.8} absoluteStrokeWidth />
          : <ChevronDown size={16} color={panel.primary} strokeWidth={1.8} absoluteStrokeWidth />}
      </Pressable>
      {open && <ChatThread eventId={eventId} requestId={r.id} other={other} />}
    </View>
  );
}

/**
 * The requester's side, on top of the event (01/11/2026): ask the responsible to send photos and/or to
 * accept RAW files, with an optional message, after a confirmation; then the request waiting (it can be cancelled)
 * or the answer, with the reply. Opening the event with an answer not read yet clears its notice in the bell.
 */
export function AskCollaboration({ event, onEvent }: { event: EventItem; onEvent: (e: EventItem) => void }) {
  const [open, setOpen] = useState(false);
  const [upload, setUpload] = useState(event.ask_upload);
  const [raw, setRaw] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = event.my_request;
  const owner = event.owner.full_name;
  const { conversa } = useLocalSearchParams<{ conversa?: string }>();   // the link of a notice on the bell

  useEffect(() => {
    if (r && r.status !== 'pending' && !r.seen) markCollaborationAnswerSeen(event.id, r.id).catch(() => undefined);
  }, [event.id, r]);

  async function run(action: () => Promise<EventItem>) {
    setBusy(true); setError(null);
    try { onEvent(await action()); setOpen(false); setMessage(''); } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível enviar. Tente novamente.');
    } finally { setBusy(false); }
  }

  const blocks: ReactNode[] = [];
  if (r?.status === 'pending') {
    blocks.push(
      <Notice key="pending" tone="info" icon={Send} title={`Pedido enviado a ${owner}: ${asked(r)}`}
              description={`Enviado em ${formatDateTime(r.created_at)}. ${r.message ? `Sua mensagem: “${r.message}”. ` : ''}Você recebe a resposta no sino.`}
              actionLabel="Cancelar pedido" onAction={() => run(() => cancelCollaborationRequest(event.id, r.id))} />,
    );
  } else if (r && (r.status === 'accepted' || r.status === 'declined')) {
    const ok = r.status === 'accepted';
    const who = r.decider_name ?? 'O responsável';
    const rawNote = ok && r.wants_raw ? (r.raw_turned_on ? ' Os arquivos RAW foram ligados.' : ' Os arquivos RAW não foram ligados.') : '';
    blocks.push(
      <Notice key="answer" tone={ok ? 'success' : 'warning'} icon={ok ? CircleCheck : TriangleAlert}
              title={`${who} ${ok ? 'aceitou' : 'recusou'} o seu pedido para ${asked(r)}`}
              description={`${r.decided_at ? `Em ${formatDateTime(r.decided_at)}.` : ''}${rawNote}${r.reply ? ` Resposta: “${r.reply}”` : ''}`} />,
    );
  }
  if (r?.can_chat) {
    blocks.push(
      <Card key="chat" padding={16}>
        <ChatToggle eventId={event.id} r={r} other={owner} startOpen={conversa === r.id || r.unread} />
      </Card>,
    );
  }
  const canAsk = (event.ask_upload || event.ask_raw) && r?.status !== 'pending';
  if (canAsk && event.relation === 'outsider') {
    blocks.push(
      <Card key="ask" padding={20} style={styles.askCard}>
        <View style={styles.askIcon}><Handshake size={22} color={panel.primary} strokeWidth={1.6} absoluteStrokeWidth /></View>
        <View style={{ flex: 1, minWidth: 240, gap: 4 }}>
          <Text style={styles.name}>Você não trabalha neste evento</Text>
          <Text style={styles.text}>
            O evento é de {owner}. Você vê só o resumo; as imagens ficam com quem trabalha nele. Para enviar imagens, peça para colaborar.
          </Text>
        </View>
        <Button icon={Handshake} label="Pedir para colaborar" onPress={() => { setUpload(event.ask_upload); setRaw(false); setOpen(true); }} />
      </Card>,
    );
  } else if (canAsk && event.ask_raw && !event.ask_upload) {
    blocks.push(
      <Notice key="raw" tone="info" icon={Camera} title="Este evento não aceita arquivos RAW"
              description={`Se você precisa enviar no formato bruto da câmera, peça a ${owner}.`}
              actionLabel="Pedir para aceitar RAW" onAction={() => { setUpload(false); setRaw(true); setOpen(true); }} />,
    );
  }
  if (!blocks.length && !error) return null;

  return (
    <>
      {error && !open && <Notice tone="danger" icon={TriangleAlert} title={error} />}
      {blocks}
      <Modal visible={open} onClose={() => setOpen(false)} icon={Handshake}
             title={event.ask_upload ? `Pedir a ${first(owner)} para colaborar?` : `Pedir a ${first(owner)} para aceitar RAW?`}>
        <View style={{ gap: 14 }}>
          <Text style={styles.text}>
            {owner} recebe um aviso no sino e decide. Você recebe a resposta também no sino. Tem certeza de que quer enviar o pedido?
          </Text>
          {event.ask_upload && event.ask_raw && (
            <View style={{ gap: 8 }}>
              <Check label="Enviar imagens a este evento" value={upload} onChange={setUpload}
                     help="Aceito, você envia e gerencia só as suas imagens, com o seu crédito." />
              <Check label="Usar arquivos RAW (formato bruto de câmera)" value={raw} onChange={setRaw}
                     help="O evento hoje recebe só JPEG, PNG, HEIC e WebP." />
            </View>
          )}
          <Field label={`Mensagem para ${first(owner)} (opcional)`} help={`Ex.: "Quero enviar 24 imagens deste evento." Até ${MAX} caracteres.`}>
            <Input multiline value={message} onChangeText={setMessage} maxLength={MAX} accessibilityLabel={`Mensagem para ${owner}`} />
          </Field>
          {error && <Notice tone="danger" icon={TriangleAlert} title={error} />}
          <View style={styles.actions}>
            <Button variant="secondary" label="Cancelar" onPress={() => setOpen(false)} />
            <Button icon={Send} label="Enviar pedido" loading={busy} disabled={!upload && !raw}
                    onPress={() => run(() => askCollaboration(event.id, { wants_upload: upload, wants_raw: raw, message: message.trim() || null }))} />
          </View>
        </View>
      </Modal>
    </>
  );
}

/**
 * The responsible's side, on top of "Configuração do evento": each request with Aceitar and Recusar, each opening a
 * confirmation with an optional reply. RAW goes on only if the box is ticked there (RAW is off by default).
 */
export function CollaborationInbox({ event, onEvent, onDecided }: {
  event: EventItem; onEvent: (e: EventItem) => void; onDecided: () => void;
}) {
  const [items, setItems] = useState<CollaborationRequest[] | null>(null);
  const [deciding, setDeciding] = useState<{ r: CollaborationRequest; accept: boolean } | null>(null);
  const [reply, setReply] = useState('');
  const [rawOn, setRawOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { conversa } = useLocalSearchParams<{ conversa?: string }>();   // the link of a notice on the bell

  useEffect(() => { listCollaborationRequests(event.id).then(setItems).catch(() => setItems([])); }, [event.id, event.requests_waiting]);

  async function decide() {
    if (!deciding) return;
    setBusy(true); setError(null);
    try {
      const done = await decideCollaborationRequest(event.id, deciding.r.id,
                                                    { accept: deciding.accept, reply: reply.trim() || null, turn_raw_on: deciding.accept && rawOn });
      setItems((all) => all?.map((x) => (x.id === done.id ? done : x)) ?? null);
      setDeciding(null);
      onEvent(await getEvent(event.id));
      onDecided();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível responder. Tente novamente.');
    } finally { setBusy(false); }
  }

  if (!items || items.length === 0) return null;
  const pending = items.filter((r) => r.status === 'pending');
  const answered = items.filter((r) => r.status !== 'pending');
  const d = deciding?.r;
  return (
    <Card padding={24}>
      <SectionTitle title={pending.length ? `Pedidos de colaboração (${pending.length})` : 'Pedidos de colaboração'} />
      {pending.length === 0 && <Text style={styles.text}>Nenhum pedido aguardando resposta.</Text>}
      <View role="list" style={{ gap: 0 }}>
        {pending.map((r) => (
          <View key={r.id} role="listitem" style={styles.row}>
            <View style={{ flex: 1, minWidth: 240, gap: 4 }}>
              <Text style={styles.name}>{r.requester_name} pediu para {asked(r)}</Text>
              <Text style={styles.text}>
                {r.requester_role}{r.requester_signature ? ` · crédito “${r.requester_signature}”` : ''} · {formatDateTime(r.created_at)}
              </Text>
              {r.message && (
                <View style={styles.quote}>
                  <MessageSquare size={14} color={panel.muted} strokeWidth={1.8} absoluteStrokeWidth />
                  <Text style={[styles.text, { flex: 1 }]}>“{r.message}”</Text>
                </View>
              )}
            </View>
            <View style={styles.actions}>
              <Button variant="secondary" icon={X} label="Recusar" onPress={() => { setReply(''); setRawOn(false); setError(null); setDeciding({ r, accept: false }); }} />
              <Button icon={CircleCheck} label="Aceitar" onPress={() => { setReply(''); setRawOn(false); setError(null); setDeciding({ r, accept: true }); }} />
            </View>
            {r.can_chat && <ChatToggle eventId={event.id} r={r} other={r.requester_name} startOpen={conversa === r.id} />}
          </View>
        ))}
      </View>
      {answered.length > 0 && (
        <>
          <Text style={styles.label}>RESPONDIDOS (FICAM 90 DIAS DEPOIS DA ÚLTIMA MENSAGEM)</Text>
          <View role="list">
            {answered.map((r) => (
              <View key={r.id} role="listitem" style={styles.row}>
                <Text style={[styles.text, { flex: 1, minWidth: 240 }]}>
                  {r.requester_name}: {asked(r)}{r.decided_at ? ` · ${formatDateTime(r.decided_at)}` : ''}
                  {r.decider_name ? ` · por ${r.decider_name}` : ''}{r.raw_turned_on ? ' · RAW ligado' : ''}
                </Text>
                <Pill label={r.status === 'accepted' ? 'Aceito' : 'Recusado'}
                      bg={r.status === 'accepted' ? panel.successSoft : panel.warningSoft}
                      fg={r.status === 'accepted' ? panel.success : panel.warning} />
                {r.can_chat && <ChatToggle eventId={event.id} r={r} other={r.requester_name} startOpen={conversa === r.id} />}
              </View>
            ))}
          </View>
        </>
      )}

      <Modal visible={!!deciding} onClose={() => setDeciding(null)} icon={deciding?.accept ? CircleCheck : X}
             tone={deciding?.accept ? 'primary' : 'danger'}
             title={d ? `${deciding!.accept ? 'Aceitar' : 'Recusar'} o pedido de ${first(d.requester_name)}?` : ''}>
        {d && (
          <View style={{ gap: 14 }}>
            <Text style={styles.text}>
              {deciding!.accept
                ? d.wants_upload
                  ? `${d.requester_name} passa a enviar imagens a este evento, mesmo com a colaboração desligada. Cada um gerencia só as próprias imagens, e a publicação continua sendo sua. Dá para encerrar o acesso depois, em "Quem trabalha neste evento".`
                  : `${d.requester_name} pediu para o evento aceitar arquivos RAW.`
                : `${d.requester_name} recebe um aviso no sino dizendo que você recusou.`}
            </Text>
            {deciding!.accept && d.wants_raw && (
              <Check label='Ligar "Aceitar arquivos RAW" neste evento' value={rawOn} onChange={setRawOn}
                     help="Foto RAW chega ao visitante sem a sua edição e ocupa de 3 a 5 vezes o espaço de um JPEG. Se não marcar, o RAW continua desligado." />
            )}
            <Field label={`Mensagem para ${first(d.requester_name)} (opcional)`}
                   help={deciding!.accept ? 'Ex.: "Aceitei, pode enviar."' : 'Ex.: "Já temos fotógrafos suficientes."'}>
              <Input multiline value={reply} onChangeText={setReply} maxLength={MAX} accessibilityLabel={`Mensagem para ${d.requester_name}`} />
            </Field>
            {error && <Notice tone="danger" icon={TriangleAlert} title={error} />}
            <View style={styles.actions}>
              <Button variant="secondary" label="Voltar" onPress={() => setDeciding(null)} />
              <Button variant={deciding!.accept ? 'primary' : 'danger'} label={deciding!.accept ? 'Aceitar pedido' : 'Recusar pedido'}
                      loading={busy} onPress={decide} />
            </View>
          </View>
        )}
      </Modal>
    </Card>
  );
}

const styles = StyleSheet.create({
  text: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: panel.muted },
  name: { fontFamily: fonts.bold, fontSize: 14, color: panel.text },
  label: { fontFamily: fonts.bold, fontSize: 12, color: panel.muted, marginTop: 8 },
  check: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', padding: 12, borderRadius: panel.radius, backgroundColor: panel.page },
  actions: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
         paddingVertical: 12, borderTopWidth: 1, borderColor: panel.borderSoft },
  quote: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },
  askCard: { flexDirection: 'row', alignItems: 'center', gap: 16, flexWrap: 'wrap' },
  thread: { maxHeight: 360, borderWidth: 1, borderColor: panel.border, borderRadius: panel.radius, backgroundColor: panel.surface },
  bubble: { gap: 4, padding: 12, borderRadius: 12, maxWidth: '85%' },
  // Mine on the right, the other side on the left, like any chat (the same as the support conversation).
  mine: { alignSelf: 'flex-end', backgroundColor: panel.primarySoft },
  theirs: { alignSelf: 'flex-start', backgroundColor: panel.page, borderWidth: 1, borderColor: panel.border },
  who: { fontFamily: fonts.bold, fontSize: 12, color: panel.muted },
  body: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 21, color: panel.text },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', alignSelf: 'flex-start', paddingVertical: 4 },
  toggleText: { fontFamily: fonts.semiBold, fontSize: 14, color: panel.primary },
  askIcon: { width: 46, height: 46, borderRadius: 999, backgroundColor: panel.primarySoft, alignItems: 'center', justifyContent: 'center' },
});
