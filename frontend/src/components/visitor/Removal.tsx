import { Image } from '@/ui/Image';
import { GlobeLock } from 'lucide-react-native';
import { useState, type ReactNode } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { emailProblem } from '@/auth/email-rules';
import { requestRemoval, resultImageUrl, type ResultItem } from '@/api/public';
import { poppins, visitor } from '@/theme/tokens';

import { shortDate } from './PhotoViewer';
import { Note, Sheet, useJustified, VButton, vtext } from './ui';

type FormProps = {
  /** What is being removed (the selected photo, or the chosen file). */
  target: ReactNode;
  send: (email: string, reason: string) => Promise<void>;
  onCancel?: () => void;
  canSend?: boolean;
  /** "esta imagem" or "este vídeo" (04/11/2026). */
  noun?: string;
};

/**
 * Removal request form: optional reason (no justification may be demanded), required contact
 * e-mail (used ONLY to announce the conclusion, then erased), and the warning that
 * the image leaves the searches at once and is deleted within 72 h.
 */
export function RemovalForm({ target, send, onCancel, canSend = true, noun = 'esta imagem' }: FormProps) {
  const justified = useJustified();
  const [reason, setReason] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function submit() {
    const wrong = emailProblem(email.trim(), 120);
    if (wrong) {
      setError(wrong);
      return;
    }
    setSending(true);
    setError(null);
    try {
      await send(email.trim(), reason.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível enviar. Tente novamente.');
    } finally {
      setSending(false);
    }
  }

  return (
    <View style={{ gap: 12 }}>
      {target}
      <Text style={[styles.warning, justified]}>
        Ao enviar a solicitação, {noun} será retirad{noun.startsWith('este') ? 'o' : 'a'} imediatamente dos resultados de busca e
        excluíd{noun.startsWith('este') ? 'o' : 'a'} definitivamente em até 72 horas.
      </Text>
      <View style={{ gap: 6 }}>
        <Text style={vtext.label}>Motivo da solicitação (Opcional)</Text>
        <TextInput value={reason} onChangeText={setReason} multiline maxLength={500} accessibilityLabel="Motivo da solicitação (opcional)"
                   placeholder="Você não precisa justificar." placeholderTextColor={visitor.placeholder}
                   style={[styles.input, { height: 88, textAlignVertical: 'top', paddingTop: 12 }]} />
      </View>
      <View style={{ gap: 6 }}>
        <Text style={vtext.label}>E-mail para contato*</Text>
        <TextInput value={email} onChangeText={(t) => { setEmail(t); setError(null); }} inputMode="email" autoCapitalize="none"
                   autoComplete="email" maxLength={120} accessibilityLabel="E-mail para contato"
                   placeholder="seuemail@exemplo.com" placeholderTextColor={visitor.placeholder} style={styles.input} />
        <Text style={vtext.small}>Usado apenas para avisar quando a exclusão for concluída; depois, é apagado.</Text>
      </View>
      {error && <Note tone="danger">{error}</Note>}
      <View style={styles.actions}>
        {onCancel && <VButton label="Cancelar" variant="outlineDanger" onPress={onCancel} />}
        <VButton label="Enviar" onPress={submit} loading={sending} disabled={!canSend} />
      </View>
    </View>
  );
}

/** "Solicitação recebida". */
export function RemovalDone({ onClose, closeLabel = 'Entendi', video = false }: { onClose: () => void; closeLabel?: string; video?: boolean }) {
  return (
    <View style={{ gap: 12, alignItems: 'center' }} accessibilityLiveRegion="polite">
      <GlobeLock size={60} color={visitor.primary} strokeWidth={1.2} absoluteStrokeWidth />
      <Text style={[vtext.h3, { textAlign: 'center' }]}>Solicitação recebida</Text>
      <Text style={[vtext.body, { textAlign: 'center' }]}>Sua solicitação foi enviada com sucesso.</Text>
      <Text style={styles.doneText}>
        {video ? 'O vídeo foi retirado dos resultados de busca e será excluído definitivamente em até 72 horas, para todas as pessoas.'
          : 'A imagem foi retirada dos resultados de busca e será excluída definitivamente em até 72 horas.'}
      </Text>
      <Text style={styles.doneText}>Você receberá uma confirmação pelos dados de contato informados.</Text>
      <VButton label={closeLabel} onPress={onClose} />
    </View>
  );
}

type ModalProps = { item: ResultItem | null; fallbackDate: string; onClose: () => void; onRemoved: (id: string) => void };

/** From the enlarged photo: the image is identified by its own visualization. */
export function RemovalModal({ item, fallbackDate, onClose, onRemoved }: ModalProps) {
  const [done, setDone] = useState(false);
  const close = () => { setDone(false); onClose(); };
  return (
    <Sheet visible={!!item} title="Solicitar remoção" onClose={close}>
      {item && (done ? <RemovalDone onClose={close} /> : (
        <RemovalForm
          onCancel={close}
          send={async (email, reason) => { await requestRemoval(item.id, email, reason); setDone(true); onRemoved(item.id); }}
          target={(
            <View style={styles.target}>
              <Image source={resultImageUrl(item.id, 'thumb')} style={styles.targetThumb} contentFit="cover"
                     accessibilityLabel="A foto escolhida para remoção" />
              <Text style={styles.targetText}>Foto selecionada para a solicitação da remoção</Text>
              <Text style={styles.targetDate}>{item.captured_at ? shortDate(item.captured_at) : fallbackDate}</Text>
            </View>
          )} />
      ))}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  warning: { fontFamily: poppins.medium, fontSize: 12, lineHeight: 18, color: visitor.danger },
  input: { minHeight: 44, borderWidth: 1, borderColor: 'rgba(120, 120, 128, 0.20)', borderRadius: 8, paddingHorizontal: 12,
           fontFamily: poppins.regular, fontSize: 15, color: visitor.title, backgroundColor: visitor.surface },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' },
  target: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 8, borderRadius: 8, backgroundColor: 'rgba(12, 12, 12, 0.08)' },
  targetThumb: { width: 62, height: 62, borderRadius: 6 },
  targetText: { flex: 1, fontFamily: poppins.medium, fontSize: 12, color: visitor.muted },
  targetDate: { fontFamily: poppins.medium, fontSize: 12, color: visitor.text, alignSelf: 'flex-end' },
  doneText: { fontFamily: poppins.regular, fontSize: 13, lineHeight: 20, color: visitor.text, textAlign: 'center' },
});
