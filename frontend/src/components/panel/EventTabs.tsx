import { router } from 'expo-router';

import type { EventItem } from '@/api/events';
import { Tabs } from '@/components/panel/ui';

export type EventTab = 'overview' | 'images' | 'videos' | 'info';

/** "Visão geral · Imagens · Vídeos · Configuração" — the same shortcut on the event overview and on its images
 *  (17/10/2026). The overview tabs live in the URL (?aba=), so coming back from Imagens lands on the
 *  tab that was clicked. "Configuração" (24/10/2026, was "Colaboração"): switches of the event. */
export function EventTabs({ event, value }: { event: EventItem; value: EventTab }) {
  const hideCollaboration = event.relation === 'viewer' || event.relation === 'contractor';
  // An event found in the list that the account does not work on: the summary only (01/11/2026).
  if (event.relation === 'outsider') return <Tabs tabs={[{ key: 'overview' as EventTab, label: 'Visão geral' }]} value="overview" onChange={() => undefined} />;
  const waiting = event.can_manage && event.requests_waiting ? ` (${event.requests_waiting})` : '';
  const go = (k: EventTab) => {
    if (k === value) return;
    if (k === 'images') router.navigate(`/eventos/${event.id}/imagens`);
    else if (k === 'videos') router.navigate(`/eventos/${event.id}/videos`);
    else router.navigate(`/eventos/${event.id}?aba=${k === 'info' ? 'configuracao' : 'geral'}`);
  };
  return (
    <Tabs tabs={[{ key: 'overview', label: 'Visão geral' }, { key: 'images', label: 'Imagens' }, { key: 'videos', label: 'Vídeos' },
                 ...(hideCollaboration ? [] : [{ key: 'info' as const, label: `Configuração${waiting}` }])]}
          value={value} onChange={go} />
  );
}
