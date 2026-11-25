import { StyleSheet, Text, View } from 'react-native';

import { SignatureInput, type SignatureValue } from '@/components/signature/SignatureInput';
import { poppins, visitor } from '@/theme/tokens';

/**
 * "Sua assinatura" of the institutional person's terms (authorize, revoke, new e-mail): typed in a
 * handwriting font, drawn, or a rubrica — the person chooses (24/10/2026). Every one is valid.
 */
export function SignBox({ name, onChange }: { name: string; onChange: (value: SignatureValue | null) => void }) {
  return (
    <View style={{ gap: 10 }}>
      <Text style={styles.label}>Sua assinatura</Text>
      <SignatureInput name={name} onChange={onChange}
                      theme={{ primary: visitor.primary, text: visitor.heading, muted: visitor.muted, border: visitor.cardBorder,
                               surface: visitor.surface, soft: 'rgba(0, 125, 197, 0.08)', font: poppins.regular }} />
    </View>
  );
}

const styles = StyleSheet.create({ label: { fontFamily: poppins.semiBold, fontSize: 15, color: visitor.heading } });
