import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { CREDITS } from '@/components/credits';
import { VisitorHeader } from '@/components/visitor/Header';
import { Column, useJustified, useWide, vtext } from '@/components/visitor/ui';
import { PageBand, WebPage, Wrap } from '@/components/visitor/web/Site';
import { visitor } from '@/theme/tokens';

/**
 * Créditos of the public site (17/11/2026): reachable from the site's footer and the phone's menu. The panel has
 * the same content in its own page, "Sobre" ((painel)/sobre.tsx).
 */
export default function CreditsPage() {
  if (useWide()) {
    return (
      <WebPage>
        <PageBand crumbs={[{ label: 'Créditos' }]} title="Créditos" sub={CREDITS.sub} />
        <Wrap style={{ paddingVertical: 48 }}>
          <View style={styles.card}><Credits /></View>
        </Wrap>
      </WebPage>
    );
  }
  return (
    <ScrollView style={styles.page} contentContainerStyle={{ paddingBottom: 48 }}>
      <VisitorHeader back />
      <Column narrow style={{ gap: 20, marginTop: 24 }}>
        <View style={{ gap: 6 }}>
          <Text style={vtext.h1} accessibilityRole="header">Créditos</Text>
          <Text style={vtext.body}>{CREDITS.sub}</Text>
        </View>
        <Credits />
      </Column>
    </ScrollView>
  );
}

/** The same content on the phone, in the app and on the computer. */
function Credits() {
  const justified = useJustified();
  return (
    <>
      <View style={{ gap: 6 }}>
        <Text style={vtext.h3}>Sobre o projeto</Text>
        {CREDITS.about.map((t) => <Text key={t} style={[vtext.body, justified]}>{t}</Text>)}
      </View>

      <View style={{ gap: 12 }}>
        <Text style={vtext.h3}>Equipe do projeto</Text>
        <View style={styles.people}>
          {CREDITS.people.map((p) => (
            <View key={p.role} style={styles.person}>
              <Text style={styles.role}>{p.role}</Text>
              <Text style={vtext.label}>{p.name}</Text>
              <Text style={vtext.small}>{p.about}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={{ gap: 6 }}>
        <Text style={vtext.h3}>Instituição</Text>
        <Text style={vtext.body}>{CREDITS.institution.join('\n')}</Text>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: visitor.page },
  card: { width: '100%', maxWidth: 860, alignSelf: 'center', backgroundColor: visitor.surface, borderRadius: 16, paddingVertical: 40,
          paddingHorizontal: 48, gap: 28, boxShadow: visitor.cardShadow },
  people: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  // Two per row on a wide card, one per row on the phone; a long name breaks inside its box (never widens it).
  person: { flexGrow: 1, flexBasis: 300, minWidth: 0, maxWidth: '100%', gap: 4, padding: 16, borderRadius: 12,
            borderWidth: 1, borderColor: visitor.cardBorder, backgroundColor: visitor.surface },
  role: { fontFamily: vtext.small.fontFamily, fontSize: 12, color: visitor.primary, textTransform: 'uppercase', letterSpacing: 0.5 },
});
