import {
  Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold, useFonts,
} from '@expo-google-fonts/inter';
import { Montserrat_400Regular, Montserrat_800ExtraBold } from '@expo-google-fonts/montserrat';
import { Poppins_400Regular, Poppins_500Medium, Poppins_600SemiBold, Poppins_700Bold } from '@expo-google-fonts/poppins';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AuthProvider, useAuth } from '@/auth/AuthContext';
import { markUse } from '@/auth/idle';
import { DocumentTitle } from '@/components/DocumentTitle';
import { IdleGuard } from '@/components/auth/IdleGuard';
import { AccessibilityMenu } from '@/components/panel/AccessibilityMenu';
import { VideoProgress } from '@/components/panel/VideoProgress';
import { installAccessibility } from '@/theme/accessibility';
import { installKeyboard } from '@/theme/keyboard';
import { installTheme, useMode } from '@/theme/mode';
import { visitor } from '@/theme/tokens';
import { clearSavedFiles } from '@/ui/saveFile';
import { clearPickedCopies } from '@/components/panel/files';

SplashScreen.preventAutoHideAsync();
// Light/dark palettes and the mode saved in this browser, before anything is drawn.
installTheme();
// The accessibility choices saved in this browser (text size, bold, contrast…), also before the first screen.
installAccessibility();
// Enter on links and Tab kept inside an open window (see theme/keyboard.ts).
installKeyboard();
// The app: downloads, and copies of photos chosen to send, left from a previous run are deleted at start
// (ui/saveFile.native.ts, components/panel/files.native.ts).
clearSavedFiles();
clearPickedCopies();

function RootStack() {
  const { loading, account } = useAuth();
  const [fontsLoaded] = useFonts({
    Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold, Montserrat_400Regular,
    Montserrat_800ExtraBold, Poppins_400Regular, Poppins_500Medium, Poppins_600SemiBold, Poppins_700Bold,
  });
  const ready = fontsLoaded && !loading;
  // The app (06/11/2026): the screens start below the phone's status bar and end above its gesture bar, like any
  // app; the site has neither.
  const insets = useSafeAreaInsets();
  const mode = useMode();
  const safe = Platform.OS === 'web' ? undefined : { paddingTop: insets.top, paddingBottom: insets.bottom, backgroundColor: visitor.surface };

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  const stack = (
    <Stack screenOptions={{ headerShown: false, contentStyle: safe }}>
      {/* Visitor area: public, no account. */}
      <Stack.Screen name="index" options={{ title: 'FOTOMAC - Início' }} />
      <Stack.Screen name="explorar" options={{ title: 'FOTOMAC - Eventos' }} />
      <Stack.Screen name="evento/[id]" options={{ title: 'FOTOMAC - Evento' }} />
      <Stack.Screen name="como-funciona" options={{ title: 'FOTOMAC - Como funciona' }} />
      <Stack.Screen name="privacidade" options={{ title: 'FOTOMAC - Política de Privacidade' }} />
      <Stack.Screen name="creditos" options={{ title: 'FOTOMAC - Créditos' }} />
      {/* Staff entry. Someone already logged in is sent to the panel (see each screen). */}
      <Stack.Screen name="login" options={{ title: 'FOTOMAC - Entrar' }} />
      <Stack.Screen name="recuperar-senha" options={{ title: 'FOTOMAC - Recuperar senha' }} />
      {/* Guarded in (painel)/_layout.tsx, which redirects to /login (not to the visitor home). */}
      <Stack.Screen name="(painel)" options={{ title: 'FOTOMAC - Painel' }} />
      {/* Reached from e-mail links: open whether or not someone is logged in. */}
      <Stack.Screen name="redefinir-senha" options={{ title: 'FOTOMAC - Definir nova senha' }} />
      <Stack.Screen name="primeiro-acesso" options={{ title: 'FOTOMAC - Primeiro acesso' }} />
      <Stack.Screen name="autorizacao/index" options={{ title: 'FOTOMAC - Autorização de uso de imagem' }} />
      <Stack.Screen name="autorizacao/revogar" options={{ title: 'FOTOMAC - Revogar autorização' }} />
      <Stack.Screen name="autorizacao/email" options={{ title: 'FOTOMAC - Confirmar novo e-mail' }} />
    </Stack>
  );

  // Screens only decide what the INTERFACE shows. The real protection is the API, which
  // refuses any request without a valid session.
  return (
    <>
    {/* The phone's status bar: dark letters on the light mode, light letters on the dark one. */}
    {Platform.OS !== 'web' && <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />}
    {/* Ends a session left without use (not with "Manter conectado"); asks "Você ainda está aí?" first. */}
    <IdleGuard />
    <DocumentTitle />
    {/* The accessibility window, once for the whole site; the buttons in the headers only open it. */}
    <AccessibilityMenu />
    {/* The count of the videos on their way, also once: sending goes on while the person works in other pages. */}
    <VideoProgress />
    {/* The app: a touch anywhere is use of the system, for the inactivity limit (the site listens to the mouse).
        Only with an account logged in: a visitor has no session, and telling the server about their taps would be a
        request about a person for nothing (08/11/2026). */}
    {Platform.OS === 'web' ? stack : <View style={{ flex: 1 }} onTouchStart={account ? () => markUse() : undefined}>{stack}</View>}
    </>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <RootStack />
    </AuthProvider>
  );
}
