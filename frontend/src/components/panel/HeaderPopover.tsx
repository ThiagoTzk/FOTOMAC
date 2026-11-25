import { useEffect, useState, type ComponentRef, type ReactNode, type RefObject } from 'react';
import { Dimensions, Modal as RNModal, Platform, Pressable, StatusBar, StyleSheet, useWindowDimensions, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type Props = {
  open: boolean;
  onClose: () => void;
  /** The button that opened it: the list hangs right under it. */
  anchor: RefObject<ComponentRef<typeof View> | null>;
  /** Width of the list; omitted, it takes the screen's width, 12 points from each edge. */
  width?: number;
  /** The look of the box (background, border, radius, shadow). Position and size are decided here. */
  style?: StyleProp<ViewStyle>;
  /** On the site the list sits under the button with these extra styles (HeaderPopover.web.tsx); ignored here. */
  webStyle?: StyleProp<ViewStyle>;
  /** Told how tall the list may be, so a long one scrolls inside the screen. */
  children: (maxHeight: number) => ReactNode;
};

const GAP = 8;
const EDGE = 12;

/**
 * THE APP: a list that opens from a button of the panel's header (the bell, the account menu), 08/11/2026. On the
 * iPhone the bell's list used `position: fixed`, which exists only in a browser: it opened squeezed inside the header
 * as a narrow column, ran past the top of the screen and pushed the other buttons (user test). Here it goes in a
 * layer of its own over the whole screen, measured from the button, and a touch anywhere outside closes it
 * ("eu abro e quero sair, eu clico fora dela e ela cancela"). The site's version is HeaderPopover.web.tsx.
 */
export function HeaderPopover({ open, onClose, anchor, width, style, children }: Props) {
  const screen = useWindowDimensions();
  const whole = Dimensions.get('screen').height;   // the layer covers the whole screen, bars included
  const insets = useSafeAreaInsets();
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!open) return;   // the last place is kept: the button does not move between two openings
    // Android measures from below the status bar (measured on the emulator, 08/11/2026: y 16 for a bell at 68), while
    // this layer starts at the very top of the screen: the bar's height is added back. The iPhone measures from the top.
    const bar = Platform.OS === 'android' ? StatusBar.currentHeight ?? 0 : 0;
    anchor.current?.measureInWindow((x, y, w, h) => setAt({ top: bar + y + h + GAP, right: Math.max(EDGE, screen.width - (x + w)) }));
  }, [open, anchor, screen.width]);

  if (!open || !at) return null;
  const maxHeight = Math.max(160, Math.max(whole, screen.height) - at.top - insets.bottom - EDGE);
  const place: ViewStyle = width
    ? { top: at.top, right: at.right, width: Math.min(width, screen.width - 2 * EDGE) }
    : { top: at.top, left: EDGE, right: EDGE };
  return (
    // statusBarTranslucent: the layer starts at the very top of the screen, where measureInWindow counts from (Android).
    <RNModal visible transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Fechar" />
      <View style={[style, { position: 'absolute', maxHeight }, place]}>{children(maxHeight)}</View>
    </RNModal>
  );
}
