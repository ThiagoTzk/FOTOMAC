import { reloadAppAsync } from 'expo';
import { Alert, DevSettings, Platform } from 'react-native';

/**
 * Restarts the app so a new screen preference (light/dark mode, accessibility) takes effect (08/11/2026). The choice
 * is already saved, so opening the app again applies it too.
 *
 * Which reload depends on where it runs:
 * - iPhone: only Expo's reloadAppAsync. React Native's DevSettings.reload brought back the JavaScript WITHOUT Expo's
 *   native modules in Expo Go ("Cannot find native module 'ExpoAsset'") and the app did not start.
 * - Android in development (Expo Go): reloadAppAsync did nothing there, so React Native's own reload.
 * - Android installed app: reloadAppAsync.
 */
export function restartApp(reason: string): void {
  if (Platform.OS === 'android' && __DEV__) DevSettings.reload(reason);
  else reloadAppAsync(reason).catch(() => undefined);
  // A reload that worked ends this JavaScript before the timer fires; still here means it did not happen.
  setTimeout(() => {
    Alert.alert('Feche e abra o app', 'Sua escolha foi salva. Feche o FOTOMAC e abra de novo para aplicar.');
  }, 2500);
}
