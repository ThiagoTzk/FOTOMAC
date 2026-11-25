import { Allura_400Regular } from '@expo-google-fonts/allura';
import { Caveat_500Medium } from '@expo-google-fonts/caveat';
import { DancingScript_500Medium } from '@expo-google-fonts/dancing-script';
import { GreatVibes_400Regular } from '@expo-google-fonts/great-vibes';
import { HomemadeApple_400Regular } from '@expo-google-fonts/homemade-apple';
import { useFonts } from 'expo-font';

/**
 * Handwriting fonts of the typed signature (Google Fonts, SIL Open Font License). They come from npm
 * packages and are served by the site itself: the signing page never calls Google, so the IP of whoever
 * signs is not sent to a third party (LGPD).
 */
export const SIGNATURE_FONTS = [
  { family: 'GreatVibes_400Regular', label: 'Clássica', size: 1 },
  { family: 'DancingScript_500Medium', label: 'Elegante', size: 0.9 },
  { family: 'Allura_400Regular', label: 'Delicada', size: 1.05 },
  { family: 'HomemadeApple_400Regular', label: 'Manuscrita', size: 0.62 },
  { family: 'Caveat_500Medium', label: 'Simples', size: 0.95 },
] as const;

export type SignatureFont = (typeof SIGNATURE_FONTS)[number]['family'];

export function useSignatureFonts(): boolean {
  const [loaded] = useFonts({
    GreatVibes_400Regular, DancingScript_500Medium, Allura_400Regular, HomemadeApple_400Regular, Caveat_500Medium,
  });
  return loaded;
}
