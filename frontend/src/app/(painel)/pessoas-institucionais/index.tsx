import { Image } from '@/ui/Image';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { ChevronRight, IdCard, Search, ShieldCheck, TriangleAlert, Users } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { consultPeople, referencePhotoUrl, type Person } from '@/api/institutional';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/panel/PageHeader';
import { Button, Card, Field, Input, Notice } from '@/components/panel/ui';
import { fonts, panel } from '@/theme/tokens';

/** Lower case, no accents: "Júlia" and "julia" are the same search. */
const plain = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Every word typed must be the START of a word of the name, the role or the unit:
 *  "julia s" finds Julia Silva, "lima" finds Paulo Lima, "coord" finds every coordinator. */
function matches(p: Person, query: string): boolean {
  const words = plain(`${p.full_name} ${p.position} ${p.unit ?? ''}`).split(/[^a-z0-9]+/);
  // The same split on both sides: "pró-reit" is "pro" + "reit", like "Pró-reitora" is "pro" + "reitora".
  return plain(query).split(/[^a-z0-9]+/).filter(Boolean).every((t) => words.some((w) => w.startsWith(t)));
}

/**
 * Institutional people: type the name or the role, the
 * list narrows as you type, and a click opens the person's page with the photos by event. Only people
 * already registered and authorized appear: there is no photo upload to find someone.
 */
export default function InstitutionalConsultation() {
  const { account } = useAuth();
  const { pessoa } = useLocalSearchParams<{ pessoa?: string }>();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    consultPeople().then(setPeople).catch((e) => setError(e.message));
  }, []);

  // Old address (?pessoa=…): the person now has a page of their own.
  if (pessoa) return <Redirect href={`/pessoas-institucionais/${pessoa}`} />;

  const found = (people ?? []).filter((p) => matches(p, query));
  return (
    <View style={{ gap: 20 }}>
      <PageHeader crumbs={[{ label: 'Visão geral', href: '/painel' }, { label: 'Pessoas institucionais' }]} title="Pessoas institucionais"
                  subtitle="Localize imagens de representantes institucionais previamente cadastrados e autorizados."
                  actions={account?.role === 'admin'
                    ? <Button variant="secondary" icon={Users} label="Cadastro de pessoas" onPress={() => router.navigate('/pessoas-institucionais/cadastro')} />
                    : undefined} />
      <Notice tone="info" icon={ShieldCheck} title="Consulta restrita"
              description="Buscas institucionais são restritas a finalidades autorizadas e ficam registradas para auditoria." />
      {error && <Notice tone="danger" icon={TriangleAlert} title={error} />}
      <Card padding={24} style={{ gap: 16 }}>
        <Field label="Buscar pessoa institucional" help="Digite o nome ou o cargo.">
          <Input icon={Search} value={query} onChangeText={setQuery} accessibilityLabel="Buscar pessoa institucional"
                 placeholder="Nome ou cargo" autoFocus
                 onSubmitEditing={() => found.length === 1 && router.navigate(`/pessoas-institucionais/${found[0].id}`)} />
        </Field>
        {!people && !error && <ActivityIndicator color={panel.primary} />}
        {people && people.length === 0 && (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}><IdCard size={26} color={panel.primary} strokeWidth={1.6} absoluteStrokeWidth /></View>
            <Text style={styles.text}>Nenhuma pessoa autorizada ainda. Não é possível cadastrar pessoas nesta área.</Text>
          </View>
        )}
        {people && people.length > 0 && found.length === 0 && (
          <Text style={styles.text}>Ninguém encontrado com “{query.trim()}”.</Text>
        )}
        {found.length > 0 && (
          <View style={styles.list} role="list">
            {found.map((p) => (
              <View key={p.id} role="listitem">
              <Pressable accessibilityRole="link" accessibilityLabel={`${p.full_name}, ${p.position}`}
                         onPress={() => router.navigate(`/pessoas-institucionais/${p.id}`)}
                         style={({ hovered }: any) => [styles.row, hovered && { backgroundColor: panel.page }]}>
                {p.photo_id ? (
                  <Image source={{ uri: referencePhotoUrl(p.id, p.photo_id, true) }} style={styles.avatar} contentFit="cover"
                         accessibilityLabel={`Foto de referência de ${p.full_name}`} />
                ) : (
                  <View style={styles.avatar}><Text style={styles.initials}>{initials(p.full_name)}</Text></View>
                )}
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.name} numberOfLines={1}>{p.full_name}</Text>
                  <Text style={styles.cell} numberOfLines={1}>{p.position}{p.unit ? ` · ${p.unit}` : ''}</Text>
                </View>
                <ChevronRight size={18} color={panel.muted} strokeWidth={1.6} absoluteStrokeWidth />
              </Pressable>
              </View>
            ))}
          </View>
        )}
      </Card>
    </View>
  );
}

/** Initials when the person has no reference photo to show. */
const initials = (name: string) => {
  const parts = name.trim().split(/\s+/);
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
};

const styles = StyleSheet.create({
  empty: { alignItems: 'center', gap: 10, paddingVertical: 12 },
  emptyIcon: { width: 56, height: 56, borderRadius: 999, backgroundColor: panel.primarySoft, alignItems: 'center', justifyContent: 'center' },
  text: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: panel.muted },
  list: { borderWidth: 1, borderColor: panel.border, borderRadius: panel.radius, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12,
         borderTopWidth: 1, borderColor: panel.borderSoft, backgroundColor: panel.surface },
  avatar: { width: 44, height: 44, borderRadius: 999, backgroundColor: panel.primarySoft, alignItems: 'center', justifyContent: 'center' },
  initials: { fontFamily: fonts.bold, fontSize: 14, color: panel.primaryText },
  name: { fontFamily: fonts.semiBold, fontSize: 15, color: panel.text },
  cell: { fontFamily: fonts.regular, fontSize: 13, color: panel.muted },
});
