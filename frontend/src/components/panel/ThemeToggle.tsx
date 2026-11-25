import { Moon, Sun } from 'lucide-react-native';
import { Pressable, StyleSheet } from 'react-native';

import { panel } from '@/theme/tokens';
import { setMode, useMode } from '@/theme/mode';

/** Beside the bell: the sun turns the light mode on, the moon the dark one (saved in this browser, or in the phone). */
export function ThemeToggle() {
  const mode = useMode();
  const dark = mode === 'dark';
  const Icon = dark ? Sun : Moon;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={dark ? 'Usar o modo claro' : 'Usar o modo escuro'}
               onPress={() => setMode(dark ? 'light' : 'dark')}
               style={({ hovered }: any) => [styles.round, hovered && { borderColor: panel.primary }]}>
      <Icon size={18} color={panel.navText} strokeWidth={1.6} absoluteStrokeWidth />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  round: { width: 38, height: 38, borderRadius: 999, backgroundColor: panel.page, borderWidth: 1, borderColor: 'transparent',
           alignItems: 'center', justifyContent: 'center' },
});
