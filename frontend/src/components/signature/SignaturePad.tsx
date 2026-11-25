import { Text } from 'react-native';

/** Native placeholder: signing happens on the web page (SignaturePad.web.tsx). */
export function SignaturePad(_: { onChange: (png: string | null) => void; clearSignal: number; ink?: string; border?: string; surface?: string; label?: string }) {
  return <Text>Abra o link num navegador para assinar.</Text>;
}
