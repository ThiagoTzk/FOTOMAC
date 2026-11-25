import { router } from 'expo-router';
import { ChevronDown, ChevronUp, MessageSquare, RefreshCw, Send, TriangleAlert, UserRound } from 'lucide-react-native';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { formatDateTime } from '@/api/images';
import {
  replyAsAdmin, replyMine, seenAsAdmin, seenMine, setSupportStatus, SUPPORT_STATUSES, type SupportMessage, type SupportStatus,
} from '@/api/support';
import { Select } from '@/components/panel/Select';
import { Button, Card, Field, Input, Notice, Pill } from '@/components/panel/ui';
import { fonts, panel } from '@/theme/tokens';

export function StatusPill({ status, label }: { status: SupportStatus; label: string }) {
  const [bg, fg] = {
    open: [panel.warningSoft, panel.warning],
    analyzing: [panel.primarySoft, panel.primaryText],
    fixing: [panel.primarySoft, panel.primaryText],
    resolved: [panel.successSoft, panel.success],
  }[status];
  return <Pill label={label} bg={bg} fg={fg} />;
}

type Props = {
  m: SupportMessage;
  /** The administrator's inbox: who wrote, the status control and the way to their account. */
  admin: boolean;
  /** Opened from a notice of the bell (?conversa=…). */
  initiallyOpen?: boolean;
  /** The server's answer after a reply or a status change (the parent keeps the list). */
  onChange: (m: SupportMessage) => void;
};

/**
 * One support conversation (31/10/2026): the first message, then everything that happened — replies from both sides
 * and the status changes made by the administration, in order, like a chat. Opening it marks it as read (the bell).
 */
