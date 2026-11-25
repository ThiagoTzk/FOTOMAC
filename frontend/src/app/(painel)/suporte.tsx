import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { LifeBuoy, ShieldCheck, TriangleAlert } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { allSupport, type InboxFilter, type SupportMessage } from '@/api/support';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/panel/PageHeader';
import { Notice, Tabs } from '@/components/panel/ui';
import { Conversation, NoConversations } from '@/components/support/Conversation';
import { MySupport } from '@/components/support/MySupport';
import { panel } from '@/theme/tokens';

const FILTERS: { key: InboxFilter; label: string }[] = [
  { key: 'active', label: 'Em andamento' }, { key: 'open', label: 'Abertas' }, { key: 'analyzing', label: 'Em análise' },
  { key: 'fixing', label: 'Em correção' }, { key: 'resolved', label: 'Resolvidas' }, { key: 'all', label: 'Todas' },
];
const POLL_MS = 20000;

/** The administration: every conversation, the newest activity first; reply, and move it until it is solved. */
function AdminInbox({ openId }: { openId?: string }) {
  const [filter, setFilter] = useState<InboxFilter>('active');
  const [items, setItems] = useState<SupportMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    allSupport(filter).then((list) => { setItems(list); setError(null); }).catch((e) => setError(e.message));
  }, [filter]);
  useFocusEffect(load);
  useEffect(() => {
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);
  // A status change may take the conversation out of the current tab: the list is asked again.
  const update = useCallback((next: SupportMessage) => {
    setItems((list) => list?.map((x) => (x.id === next.id ? next : x)) ?? null);
    load();
  }, [load]);

  return (
    <>
      <Tabs tabs={FILTERS} value={filter} onChange={(k) => { setItems(null); setFilter(k); }} />
      {error && <Notice tone="danger" icon={TriangleAlert} title={error} />}
      {!items && !error && <ActivityIndicator color={panel.primary} />}
      {items?.length === 0 && <NoConversations text={filter === 'active' ? 'Nenhuma conversa em andamento.' : 'Nenhuma conversa aqui.'} />}
      {items?.map((m) => <Conversation key={m.id === openId ? `${m.id}:aberta` : m.id} m={m} admin initiallyOpen={m.id === openId} onChange={update} />)}
    </>
  );
}

/**
 * The notice comes first (31/10/2026: what matters never sits at the end of a long list).
 *
 * Support page (28/10/2026; a conversation since 31/10/2026): a photographer, the marketing team or a hired photographer
 * reports a problem, a suggestion or a question; the administration answers, moves it through "Em análise" and
 * "Em correção", and both sides keep talking until it is "Resolvida".
 */
export default function SupportScreen() {
  const { account } = useAuth();
  const { conversa } = useLocalSearchParams<{ conversa?: string }>();
  if (!account) return null;
  const admin = account.role === 'admin';
  return (
    <View style={{ gap: 18 }}>
      <PageHeader crumbs={[{ label: 'Visão geral', href: '/painel' }, { label: 'Suporte' }]} title="Suporte"
                  subtitle={admin ? 'Problemas, sugestões, dúvidas e pedidos de acesso enviados pela equipe.'
                    : 'Algo não funcionou ou poderia ser melhor? Converse com a administração do FOTOMAC.'} />
      <Notice tone="info" icon={admin ? ShieldCheck : LifeBuoy} title={admin ? 'Uso restrito' : 'Como funciona'}
              description={admin
                ? 'As mensagens podem conter dados de quem escreveu: use-as só para resolver o pedido. As conversas resolvidas são apagadas depois de 3 meses.'
                : 'A administração recebe a mensagem com o seu nome e e-mail. Cada resposta e cada mudança de situação (Em análise, Em correção, Resolvida) chega no sino.'} />
      {admin ? <AdminInbox openId={conversa} /> : <MySupport key={conversa ?? ''} openId={conversa} />}
    </View>
  );
}
