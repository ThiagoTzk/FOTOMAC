import { TriangleAlert } from 'lucide-react-native';

import type { EventItem } from '@/api/events';
import { Notice } from '@/components/panel/ui';

/** The event's responsible ended this photographer's access: the same notice in Visão geral, Imagens and
 *  Configuração (28/10/2026), so it is seen wherever the person arrives. */
export function AccessEnded({ event }: { event: EventItem }) {
  if (!event.access_blocked) return null;
  return (
    <Notice tone="warning" icon={TriangleAlert} title="Seu acesso a este evento foi encerrado"
            description={`${event.owner.full_name}, responsável pelo evento, encerrou o seu acesso. As fotos que você enviou continuam no acervo, com o seu crédito; você só não envia nem altera mais nada aqui.`} />
  );
}