export function Conversation({ m, admin, initiallyOpen = false, onChange }: Props) {
  const [open, setOpen] = useState(initiallyOpen);
  const [text, setText] = useState('');
  // The status chosen in the box, before "Mudar situação"; null = the conversation's own.
  const [chosen, setChosen] = useState<SupportStatus | null>(null);
  const status = chosen ?? m.status;
  const [busy, setBusy] = useState<'reply' | 'status' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closed = m.status === 'resolved' && !admin;
  const thread = useRef<ComponentRef<typeof ScrollView>>(null);

  // Read on opening (and when something new arrives while it is open): the bell stops telling about it.
  useEffect(() => {
    if (open && m.unread) (admin ? seenAsAdmin : seenMine)(m.id).then(() => onChange({ ...m, unread: false })).catch(() => undefined);
  }, [open, m, admin, onChange]);

  async function run(kind: 'reply' | 'status') {
    setError(null);
    if (kind === 'reply' && !text.trim()) return setError('Escreva a mensagem.');
    setBusy(kind);
    try {
      // Each button does only what it says: changing the status keeps the text being written in the box.
      const next = kind === 'reply'
        ? await (admin ? replyAsAdmin : replyMine)(m.id, text.trim())
        : await setSupportStatus(m.id, status);
      if (kind === 'reply') setText(''); else setChosen(null);
      onChange(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível enviar. Tente novamente.');
    } finally {
      setBusy(null);
    }
  }

  const last = m.entries[m.entries.length - 1];
  return (
    <Card padding={20} style={{ gap: 12 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} aria-expanded={open}
                 accessibilityLabel={`${open ? 'Fechar' : 'Abrir'} conversa: ${m.subject}`} onPress={() => setOpen((o) => !o)}
                 style={{ gap: 8 }}>
        <View style={styles.head}>
          <Pill label={m.kind_label} />
          <StatusPill status={m.status} label={m.status_label} />
          {m.unread && <Pill label="Novidade" bg={panel.danger} fg="#FFFFFF" />}
          <Text style={styles.meta}>{formatDateTime(m.created_at)}</Text>
          <View style={{ flex: 1 }} />
          {open ? <ChevronUp size={18} color={panel.muted} strokeWidth={1.6} absoluteStrokeWidth />
            : <ChevronDown size={18} color={panel.muted} strokeWidth={1.6} absoluteStrokeWidth />}
        </View>
        <Text style={styles.subject}>{m.subject}</Text>
        {admin && m.author_name && (
          <Text style={styles.meta}>
            {m.author_name} · {m.author_role} · {m.author_email}
            {m.author_status !== 'active' && m.author_status_label ? ` · conta ${m.author_status_label.toLowerCase()}` : ''}
          </Text>
        )}
        {!open && (
          <Text style={styles.meta} numberOfLines={1}>
            {m.entries.length ? `${m.entries.length} ${m.entries.length === 1 ? 'atualização' : 'atualizações'} · última em ${formatDateTime(last.created_at)}`
              : 'Sem resposta ainda'}
          </Text>
        )}
      </Pressable>

      {open && (
        <>
          <ScrollView ref={thread} style={styles.thread} contentContainerStyle={{ gap: 10, padding: 12 }}
                      onContentSizeChange={() => thread.current?.scrollToEnd({ animated: false })}>
            <View style={[styles.bubble, admin ? styles.theirs : styles.mine]}>
              <Text style={styles.bubbleWho}>{admin ? m.author_name : 'Você'} · {formatDateTime(m.created_at)}</Text>
              <Text style={styles.body}>{m.message}</Text>
              {m.page && <Text style={styles.meta}>Onde: {m.page}</Text>}
            </View>
            {m.entries.map((e, i) => {
              const own = e.from_admin === admin;
              return (
                <View key={i} style={{ gap: 6 }}>
                  {e.status && (
                    <View style={styles.statusLine}>
                      <RefreshCw size={13} color={panel.muted} strokeWidth={1.8} absoluteStrokeWidth />
                      <Text style={styles.meta}>
                        {own ? 'Você mudou' : `${e.author_name ?? 'Administração'} mudou`} a situação para “{e.status_label}” · {formatDateTime(e.created_at)}
                      </Text>
                    </View>
                  )}
                  {e.body && (
                    <View style={[styles.bubble, own ? styles.mine : styles.theirs]}>
                      <Text style={styles.bubbleWho}>{own ? 'Você' : e.author_name ?? 'Administração'} · {formatDateTime(e.created_at)}</Text>
                      <Text style={styles.body}>{e.body}</Text>
                    </View>
                  )}
                </View>
              );
            })}
          </ScrollView>

          {error && <Notice tone="danger" icon={TriangleAlert} title={error} />}
          {closed ? (
            <Text style={styles.help}>Conversa resolvida e encerrada. Se o problema voltar, envie uma nova mensagem.</Text>
          ) : (
            <View style={{ gap: 10 }}>
              <Field label={admin ? 'Mensagem para quem escreveu' : 'Responder à administração'}
                     help={admin ? 'Quem escreveu recebe um aviso no sino. A mensagem só sai ao clicar em "Enviar mensagem"; mudar a situação não envia o texto.'
                       : 'A administração recebe um aviso no sino.'}>
                <Input multiline value={text} onChangeText={setText} maxLength={2000}
                       accessibilityLabel={`Mensagem na conversa ${m.subject}`} />
              </Field>
              <View style={styles.actions}>
                {admin && (
                  <>
                    <View style={{ width: 190 }}>
                      <Select placeholder="Situação" options={SUPPORT_STATUSES} value={status} onChange={(s) => s && setChosen(s)}
                              accessibilityLabel={`Situação de ${m.subject}`} />
                    </View>
                    <Button variant="secondary" icon={RefreshCw} label="Mudar situação" loading={busy === 'status'}
                            disabled={status === m.status} onPress={() => run('status')} />
                  </>
                )}
                <Button icon={Send} label="Enviar mensagem" loading={busy === 'reply'} onPress={() => run('reply')} />
              </View>
              {admin && m.author_id && (
                <Pressable accessibilityRole="link" onPress={() => router.navigate(`/contas/${m.author_id}`)} style={styles.link}>
                  <UserRound size={15} color={panel.primary} strokeWidth={1.8} absoluteStrokeWidth />
                  <Text style={styles.linkText}>
                    Abrir a conta de {m.author_name}{m.author_status !== 'active' ? ' (reativar ou renovar o acesso)' : ''}
                  </Text>
                </Pressable>
              )}
            </View>
          )}
        </>
      )}
    </Card>
  );
}

/** Nothing yet. */
export function NoConversations({ text }: { text: string }) {
  return (
    <Card padding={28} style={{ alignItems: 'center', gap: 10 }}>
      <MessageSquare size={26} color={panel.muted} strokeWidth={1.6} absoluteStrokeWidth />
      <Text style={styles.help}>{text}</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  subject: { fontFamily: fonts.semiBold, fontSize: 16, color: panel.text },
  body: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 21, color: panel.text },
  meta: { fontFamily: fonts.regular, fontSize: 12, color: panel.muted },
  help: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: panel.muted },
  bubble: { gap: 4, padding: 12, borderRadius: 12, maxWidth: '85%' },
  // My side on the right, the other side on the left — like any chat.
  mine: { alignSelf: 'flex-end', backgroundColor: panel.primarySoft },
  theirs: { alignSelf: 'flex-start', backgroundColor: panel.page, borderWidth: 1, borderColor: panel.border },
  bubbleWho: { fontFamily: fonts.bold, fontSize: 12, color: panel.muted },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'center' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  // A long conversation scrolls inside its own box (the newest message at the bottom) instead of growing the page.
  thread: { maxHeight: 440, borderWidth: 1, borderColor: panel.border, borderRadius: panel.radius, backgroundColor: panel.surface },
  link: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
  linkText: { fontFamily: fonts.semiBold, fontSize: 13, color: panel.primary },
});
