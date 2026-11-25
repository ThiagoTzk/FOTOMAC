import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text } from 'react-native';

import { fonts, panel } from '@/theme/tokens';

/** The id of the main content of the page (role="main"), where "Pular para o conteúdo" lands. */
export const CONTENT_ID = 'conteudo';

/**
 * "Pular para o conteúdo" (WCAG 2.4.1, 01/11/2026): the first stop of the Tab key. Hidden until it gets the focus;
 * Enter moves the focus past the menus to the page itself, so whoever uses the keyboard or a screen reader does not
 * go through every link of the top bar and the sidebar on each page.
 */
export function SkipLink() {
  const [focused, setFocused] = useState(false);
  if (Platform.OS !== 'web') return null;
  function skip() {
    const main = document.getElementById(CONTENT_ID);
    if (!main) return;
    main.setAttribute('tabindex', '-1');   // focusable by script only, not one more stop of the Tab key
    main.focus();
  }
  return (
    <Pressable accessibilityRole="link" onPress={skip} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
               style={[styles.link, !focused && styles.hidden]}>
      <Text style={styles.text}>Pular para o conteúdo</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  link: { position: 'absolute', top: 8, left: 8, zIndex: 1000, backgroundColor: panel.action, paddingVertical: 10,
          paddingHorizontal: 16, borderRadius: panel.radius },
  // Off the screen but still read and reachable (display: none would take it out of the Tab order).
  hidden: { left: -10000, width: 1, height: 1, overflow: 'hidden' },
  text: { fontFamily: fonts.semiBold, fontSize: 15, color: '#FFFFFF' },
});
