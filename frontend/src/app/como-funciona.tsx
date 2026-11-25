import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { VisitorHeader } from '@/components/visitor/Header';
import { Column, useWide, VButton, vtext } from '@/components/visitor/ui';
import { HowItWorks, PrivacyBand } from '@/components/visitor/web/Home';
import { PageBand, WebPage, Wrap } from '@/components/visitor/web/Site';
import { visitor } from '@/theme/tokens';

const SUB = 'Três passos, sem criar conta: escolha o evento, mostre o rosto e baixe só as fotos em que você aparece.';

/** "Como funciona" as a page of its own in the site's menu (24/10/2026), no longer a section of the home. */
export default function HowItWorksPage() {
  if (useWide()) {
    return (
      <WebPage>
        <PageBand crumbs={[{ label: 'Como funciona' }]} title="Como funciona" sub={SUB} />
        <Wrap style={{ paddingVertical: 56, gap: 40 }}>
          <HowItWorks bare />
          <View style={{ alignItems: 'flex-start' }}>
            <VButton label="Ver os eventos" onPress={() => router.navigate('/explorar')} />
          </View>
        </Wrap>
        <PrivacyBand />
      </WebPage>
    );
  }
  return (
    <ScrollView style={styles.page} contentContainerStyle={{ paddingBottom: 48 }}>
      <VisitorHeader back />
      <Column narrow style={{ gap: 20, marginTop: 24 }}>
        <View style={{ gap: 6 }}>
          <Text style={vtext.h1} accessibilityRole="header">Como funciona</Text>
          <Text style={vtext.body}>{SUB}</Text>
        </View>
        <HowItWorks stacked bare />
        <VButton label="Ver os eventos" onPress={() => router.navigate('/explorar')} />
      </Column>
    </ScrollView>
  );
}

const styles = StyleSheet.create({ page: { flex: 1, backgroundColor: visitor.page } });
