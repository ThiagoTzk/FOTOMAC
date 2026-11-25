import { Alert, Platform } from 'react-native';

/**
 * "Sair mesmo assim?" in the site and in the app (06/11/2026): the browser's own confirm window, or the phone's alert
 * with "Cancelar" and "Continuar". Resolves true only when the person confirms.
 */
export function confirmAsync(message: string, confirmLabel = 'Continuar'): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(typeof window !== 'undefined' && window.confirm(message));
  return new Promise((resolve) => {
    Alert.alert('FOTOMAC', message, [
      { text: 'Cancelar', style: 'cancel', onPress: () => resolve(false) },
      { text: confirmLabel, style: 'destructive', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}
