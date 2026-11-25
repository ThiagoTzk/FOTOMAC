import { Baby, Camera, TriangleAlert, Users } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  listMembers, setChildren, setCollaboration, setMemberAccess, setRaw, type EventItem, type EventMember,
} from '@/api/events';
import { AccessEnded } from '@/components/panel/AccessEnded';
import { ChildrenDeclaration, childrenProblem, NO_CHILDREN } from '@/components/panel/ChildrenDeclaration';
import { CollaborationInbox } from '@/components/panel/CollaborationRequests';
import { Button, Card, Notice, Pill, SectionTitle, Switch } from '@/components/panel/ui';
import { fonts, panel } from '@/theme/tokens';

/**
 * "Configuração do evento" (24/10/2026, was "Colaboração"): what the person responsible switches on and off
 * at any time, without "Editar evento" — collaboration, RAW files and who may still work on the event.
 * Turning someone off keeps their photos, credit and data; they only stop sending and changing.
 */
export function EventSettings({ event, onEvent }: { event: EventItem; onEvent: (e: EventItem) => void }) {
  const [members, setMembers] = useState<EventMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locked = event.status === 'expired' || !!event.deletion_due_at;
  const [reload, setReload] = useState(0);   // a request accepted adds someone to "Quem trabalha neste evento"

  useEffect(() => {
    if (event.can_manage) listMembers(event.id).then(setMembers).catch((e) => setError(e.message));
  }, [event.id, event.can_manage, reload]);

  async function run(action: () => Promise<void>) {
    setError(null);
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível salvar.'); }
  }

  if (!event.can_manage) {
    return (
      <Card padding={24}>
        <SectionTitle title="Configuração do evento" />
        {event.access_blocked ? (
          <AccessEnded event={event} />
        ) : (
          <Notice tone="info" icon={Users} title="Você colabora neste evento"
                  description={`O responsável é ${event.owner.full_name}. Você envia e gerencia apenas as imagens que enviou.`} />
        )}
        <Photographers event={event} />
      </Card>
    );
  }

  return (
    <>
      {error && <Notice tone="danger" icon={TriangleAlert} title={error} />}
      {/* 01/11/2026: the requests to answer come first, like every notice. */}
      <CollaborationInbox event={event} onEvent={onEvent} onDecided={() => setReload((n) => n + 1)} />
      <Card padding={24}>
        <SectionTitle title="Configuração do evento" />
        {locked && <Text style={styles.text}>Este evento {event.status === 'expired' ? 'expirou' : 'está com exclusão agendada'}: a configuração não pode mais ser alterada.</Text>}
        <SwitchRow label="Colaboração" value={event.collaboration_open} disabled={locked}
                   help="Ligada, todo fotógrafo com conta ativa pode enviar imagens a este evento. Desligada, só envia quem teve o pedido de colaboração aceito por você. Cada um mantém o crédito e gerencia apenas as próprias imagens; a publicação continua sendo sua."
                   onChange={(v) => run(async () => onEvent(await setCollaboration(event.id, v)))} />
        <View style={styles.divider} />
        <SwitchRow label="Aceitar arquivos RAW" icon value={event.raw_enabled} disabled={locked}
                   help="Formato bruto de câmera (DNG, CR2, CR3, NEF, ARW e similares). Desligada, o evento recebe só JPEG, PNG, HEIC e WebP; os arquivos RAW já enviados continuam no evento."
                   onChange={(v) => run(async () => onEvent(await setRaw(event.id, v)))} />
        <View style={styles.divider} />
        <ChildrenSetting event={event} onEvent={onEvent} disabled={locked} />
      </Card>

      <Card padding={24}>
        <SectionTitle title="Quem trabalha neste evento" />
        <Text style={styles.text}>
          Desligue o acesso de quem já terminou a cobertura: a pessoa deixa de enviar e de alterar imagens neste evento, mas as fotos
          dela continuam no acervo, com o crédito e as informações dela. Dá para religar quando quiser.
        </Text>
        {!members ? <Text style={styles.text}>Carregando…</Text> : members.map((m) => (
          <View key={m.account_id} style={styles.member}>
            <View style={{ flex: 1, minWidth: 200, gap: 2 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Text style={styles.name}>{m.full_name}</Text>
                {m.owner && <Pill label="Responsável" />}
                {!m.allowed && <Pill label="Acesso encerrado" bg={panel.warningSoft} fg={panel.warning} />}
              </View>
              <Text style={styles.text}>
                {m.role_label}{m.signature ? ` · crédito “${m.signature}”` : ''} · {m.photos} {m.photos === 1 ? 'imagem' : 'imagens'}
              </Text>
            </View>
            {!m.owner && (
              <InstantSwitch value={m.allowed} disabled={locked} label={`Acesso de ${m.full_name}`}
                             on="Pode enviar e alterar" off="Sem acesso"
                             onChange={(v) => run(async () => {
                               const r = await setMemberAccess(event.id, m.account_id, v);
                               setMembers((all) => all?.map((x) => (x.account_id === r.account_id ? r : x)) ?? null);
                             })} />
            )}
          </View>
        ))}
      </Card>
    </>
  );
}

/**
 * A switch saved on the server that turns at the touch. Until 01/11/2026 it only moved when the answer came back, so
 * at the press it snapped back for an instant and VoiceOver read the old state ("ativado" right after turning it
 * off). Now it shows the choice at once, ignores new presses while saving, and goes back only if saving fails.
 */
function InstantSwitch({ value, onChange, disabled, label, on, off }: {
  value: boolean; onChange: (v: boolean) => Promise<void>; disabled?: boolean; label: string; on: string; off: string;
}) {
  const [pending, setPending] = useState<boolean | null>(null);
  const shown = pending ?? value;
  function change(v: boolean) {
    if (pending !== null) return;
    setPending(v);
    onChange(v).finally(() => setPending(null));
  }
  return (
    <View style={styles.switchRow}>
      <Text style={styles.switchText}>{shown ? on : off}</Text>
      <Switch value={shown} onChange={change} disabled={disabled} label={label} />
    </View>
  );
}

function SwitchRow({ label, help, value, onChange, disabled, icon }: {
  label: string; help: string; value: boolean; onChange: (v: boolean) => Promise<void>; disabled?: boolean; icon?: boolean;
}) {
  return (
    <View style={styles.setting}>
      <View style={{ flex: 1, minWidth: 240, gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {icon && <Camera size={16} color={panel.text} strokeWidth={1.8} absoluteStrokeWidth />}
          <Text style={styles.name}>{label}</Text>
        </View>
        <Text style={styles.text}>{help}</Text>
      </View>
      <InstantSwitch value={value} onChange={onChange} disabled={disabled} label={label} on="Ligada" off="Desligada" />
    </View>
  );
}

/** Short date and time, as the panel writes them. */
const when = (iso: string) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).replace(',', ' às');

/**
 * "Este evento contém imagens com crianças" at any time (04/11/2026). Turning it on does not save at once: it opens
 * the declaration (authorisation collected and where the terms are), saved by "Confirmar". Off saves at once.
 */
function ChildrenSetting({ event, onEvent, disabled }: { event: EventItem; onEvent: (e: EventItem) => void; disabled: boolean }) {
  const [asking, setAsking] = useState(false);
  const [form, setForm] = useState({ ...NO_CHILDREN, on: true });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function change(v: boolean) {
    setError(null);
    if (v) { setForm({ ...NO_CHILDREN, on: true }); setAsking(true); return; }
    if (asking) { setAsking(false); return; }
    try { onEvent(await setChildren(event.id, false)); } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível salvar.'); }
  }

  async function confirm() {
    const missing = childrenProblem(form);
    if (missing) { setError(missing); return; }
    setSaving(true);
    try {
      onEvent(await setChildren(event.id, true, form.reference.trim(), form.declared));
      setAsking(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={{ gap: 12 }}>
      <View style={styles.setting}>
        <View style={{ flex: 1, minWidth: 240, gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Baby size={16} color={panel.text} strokeWidth={1.8} absoluteStrokeWidth />
            <Text style={styles.name}>Este evento contém imagens com crianças</Text>
          </View>
          <Text style={styles.text}>
            Ligada, aparece um aviso para a equipe e para o visitante, mesmo que os rostos das crianças sejam borrados. Para ligar, é
            preciso declarar que a autorização dos responsáveis foi coletada e onde estão os termos.
          </Text>
          {event.has_children && !asking && event.children_declared_at && (
            <Text style={styles.text}>
              Declarado por {event.children_declared_by ?? 'conta removida'} em {when(event.children_declared_at)}. Termos:{' '}
              {event.children_authorization_ref}.
            </Text>
          )}
        </View>
        <InstantSwitch value={event.has_children || asking} onChange={change} disabled={disabled}
                       label="Este evento contém imagens com crianças" on="Ligada" off="Desligada" />
      </View>
      {asking && (
        <View style={{ gap: 12 }}>
          <ChildrenDeclaration value={form} onChange={(v) => { setForm(v); setError(null); }} showSwitch={false} error={error} />
          <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
            <Button label="Confirmar" loading={saving} onPress={confirm} />
            <Button variant="secondary" label="Cancelar" onPress={() => { setAsking(false); setError(null); }} />
          </View>
        </View>
      )}
      {!asking && error && <Text style={[styles.text, { color: panel.danger }]} role="alert">{error}</Text>}
    </View>
  );
}

function Photographers({ event }: { event: EventItem }) {
  return (
    <>
      <View style={styles.divider} />
      <Text style={styles.label}>FOTÓGRAFOS COM IMAGENS NESTE EVENTO</Text>
      {event.collaborators.length === 0 ? <Text style={styles.text}>Nenhuma imagem enviada ainda.</Text>
        : event.collaborators.map((c) => (
          <View key={c.signature} style={styles.member}>
            <Text style={styles.name}>{c.signature}</Text>
            <Text style={styles.text}>{c.photos} {c.photos === 1 ? 'imagem' : 'imagens'}</Text>
          </View>
        ))}
    </>
  );
}

const styles = StyleSheet.create({
  text: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: panel.muted },
  label: { fontFamily: fonts.bold, fontSize: 12, color: panel.muted },
  name: { fontFamily: fonts.bold, fontSize: 14, color: panel.text },
  divider: { height: 1, backgroundColor: panel.border },
  setting: { flexDirection: 'row', alignItems: 'center', gap: 16, flexWrap: 'wrap' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  switchText: { fontFamily: fonts.medium, fontSize: 13, color: panel.text },
  member: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
            paddingVertical: 10, borderTopWidth: 1, borderColor: panel.borderSoft },
});
