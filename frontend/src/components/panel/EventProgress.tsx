import { router } from 'expo-router';
import { Check } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { canUploadTo, isoToBr, type EventItem } from '@/api/events';
import { Button, Card } from '@/components/panel/ui';
import { fonts, panel } from '@/theme/tokens';
import { useTextScale } from '@/theme/accessibility';

type Link = { label: string; onPress: () => void };
type Step = { title: string; detail: string; done: boolean; action?: Link; links?: Link[] };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The life of an event as four steps — send → review and publish → face recognition → on the site —
 *  instead of a pile of coloured notices. The first step not done is the current one
 *  and carries the next action; urgent things (deletion, approvals) stay as notices above it. */
export function EventProgress({ event, style }: { event: EventItem; style?: StyleProp<ViewStyle> }) {
  const scale = useTextScale();
  const inReview = event.photos - event.published;
  const go = (path: string) => () => router.navigate(path as never);
  const base = `/eventos/${event.id}`;
  const onSite = event.status === 'published';

  const steps: Step[] = [
    {
      title: 'Enviar imagens',
      detail: event.photos ? plural(event.photos, 'imagem enviada', 'imagens enviadas') : 'Nenhuma imagem ainda.',
      done: event.photos > 0,
      // Sending lives in the Imagens tab: the overview only points there.
      action: canUploadTo(event) && !event.photos ? { label: 'Ir para Imagens', onPress: go(`${base}/imagens`) } : undefined,
    },
    {
      title: 'Conferir e publicar',
      detail: inReview > 0
        ? `${plural(inReview, 'imagem', 'imagens')} em conferência${event.approvals_pending ? ` (${event.approvals_pending} aguardando aprovação)` : ''}.`
        : event.published ? plural(event.published, 'imagem publicada.', 'imagens publicadas.') : 'Depois do envio.',
      done: event.photos > 0 && inReview === 0,
      action: inReview > 0
        ? (event.can_manage ? { label: 'Conferir e publicar', onPress: go(`${base}/imagens?filtro=in_review`) } : undefined)
        : undefined,
    },
    {
      title: 'Reconhecimento facial',
      detail: event.status === 'processing' ? 'Indexando os rostos das imagens publicadas.'
        : onSite ? 'Rostos indexados.' : 'Começa quando as imagens são publicadas.',
      done: onSite,
      action: event.status === 'processing' ? { label: 'Acompanhar', onPress: go(`${base}/processamento`) } : undefined,
    },
    {
      title: 'No site',
      // The retention date, said once and in its place (it used to be a notice of its own).
      detail: onSite ? `Visível para busca até ${isoToBr(event.expires_on)}. Depois, tudo é eliminado.`
        : `Aparece quando o reconhecimento terminar. Fica até ${isoToBr(event.expires_on)}.`,
      done: onSite,
      links: [
        ...(onSite ? [{ label: 'Ver no site', onPress: go(`/evento/${event.id}`) }] : []),
        ...(event.published > 0 ? [{ label: event.can_manage ? 'Baixar acervo' : 'Baixar minhas imagens', onPress: go(`${base}/download`) }] : []),
      ],
    },
  ];
  const current = steps.findIndex((s) => !s.done);

  return (
    <Card padding={16} style={[{ gap: 12 }, style]}>
      <View style={{ gap: 2 }}>
        <Text style={styles.heading}>Andamento do evento</Text>
        <Text style={styles.sub}>
          {current === -1 ? 'Tudo pronto: o evento está no site.' : `Próximo passo: ${steps[current].title.toLowerCase()}.`}
        </Text>
      </View>
      <View style={styles.row} role="list">
        {steps.map((s, i) => {
          const state = s.done ? 'done' : i === current ? 'current' : 'todo';
          return (
            <View key={s.title} style={[styles.step, { flexBasis: 125 * scale }, state === 'current' && styles.stepCurrent]} role="listitem"
                  accessibilityLabel={`Etapa ${i + 1}, ${s.title}: ${state === 'done' ? 'concluída' : state === 'current' ? 'atual' : 'pendente'}`}>
              <View style={styles.top}>
                <View style={[styles.circle, state === 'done' ? styles.circleDone : state === 'current' ? styles.circleCurrent : null]}>
                  {state === 'done'
                    ? <Check size={14} color="#FFFFFF" strokeWidth={2.4} absoluteStrokeWidth />
                    : <Text style={[styles.number, state === 'current' && { color: '#FFFFFF' }]}>{i + 1}</Text>}
                </View>
                {i < steps.length - 1 && <View style={[styles.line, s.done && styles.lineDone]} />}
              </View>
              <Text style={[styles.title, state === 'todo' && { color: panel.muted }]}>{s.title}</Text>
              <Text style={styles.detail}>{s.detail}</Text>
              {s.action && (state === 'current'
                ? <View style={{ alignSelf: 'flex-start' }}><Button label={s.action.label} onPress={s.action.onPress} /></View>
                : <Pressable accessibilityRole="link" onPress={s.action.onPress} style={styles.linkArea}><Text style={styles.link}>{s.action.label}</Text></Pressable>)}
              {s.links?.map((l) => (
                <Pressable key={l.label} accessibilityRole="link" onPress={l.onPress} style={styles.linkArea}><Text style={styles.link}>{l.label}</Text></Pressable>
              ))}
            </View>
          );
        })}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  heading: { fontFamily: fonts.regular, fontSize: 17, color: panel.text },
  sub: { fontFamily: fonts.regular, fontSize: 13, color: panel.muted },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  step: { flexGrow: 1, flexBasis: 125, gap: 4, padding: 8, borderRadius: panel.radius, borderWidth: 1, borderColor: 'transparent' },
  stepCurrent: { backgroundColor: panel.primarySoft, borderColor: panel.border },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  circle: { width: 26, height: 26, borderRadius: 999, backgroundColor: panel.page, borderWidth: 1, borderColor: panel.border,
            alignItems: 'center', justifyContent: 'center' },
  circleDone: { backgroundColor: panel.success, borderColor: panel.success },
  circleCurrent: { backgroundColor: panel.action, borderColor: panel.action },
  number: { fontFamily: fonts.bold, fontSize: 13, color: panel.muted },
  line: { flex: 1, height: 2, borderRadius: 2, backgroundColor: panel.border },
  lineDone: { backgroundColor: panel.success },
  title: { fontFamily: fonts.bold, fontSize: 14, color: panel.text },
  detail: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: panel.muted },
  // 24 px on screen once the site is scaled down on a computer (WCAG 2.5.8).
  linkArea: { minHeight: 28, justifyContent: 'center' },
  link: { fontFamily: fonts.bold, fontSize: 13, color: panel.primary },
});
