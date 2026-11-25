import { router, useFocusEffect } from 'expo-router';
import { ChevronLeft, ChevronRight, SearchX } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { listEvents, type EventFilters as Filters, type EventPage } from '@/api/events';
import { useAuth } from '@/auth/AuthContext';
import { EventFilters } from '@/components/panel/EventFilters';
import { EventsTable } from '@/components/panel/EventsTable';
import { PageHeader } from '@/components/panel/PageHeader';
import { Button, Card } from '@/components/panel/ui';
import { fonts, panel } from '@/theme/tokens';

/** The page numbers to show: all of them up to 7, otherwise the first, the last and the ones around the current. */
function pageNumbers(page: number, pages: number): (number | '…')[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const around = [page - 1, page, page + 1].filter((n) => n > 1 && n < pages);
  const out: (number | '…')[] = [1];
  if (around[0] > 2) out.push('…');
  out.push(...around);
  if (around[around.length - 1] < pages - 1) out.push('…');
  out.push(pages);
  return out;
}

/** The list of events (with its empty-result variation). Ten per page, the newest event first (01/11/2026). */
export default function EventsScreen() {
  const { account } = useAuth();
  const [filters, setFilters] = useState<Filters>({ scope: 'all', page: 1 });
  const [data, setData] = useState<EventPage | null>(null);

  useFocusEffect(useCallback(() => {
    listEvents(filters).then(setData).catch(() => setData({ items: [], total: 0, page: 1, page_size: 10 }));
  }, [filters]));

  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  const page = filters.page ?? 1;
  return (
    <>
      <PageHeader crumbs={[{ label: 'Visão geral', href: '/painel' }, { label: 'Eventos' }]} title="Eventos" subtitle="Gerencie os eventos e seus respectivos acervos fotográficos."
                  actions={account?.role !== 'contractor'  // a temporary account does not create events
                    ? <Button label="+ Novo evento" onPress={() => router.navigate('/eventos/novo')} /> : undefined} />
      <Card style={{ zIndex: 10 }}>
        <EventFilters value={filters} onChange={setFilters} />
        {!data && <ActivityIndicator color={panel.primary} />}
        {data && data.items.length > 0 && (
          <>
            <EventsTable events={data.items} />
            <View style={styles.pager}>
              <Text style={styles.muted}>
                {pages > 1 ? `Eventos ${(page - 1) * data.page_size + 1} a ${(page - 1) * data.page_size + data.items.length} de ${data.total}`
                  : `${data.total} ${data.total === 1 ? 'evento' : 'eventos'}`}
              </Text>
              {pages > 1 && (
                <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center', flexWrap: 'wrap' }} role="navigation" aria-label="Páginas">
                  <Pressable accessibilityRole="button" accessibilityLabel="Página anterior" disabled={page <= 1} aria-disabled={page <= 1}
                             onPress={() => setFilters({ ...filters, page: page - 1 })} style={styles.pageBtn}>
                    <ChevronLeft size={18} color={page <= 1 ? panel.border : panel.text} />
                  </Pressable>
                  {pageNumbers(page, pages).map((n, i) => n === '…' ? (
                    <Text key={`gap${i}`} style={styles.muted}>…</Text>
                  ) : (
                    <Pressable key={n} accessibilityRole="button" accessibilityLabel={`Página ${n}`} aria-current={n === page ? 'page' : undefined}
                               onPress={() => n !== page && setFilters({ ...filters, page: n })}
                               style={({ hovered }: any) => [styles.pageBtn, n === page ? styles.pageOn : hovered && { backgroundColor: panel.page }]}>
                      <Text style={[styles.pageText, n === page && { color: '#FFFFFF' }]}>{n}</Text>
                    </Pressable>
                  ))}
                  <Pressable accessibilityRole="button" accessibilityLabel="Próxima página" disabled={page >= pages} aria-disabled={page >= pages}
                             onPress={() => setFilters({ ...filters, page: page + 1 })} style={styles.pageBtn}>
                    <ChevronRight size={18} color={page >= pages ? panel.border : panel.text} />
                  </Pressable>
                </View>
              )}
            </View>
          </>
        )}
      </Card>
      {data && data.items.length === 0 && (
        <Card style={styles.empty}>
          <View style={styles.emptyIcon}><SearchX size={24} color={panel.primary} strokeWidth={1.6} absoluteStrokeWidth /></View>
          <View style={{ flex: 1, gap: 4, minWidth: 200 }}>
            <Text style={styles.emptyTitle}>Nenhum evento encontrado</Text>
            <Text style={styles.muted}>Ajuste os filtros ou limpe a busca para ver outros eventos.</Text>
          </View>
          <Button variant="secondary" label="Limpar filtros" onPress={() => setFilters({ scope: 'all', page: 1 })} />
        </Card>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  pager: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  pageBtn: { minWidth: 32, height: 32, paddingHorizontal: 6, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  pageOn: { backgroundColor: panel.action },
  pageText: { fontFamily: fonts.semiBold, fontSize: 14, color: panel.text },
  muted: { fontFamily: fonts.regular, fontSize: 14, color: panel.muted },
  empty: { flexDirection: 'row', alignItems: 'center', gap: 18, flexWrap: 'wrap' },
  emptyIcon: { width: 52, height: 52, borderRadius: 999, backgroundColor: panel.primarySoft, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontFamily: fonts.bold, fontSize: 16, color: panel.text },
});
