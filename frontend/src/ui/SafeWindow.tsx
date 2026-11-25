import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// The "dead corner" of 08/11/2026 (buttons at the top right of the iPhone that did not answer) was Expo Go's floating
// "Tools button", a window of its own over the app, not iOS: turned off in Expo Go's menu, the corner works
// (09/11/2026). The published app has no such button, so nothing here moves away from that corner any more.

/**
 * The inside of a window that covers the whole screen (photo, video, capture, dialog), 08/11/2026. On the iPhone such a
 * window is drawn under the clock and the battery and over the bar at the bottom: the X and the title sat on the clock
 * (user test). This keeps the content clear of them; the background (style) still fills the whole screen.
 *
 * The margins are the ones the app's screens already use (read at the root of the app). SafeAreaView, which measures
 * itself, measured nothing inside a window on the iPhone (tested 08/11/2026): the window is a layer of its own. These
 * windows always cover the whole screen, so the root's margins are exactly theirs. On the computer they are 0.
 */
export function SafeWindow({ style, children }: { style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[{ flex: 1 }, style, { paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }]}>
      {children}
    </View>
  );
}
