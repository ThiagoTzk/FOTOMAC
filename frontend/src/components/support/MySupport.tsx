import { useFocusEffect } from 'expo-router';
import { CircleCheck } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { mySupport, type SupportKind, type SupportMessage } from '@/api/support';
import { Notice, Tabs } from '@/components/panel/ui';
import { panel } from '@/theme/tokens';

import { Conversation, NoConversations } from './Conversation';
import { SupportForm } from './SupportForm';

const POLL_MS = 20000;   // a reply of the administration shows up without reloading the page

type Part = 'messages' | 'new';

/**
 * The person's side (Support page, and the restricted page of a blocked account). Two parts since 31/10/2026:
 * "Nova mensagem", the form (opens first), and "Mensagens", only the conversations; before, the conversations piled
 * up under the form and the page kept growing. The Support page gives it a new key for each conversation opened from the bell,
 * so that one opens even when "Nova mensagem" was on screen.
 */
export function MySupport({ openId, initialKind, initialSubject, formTitle }: {
  openId?: string; initialKind?: SupportKind; initialSubject?: string; formTitle?: string;
}) {
  const [mine, setMine] = useState<SupportMessage[] | null>(null);
  // null = not chosen yet: the form ("Nova mensagem" first, 01/11/2026), or the conversation opened from the bell.
  const [chosen, setChosen] = useState<Part | null>(null);
  const [sent, setSent] = useState(false);
  const load = useCallback(() => { mySupport().then(setMine).catch(() => setMine((m) => m ?? [])); }, []);
  useFocusEffect(load);
  useEffect(() => {
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);
  // A notice of the bell opens its conversation even when this page is already open (the key changes, so the
  // card starts again, open).
  const update = useCallback((next: SupportMessage) => setMine((list) => list?.map((x) => (x.id === next.id ? next : x)) ?? null), []);

  if (!mine) return <ActivityIndicator color={panel.primary} />;
  const part: Part = chosen ?? (openId ? 'messages' : 'new');
  const unread = mine.filter((m) => m.unread).length;
  return (
    <View style={{ gap: 18 }}>
      <Tabs tabs={[{ key: 'new', label: 'Nova mensagem' },
                   { key: 'messages', label: `Mensagens (${mine.length})${unread ? ` · ${unread} com novidade` : ''}` }]}
            value={part} onChange={(p) => { setSent(false); setChosen(p); }} />
      {sent && part === 'messages' && (
        <Notice tone="success" icon={CircleCheck} title="Mensagem enviada. As respostas aparecem aqui e no sino." />
      )}
      {part === 'new' ? (
        <SupportForm onSent={() => { load(); setSent(true); setChosen('messages'); }} initialKind={initialKind} initialSubject={initialSubject}
                     title={formTitle} />
      ) : mine.length === 0 ? (
        <NoConversations text='Você ainda não enviou nenhuma mensagem. Para escrever, abra "Nova mensagem".' />
      ) : (
        mine.map((m) => <Conversation key={m.id === openId ? `${m.id}:aberta` : m.id} m={m} admin={false} initiallyOpen={m.id === openId} onChange={update} />)
      )}
    </View>
  );
}
