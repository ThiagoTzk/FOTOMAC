import { StyleSheet, Text, View } from 'react-native';

import { CREDITS } from '@/components/credits';
import { PageHeader } from '@/components/panel/PageHeader';
import { Card } from '@/components/panel/ui';
import { fonts, panel } from '@/theme/tokens';

/**
 * "Sobre" of the panel (17/11/2026): the credits inside the staff area, with its sidebar and header, so nobody is
 * taken out of the panel to read them. Same content as the public page /creditos (components/credits.ts).
 */
export default function AboutPage() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Visão geral', href: '/painel' }, { label: 'Sobre' }]} title="Sobre o FOTOMAC" subtitle={CREDITS.sub} />
      <Card padding={24} style={{ gap: 24, maxWidth: 960 }}>
        <View style={{ gap: 8 }}>
          <Text style={styles.h}>Sobre o projeto</Text>
          {CREDITS.about.map((t) => <Text key={t} style={styles.body}>{t}</Text>)}
        </View>

        <View style={{ gap: 12 }}>
          <Text style={styles.h}>Créditos</Text>
          <View style={styles.people}>
            {CREDITS.people.map((p) => (
              <View key={p.role} style={styles.person}>
                <Text style={styles.role}>{p.role}</Text>
                <Text style={styles.name}>{p.name}</Text>
                <Text style={styles.small}>{p.about}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={{ gap: 8 }}>
          <Text style={styles.h}>Instituição</Text>
          <Text style={styles.body}>{CREDITS.institution.join('\n')}</Text>
        </View>
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  h: { fontFamily: fonts.semiBold, fontSize: 16, color: panel.text },
  body: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 21, color: panel.text },
  people: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  // Two per row on a computer (three left the fourth alone on its row), one per row on the phone.
  person: { flexGrow: 1, flexBasis: 340, minWidth: 0, maxWidth: '100%', gap: 4, padding: 16, borderRadius: 10,
            borderWidth: 1, borderColor: panel.border },
  role: { fontFamily: fonts.semiBold, fontSize: 12, color: panel.primaryText, textTransform: 'uppercase', letterSpacing: 0.5 },
  name: { fontFamily: fonts.semiBold, fontSize: 14, color: panel.text },
  small: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 18, color: panel.muted },
});
