import { CircleCheck, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { createTheme, deleteTheme, listManagedThemes, renameTheme, setThemeActive, type ThemeRow } from '@/api/themes';
import { useAuth } from '@/auth/AuthContext';
import { ThemeIcon } from '@/components/icons/themeIcons';
import { IconPicker } from '@/components/panel/IconPicker';
import { Modal } from '@/components/panel/Modal';
import { PageHeader } from '@/components/panel/PageHeader';
import { Button, Card, Field, Input, Notice, Pill } from '@/components/panel/ui';
import { usePhone } from '@/theme/accessibility';
import { fonts, panel } from '@/theme/tokens';

/**
 * "Manutenção dos Temas de Evento" (RF027): the list used in the event form and in the public filters.
 * Since 11/11/2026 the administrator, photographers and marketing all have this screen (after the
 * stakeholder meeting: each team organizes the themes its own way). One list, with the author of each theme;
 * only the author or the administrator changes a theme (checked on the server). A theme in use is never
 * deleted, only inactivated: the events keep it. Every theme has a symbol, drawn in the public theme strip.
 */
export default function ThemesScreen() {
  const [themes, setThemes] = useState<ThemeRow[] | null>(null);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('tag');
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<ThemeRow | null>(null);
  const [newName, setNewName] = useState('');
  const [newIcon, setNewIcon] = useState('tag');
  const add = () => run(() => createTheme(name, icon), `Tema “${name.trim()}” criado.`).then((ok) => { if (ok) { setName(''); setIcon('tag'); } });
  const [removing, setRemoving] = useState<ThemeRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const phone = usePhone();
  const isAdmin = useAuth().account?.role === 'admin';

  const load = useCallback(() => { listManagedThemes().then(setThemes).catch((e) => setError(e.message)); }, []);
  useEffect(load, [load]);

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true); setError(null); setDone(null);
    try {
      await action();
      setDone(message);
      load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível concluir.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 24, maxWidth: 1080 }}>
      <PageHeader crumbs={[{ label: 'Visão geral', href: '/painel' }, { label: 'Temas' }]} title="Temas" subtitle="Temas oferecidos no cadastro de eventos e nos filtros da busca pública." />
      {done && <Notice tone="success" icon={CircleCheck} title={done} />}
      {error && <Notice tone="danger" icon={TriangleAlert} title={error} />}
      <Card padding={20}>
        <View style={styles.add}>
          <Field label="Ícone">
            <Pressable accessibilityRole="button" accessibilityLabel="Escolher o ícone do novo tema" onPress={() => setPicking(true)}
                       style={({ hovered }: any) => [styles.iconButton, hovered && { borderColor: panel.primary }]}>
              <ThemeIcon name={icon} size={22} color={panel.primary} strokeWidth={1.7} absoluteStrokeWidth />
            </Pressable>
          </Field>
          <Field label="Novo tema" style={{ flex: 1, minWidth: 220 }} help="Até 50 caracteres; não pode repetir um tema existente.">
            <Input value={name} onChangeText={setName} maxLength={50} placeholder="Ex.: Colação de jaleco" accessibilityLabel="Novo tema"
                   onSubmitEditing={() => name.trim() && add()} />
          </Field>
          <View style={{ paddingTop: 24 }}>
            <Button icon={Plus} label="Adicionar" disabled={!name.trim()} loading={busy} onPress={add} />
          </View>
        </View>
      </Card>
      <Text style={styles.help}>
        {isAdmin
          ? 'Os temas são criados pelos fotógrafos, pela equipe de marketing e pela administração, e cada um pertence a quem o criou. Como administrador, você pode alterar qualquer tema; prefira fazer isso só para moderar. '
          : 'A lista de temas é a mesma para toda a equipe. Você altera os temas que criou; os das outras pessoas aparecem só para consulta. '}
        Um tema usado por algum evento não pode ser excluído, apenas inativado: deixa de ser oferecido em eventos novos e
        nos filtros públicos, mas continua nos eventos que já o usam.
      </Text>
      {themes && (
        <View style={styles.table}>
          {/* 06/11/2026: on a phone the columns did not fit (headers on top of each other, names cut): one card per theme. */}
          {!phone && (
          <View style={styles.head}>
            <Text style={[styles.th, { flex: 1 }]}>TEMA</Text>
            <Text style={[styles.th, { width: 170 }]}>AUTOR</Text>
            <Text style={[styles.th, { width: 110 }]}>SITUAÇÃO</Text>
            <Text style={[styles.th, { width: 90 }]}>EVENTOS</Text>
            <Text style={[styles.th, { width: 250, textAlign: 'right' }]}>AÇÕES</Text>
          </View>)}
          <View role="list">
          {themes.map((t) => {
            // "Você" for your own; no author: the theme came with the system (only the administrator changes it).
            const author = t.mine ? 'Você' : t.author ?? 'Sistema';
            return (
            <View key={t.id} role="listitem" accessibilityLabel={`Tema ${t.name}`} style={[styles.row, !t.active && { backgroundColor: panel.page }]}>
              <View style={[{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 }, phone && { flexBasis: '100%' }]}>
                <View style={styles.iconBadge}><ThemeIcon name={t.icon} size={18} color={t.active ? panel.primary : panel.muted} strokeWidth={1.7} absoluteStrokeWidth /></View>
                <Text style={[styles.name, { flex: 1 }, !t.active && { color: panel.muted }]}>{t.name}</Text>
                {phone && (t.active ? <Pill label="Ativo" bg={panel.successSoft} fg={panel.success} /> : <Pill label="Inativo" bg="#FFFFFF" fg={panel.muted} />)}
              </View>
              {/* Long names wrap inside the column (never widen it). */}
              <Text style={[styles.cell, phone ? { flexBasis: '100%', paddingLeft: 44 } : { width: 170, paddingRight: 8 }]}>
                {phone ? `Criado por: ${author}` : author}
              </Text>
              {!phone && (
              <View style={{ width: 110 }}>
                {t.active ? <Pill label="Ativo" bg={panel.successSoft} fg={panel.success} /> : <Pill label="Inativo" bg="#FFFFFF" fg={panel.muted} />}
              </View>)}
              <Text style={[styles.cell, phone ? { flex: 1, paddingLeft: 44 } : { width: 90 }]}>
                {phone ? `${t.events} ${t.events === 1 ? 'evento' : 'eventos'}` : t.events}
              </Text>
              <View style={[styles.actions, phone && { width: 'auto' }]}>
                {/* Somebody else's theme: the rule is shown, not hidden (the server refuses the change anyway). */}
                {!t.can_change && <Text style={styles.readOnly}>Só o autor altera</Text>}
                {t.can_change && <>
                <Action label="Editar" icon={Pencil} onPress={() => { setEditing(t); setNewName(t.name); setNewIcon(t.icon); }} />
                <Action label={t.active ? 'Inativar' : 'Ativar'}
                        onPress={() => run(() => setThemeActive(t.id, !t.active), t.active
                          ? `“${t.name}” inativado: não aparece mais em eventos novos nem nos filtros.` : `“${t.name}” ativado.`)} />
                {/* Only an unused theme can be deleted. */}
                {t.events === 0 && <Action label="Excluir" icon={Trash2} danger onPress={() => setRemoving(t)} />}
                </>}
              </View>
            </View>
            );
          })}
          </View>
        </View>
      )}

      <Modal visible={!!editing} onClose={() => setEditing(null)} icon={Pencil} title="Editar tema" width={720}>
        <View style={{ gap: 16 }}>
          <Field label="Nome do tema"><Input value={newName} onChangeText={setNewName} maxLength={50} accessibilityLabel="Nome do tema" /></Field>
          {!!editing?.events && <Text style={styles.help}>O nome e o ícone mudam também nos {editing.events} evento(s) que usam este tema.</Text>}
          {/* The icon grid scrolls on its own, so "Salvar" stays in sight below it. */}
          <ScrollView style={{ maxHeight: 340 }}><IconPicker value={newIcon} onChange={setNewIcon} /></ScrollView>
          <View style={styles.modalActions}>
            <Button variant="secondary" label="Cancelar" onPress={() => setEditing(null)} />
            <Button label="Salvar" loading={busy} disabled={!newName.trim()}
                    onPress={() => editing && run(() => renameTheme(editing.id, newName, newIcon), 'Tema atualizado.').then((ok) => ok && setEditing(null))} />
          </View>
        </View>
      </Modal>
      <Modal visible={picking} onClose={() => setPicking(false)} icon={Plus} title="Ícone do novo tema" width={720}>
        <View style={{ gap: 16 }}>
          <IconPicker value={icon} onChange={(n) => { setIcon(n); setPicking(false); }} />
        </View>
      </Modal>
      <Modal visible={!!removing} onClose={() => setRemoving(null)} icon={Trash2} tone="danger" title="Excluir tema?">
        <View style={{ gap: 16 }}>
          <Text style={styles.help}>“{removing?.name}” não é usado por nenhum evento e será excluído definitivamente.</Text>
          <View style={styles.modalActions}>
            <Button variant="secondary" label="Cancelar" onPress={() => setRemoving(null)} />
            <Button variant="danger" label="Excluir" loading={busy}
                    onPress={() => removing && run(() => deleteTheme(removing.id), 'Tema excluído.').then(() => setRemoving(null))} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

