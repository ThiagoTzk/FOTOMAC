import { Download, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { reportExportUrl, reportSummary, type ReportPeriod, type ReportSummary } from '@/api/reports';
import { maskDay, parseDay } from '@/components/panel/dates';
import { PageHeader } from '@/components/panel/PageHeader';
import { Select } from '@/components/panel/Select';
import { Button, Card, Field, Input, Notice } from '@/components/panel/ui';
import { usePhone } from '@/theme/accessibility';
import { fonts, panel } from '@/theme/tokens';
import { saveFile } from '@/ui/saveFile';

/**
 * "Registros" (RF024 and RNF14, 11/11/2026): what happened in a period, the atypical use of the public search, and
 * the export of every record the LGPD compliance needs (Art. 38). Administrator only, here and on the server.
 * Only counts on the screen; the names are in the exported files, which say how to keep them.
 */
const PERIODS = [
  { value: 'd7', label: 'Últimos 7 dias' },
  { value: 'm1', label: 'Último mês' },
  { value: 'm3', label: 'Últimos 3 meses' },
  { value: 'm6', label: 'Últimos 6 meses' },
  { value: 'm12', label: 'Último ano' },
  { value: 'all', label: 'Todo o período' },
  { value: 'custom', label: 'Escolher as datas…' },
] as const;
type Period = (typeof PERIODS)[number]['value'];

/** The day in the person's own calendar (toISOString would give tomorrow after 21h in Maceió). */
const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function range(p: Period, from: string, to: string): ReportPeriod {
  if (p === 'all') return { start: null, end: null };
  if (p === 'custom') return { start: parseDay(from), end: parseDay(to) };
  const d = new Date();
  if (p === 'd7') d.setDate(d.getDate() - 6);
  else d.setMonth(d.getMonth() - Number(p.slice(1)));
  return { start: localDay(d), end: localDay(new Date()) };
}

const br = (iso: string) => iso.split('-').reverse().join('/');
const when = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const n = (v: number) => v.toLocaleString('pt-BR');

export default function RecordsScreen() {
  const [period, setPeriod] = useState<Period>('m1');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState<ReportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const phone = usePhone();

  const dates = range(period, from, to);
  const incomplete = period === 'custom' && (!dates.start || !dates.end);
  const badRange = period === 'custom' && ((!!from && !dates.start) || (!!to && !dates.end)
    || (!!dates.start && !!dates.end && dates.start > dates.end));

  // Reloaded when the period changes. The state changes only when the answer arrives; an answer that arrives after
  // the period changed again is dropped.
  const { start, end } = dates;
  const blocked = incomplete || badRange;
  useEffect(() => {
    if (blocked) return;
    let current = true;
    reportSummary({ start, end })
      .then((d) => { if (current) { setData(d); setError(null); } })
      .catch((e) => { if (current) setError(e instanceof Error ? e.message : 'Não foi possível carregar.'); });
    return () => { current = false; };
  }, [start, end, blocked]);

  function exportZip() {
    saveFile(reportExportUrl(dates), 'Salvar relatório').catch(() => setError('Não foi possível baixar o relatório.'));
  }

  const p = data?.public;
  return (
    <View style={{ gap: 24, maxWidth: 1080 }}>
      <PageHeader crumbs={[{ label: 'Visão geral', href: '/painel' }, { label: 'Registros' }]} title="Registros"
                  subtitle="O que aconteceu no sistema, o uso da busca pública e a exportação para a conformidade com a LGPD." />

      {/* The alerts first, before the numbers (warnings at the top of the page). */}
      {!!data?.alerts_total && (
        <Notice tone="warning" icon={ShieldAlert}
                title={`${data.alerts_total} ${data.alerts_total === 1 ? 'alerta' : 'alertas'} de uso atípico no período`}
                description="O bloqueio é automático. Veja abaixo quando aconteceu e em qual evento." />
      )}
      {error && <Notice tone="danger" icon={TriangleAlert} title={error} />}
      {badRange && <Notice tone="warning" icon={TriangleAlert} title="Confira as datas: use dd/mm/aaaa, e a data inicial não pode ser depois da final." />}

      <Card padding={20}>
        <View style={styles.controls}>
          <Field label="Período" style={{ width: phone ? '100%' : 240 }}>
            <Select placeholder="Último mês" options={[...PERIODS]} value={period} onChange={(v) => setPeriod((v as Period) ?? 'm1')} accessibilityLabel="Período" />
          </Field>
          {period === 'custom' && (
            <View style={styles.dates}>
              <Field label="De" style={{ width: 150 }}>
                <Input value={from} onChangeText={(t) => setFrom(maskDay(t))} placeholder="dd/mm/aaaa" inputMode="numeric"
                       maxLength={10} accessibilityLabel="Data inicial (dd/mm/aaaa)" invalid={!!from && !dates.start} />
              </Field>
              <Field label="Até" style={{ width: 150 }}>
                <Input value={to} onChangeText={(t) => setTo(maskDay(t))} placeholder="dd/mm/aaaa" inputMode="numeric"
                       maxLength={10} accessibilityLabel="Data final (dd/mm/aaaa)" invalid={!!to && !dates.end} />
              </Field>
            </View>
          )}
          <View style={[{ paddingTop: phone ? 0 : 24 }, phone && { width: '100%' }]}>
            <Button icon={Download} label="Exportar relatório (ZIP)" disabled={incomplete || badRange || !data} onPress={exportZip} />
          </View>
        </View>
        {data && (
          <Text style={styles.help}>
            {data.start === '2026-01-01' ? 'Desde o início' : `De ${br(data.start)}`} até {br(data.end)}. O relatório traz uma planilha
            para cada tipo de registro: operações, consultas e autorizações das pessoas institucionais, ciência dos visitantes,
            downloads para divulgação, buscas públicas por dia e alertas de uso atípico.
          </Text>
        )}
      </Card>

      {!data && !error && <Card><ActivityIndicator color={panel.primary} /></Card>}
      {data && p && (
        <>
          <View style={styles.grid}>
            <Stat value={data.operations} label="Operações registradas" />
            <Stat value={p.searches} label="Buscas públicas" detail={`${n(p.found)} com resultado · ${n(p.no_result)} sem resultado`} />
            <Stat value={p.liveness_refused} label="Provas de vida reprovadas"
                  detail={`Inclui capturas encerradas por movimentos errados${p.other_refused ? ` · ${n(p.other_refused)} outras recusas (sem rosto, qualidade)` : ''}`} />
            <Stat value={p.downloads} label="Downloads de visitantes" />
            <Stat value={data.consents} label="Ciências registradas" detail="Aviso de uso de imagem aceito antes da busca" />
            <Stat value={data.institutional_queries} label="Consultas institucionais" />
            <Stat value={data.authorizations.authorized} label="Autorizações institucionais"
                  detail={`${n(data.authorizations.revoked)} ${data.authorizations.revoked === 1 ? 'revogação' : 'revogações'}`} />
            <Stat value={data.publicity_downloads} label="Downloads para divulgação" detail="Marketing, mídias de outros autores" />
          </View>

          <View style={{ gap: 10 }}>
            <Text style={styles.section}>Uso atípico da busca pública</Text>
            <Text style={styles.help}>
              O sistema avisa quando um mesmo endereço faz buscas demais (e é bloqueado pelo limite) ou erra a prova de vida
              várias vezes seguidas, o que pode ser alguém tentando com foto ou tela. O endereço não é gravado.
            </Text>
            {data.alerts.length === 0 ? (
              <Card padding={16}><Text style={styles.cell}>Nenhum alerta no período.</Text></Card>
            ) : (
              <View style={styles.table} role="list">
                {data.alerts.map((a, i) => (
                  <View key={`${a.at}-${i}`} role="listitem" style={[styles.row, i > 0 && styles.rowBorder]}>
                    <Text style={[styles.cell, { width: phone ? '100%' : 150 }]}>{when(a.at)}</Text>
                    <View style={{ flex: 1, minWidth: 200 }}>
                      <Text style={styles.strong}>{a.label}</Text>
                      <Text style={styles.cell}>
                        {a.kind === 'searches' ? `Mais de ${a.count} buscas em ${a.minutes} minutos` : `${a.count} reprovações seguidas em até ${a.minutes} minutos`}
                        {a.event ? ` · ${a.event}` : ''}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            )}
            {data.alerts_total > data.alerts.length && (
              <Text style={styles.help}>Mostrando os {data.alerts.length} mais recentes. Todos estão no relatório exportado.</Text>
            )}
          </View>

          <Notice tone="info" icon={ShieldCheck} title="O que o relatório não traz"
                  description="Nenhum dado pessoal de visitante, nenhuma imagem, quadro da câmera ou vetor facial. As planilhas têm nomes e e-mails da equipe e das pessoas institucionais, e o IP de quem assinou o termo (prova da assinatura): guarde o arquivo com o mesmo cuidado do sistema. Cada exportação também fica registrada." />
        </>
      )}
    </View>
  );
}

function Stat({ value, label, detail }: { value: number; label: string; detail?: string }) {
  return (
    <View style={styles.stat} accessible accessibilityLabel={`${label}: ${n(value)}${detail ? `. ${detail}` : ''}`}>
      <Text style={styles.statValue}>{n(value)}</Text>
      <Text style={styles.statLabel}>{label}</Text>
      {detail && <Text style={styles.statDetail}>{detail}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  controls: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: 12 },
  dates: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  help: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 20, color: panel.muted, marginTop: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  stat: { flexGrow: 1, flexBasis: 220, minWidth: 0, backgroundColor: panel.surface, borderWidth: 1, borderColor: panel.border,
          borderRadius: panel.cardRadius, padding: 16, gap: 4 },
  statValue: { fontFamily: fonts.bold, fontSize: 26, color: panel.text },
  statLabel: { fontFamily: fonts.bold, fontSize: 14, color: panel.text },
  statDetail: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: panel.muted },
  section: { fontFamily: fonts.bold, fontSize: 18, color: panel.text },
  table: { borderWidth: 1, borderColor: panel.border, borderRadius: panel.cardRadius, overflow: 'hidden', backgroundColor: panel.surface },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  rowBorder: { borderTopWidth: 1, borderColor: panel.borderSoft },
  cell: { fontFamily: fonts.regular, fontSize: 14, color: panel.muted },
  strong: { fontFamily: fonts.bold, fontSize: 14, color: panel.text },
});
