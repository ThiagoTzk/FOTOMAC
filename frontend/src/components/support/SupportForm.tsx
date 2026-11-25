import { CircleCheck, Send, TriangleAlert } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { sendSupport, SUPPORT_KINDS, type SupportKind } from '@/api/support';
import { Select } from '@/components/panel/Select';
import { Button, Card, Field, Input, Notice, SectionTitle } from '@/components/panel/ui';
import { fonts, panel } from '@/theme/tokens';

type Props = {
  /** Called after a message is sent (to reload the list of conversations). */
  onSent: () => void;
  /** The restricted page of a blocked account starts on "Acesso à conta", with a subject ready. */
  initialKind?: SupportKind;
  initialSubject?: string;
  title?: string;
};

/** A new conversation with the administration: a problem, a suggestion, a question or a request about the account. */
export function SupportForm({ onSent, initialKind = 'problem', initialSubject = '', title = 'Escrever para a administração' }: Props) {
  const [kind, setKind] = useState<SupportKind>(initialKind);
  const [subject, setSubject] = useState(initialSubject);
  const [message, setMessage] = useState('');
  const [page, setPage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function send() {
    setError(null); setSent(false);
    if (!subject.trim()) return setError('Escreva o assunto.');
    if (!message.trim()) return setError('Descreva o que aconteceu.');
    setSending(true);
    try {
      await sendSupport({ kind, subject, message, page: page.trim() || null });
      setSubject(''); setMessage(''); setPage(''); setSent(true);
      onSent();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível enviar. Tente novamente.');
    } finally {
      setSending(false);
    }
  }

  return (
    <Card padding={24} style={{ gap: 16 }}>
      <SectionTitle title={title} />
      {sent && <Notice tone="success" icon={CircleCheck} title="Mensagem enviada. As respostas aparecem aqui e no sino." />}
      {error && <Notice tone="danger" icon={TriangleAlert} title={error} />}
      <View style={styles.row}>
        <Field label="Tipo" style={{ width: 220 }}>
          <Select placeholder="Tipo" options={SUPPORT_KINDS} value={kind} onChange={(k) => k && setKind(k)} accessibilityLabel="Tipo" />
        </Field>
        <Field label="Assunto" style={{ flex: 1, minWidth: 240 }}>
          <Input value={subject} onChangeText={setSubject} maxLength={120} placeholder="Ex.: o envio de fotos para no meio"
                 accessibilityLabel="Assunto" />
        </Field>
      </View>
      <Field label="Mensagem" help="Conte o que você tentou fazer, o que aconteceu e o que esperava que acontecesse.">
        <Input multiline value={message} onChangeText={setMessage} maxLength={3000} accessibilityLabel="Mensagem"
               placeholder="Ex.: no evento Colação de grau, ao enviar 300 fotos, a barra parou em 90% e não terminou." />
      </Field>
      <Field label="Onde aconteceu (opcional)" help="O evento ou a tela, se ajudar a encontrar o problema.">
        <Input value={page} onChangeText={setPage} maxLength={200} accessibilityLabel="Onde aconteceu"
               placeholder="Ex.: Eventos › Colação de grau › Enviar imagens" />
      </Field>
      <Text style={styles.help}>
        Não escreva senhas nem dados pessoais de outras pessoas. Só a administração lê as mensagens, e as conversas
        resolvidas são apagadas depois de 3 meses.
      </Text>
      <View style={styles.actions}><Button icon={Send} label="Enviar" onPress={send} loading={sending} /></View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 16, flexWrap: 'wrap' },
  help: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: panel.muted },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 10 },
});