function Action({ label, icon: Icon, danger, onPress }: { label: string; icon?: typeof Pencil; danger?: boolean; onPress: () => void }) {
  const color = danger ? panel.danger : panel.primary;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.action}>
      {Icon && <Icon size={14} color={color} strokeWidth={1.8} absoluteStrokeWidth />}
      <Text style={[styles.actionText, { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  add: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' },
  iconButton: { width: 48, height: 48, borderRadius: 10, borderWidth: 1, borderColor: panel.border, alignItems: 'center',
                justifyContent: 'center', backgroundColor: panel.primarySoft },
  iconBadge: { width: 34, height: 34, borderRadius: 17, backgroundColor: panel.primarySoft, alignItems: 'center', justifyContent: 'center' },
  table: { borderWidth: 1, borderColor: panel.border, borderRadius: panel.cardRadius, overflow: 'hidden', backgroundColor: panel.surface },
  head: { height: 42, backgroundColor: panel.page, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
  th: { fontFamily: fonts.bold, fontSize: 12, color: panel.muted },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, borderTopWidth: 1,
         borderColor: panel.borderSoft, flexWrap: 'wrap', gap: 6 },
  name: { fontFamily: fonts.regular, fontSize: 14, color: panel.text },
  cell: { fontFamily: fonts.regular, fontSize: 14, color: panel.muted },
  actions: { width: 250, flexDirection: 'row', justifyContent: 'flex-end', gap: 14, flexWrap: 'wrap' },
  action: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },
  actionText: { fontFamily: fonts.bold, fontSize: 13 },
  readOnly: { fontFamily: fonts.regular, fontSize: 13, color: panel.muted, paddingVertical: 4 },
  help: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 20, color: panel.muted },
  modalActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 10 },
});
