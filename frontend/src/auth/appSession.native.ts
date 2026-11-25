import * as SecureStore from 'expo-secure-store';

/**
 * The app's login session (06/11/2026). The site keeps it in an HttpOnly cookie; the app has no browser cookies, so
 * the server gives it the token and the app sends it as "Authorization: Bearer".
 *
 * Mirror of the site's rule "fechar o navegador desconecta": without "Manter conectado" the token lives only in
 * memory, and closing the app logs out. With it, the token goes to the phone's own safe (Keychain on the iPhone,
 * Keystore on Android), encrypted by the system and readable only by this app (LGPD Art. 46: security measures).
 */
const KEY = 'fotomac.session';

export async function storedToken(): Promise<string | null> {
  try { return await SecureStore.getItemAsync(KEY); } catch { return null; }
}

export async function keepToken(token: string | null, remember: boolean): Promise<void> {
  try {
    if (token && remember) await SecureStore.setItemAsync(KEY, token, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    else await SecureStore.deleteItemAsync(KEY);
  } catch { /* the safe is unavailable: the session stays only in memory */ }
}
