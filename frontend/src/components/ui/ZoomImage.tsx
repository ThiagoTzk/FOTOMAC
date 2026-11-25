import { Maximize2, ZoomIn, ZoomOut, type LucideIcon } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { Image } from '@/ui/Image';

import { swipeDirection } from './swipe';

export type ZoomImageProps = {
  uri: string;
  /** Small copy shown blurred while the large one loads. */
  placeholder?: string;
  alt: string;
  style?: StyleProp<ViewStyle>;
  /** At 1x, a horizontal swipe asks for the next (1) or previous (-1) photo. */
  onSwipe?: (direction: 1 | -1) => void;
  /** Colour of the zoom buttons: over a dark viewer or a light card. */
  theme?: 'light' | 'dark';
  /** Listen to the + − 0 keys (only one zoomable photo on screen at a time). */
  keyboard?: boolean;
};

const MIN = 1;
const MAX = 5;
const STEP = 1.5;

/**
 * Photo with zoom in the app (06/11/2026), the same as the site's (ZoomImage.web.tsx): pinch, drag when zoomed, double
 * tap, the − / + / whole-photo buttons with the percentage, and at 1x a sideways swipe for the next or previous photo.
 */
export function ZoomImage(props: ZoomImageProps) {
  // A new photo always opens whole, at 1x: a new key gives it a fresh state.
  return <Zoomable key={props.uri} {...props} />;
}

function Zoomable({ uri, placeholder, alt, style, onSwipe, theme = 'light' }: ZoomImageProps) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [shown, setShown] = useState(1);   // the percentage under the buttons
  const s = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const start = useSharedValue({ s: 1, x: 0, y: 0 });
  const touched = useSharedValue({ x: 0, y: 0 });   // where the finger first touched the photo

  // Keeps the photo from being dragged out of its frame (the same rule as the site).
  const clamp = (ns: number, nx: number, ny: number) => {
    'worklet';
    const scale = Math.max(MIN, Math.min(MAX, ns));
    if (scale <= 1) return { s: 1, x: 0, y: 0 };
    const mx = (size.w * (scale - 1)) / 2;
    const my = (size.h * (scale - 1)) / 2;
    return { s: scale, x: Math.max(-mx, Math.min(mx, nx)), y: Math.max(-my, Math.min(my, ny)) };
  };
  const set = (n: { s: number; x: number; y: number }, animate: boolean) => {
    'worklet';
    s.value = animate ? withTiming(n.s, { duration: 120 }) : n.s;
    x.value = animate ? withTiming(n.x, { duration: 120 }) : n.x;
    y.value = animate ? withTiming(n.y, { duration: 120 }) : n.y;
    runOnJS(setShown)(n.s);
  };
  const zoomBy = (factor: number) => {
    const n = clamp(s.value * factor, x.value * factor, y.value * factor);
    set(n, true);
  };

  const pinch = Gesture.Pinch()
    .onStart(() => { start.value = { s: s.value, x: x.value, y: y.value }; })
    .onUpdate((e) => {
      // Zoom around the point between the fingers, relative to the frame's centre.
      const px = e.focalX - size.w / 2;
      const py = e.focalY - size.h / 2;
      const ns = start.value.s * e.scale;
      const k = ns / start.value.s;
      set(clamp(ns, px - (px - start.value.x) * k, py - (py - start.value.y) * k), false);
    });
  const pan = Gesture.Pan()
    .averageTouches(true)
    .onBegin((e) => { touched.value = { x: e.absoluteX, y: e.absoluteY }; })
    .onStart(() => { start.value = { s: s.value, x: x.value, y: y.value }; })
    .onUpdate((e) => {
      if (start.value.s > 1) set(clamp(start.value.s, start.value.x + e.translationX, start.value.y + e.translationY), false);
    })
    .onEnd((e) => {
      if (start.value.s !== 1 || !onSwipe) return;
      // The travel from where the finger touched, not translationX: the gesture counts only from the moment it
      // starts (15/11/2026, measured in the app: a 30-point flick gave 15, a 45-point drag 36), and that is why
      // a swipe used to need half the screen.
      const dx = e.absoluteX - touched.value.x;
      const dy = e.absoluteY - touched.value.y;
      const direction = swipeDirection(dx, dy, e.velocityX);
      if (direction) runOnJS(onSwipe)(direction);
    });
  const doubleTap = Gesture.Tap().numberOfTaps(2).onEnd((e) => {
    if (s.value > 1) { set({ s: 1, x: 0, y: 0 }, true); return; }
    const px = e.x - size.w / 2;
    const py = e.y - size.h / 2;
    set(clamp(2.5, px - px * 2.5, py - py * 2.5), true);
  });
  const gestures = Gesture.Simultaneous(pinch, pan, doubleTap);

  const moved = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }, { scale: s.value }] }));
  const dark = theme === 'dark';

  return (
    // The frame cuts what goes out of it (a zoomed photo must not cover the title and the buttons around), and the
    // gestures get their own root: the photo is often inside a window (Modal), where the app's root does not reach.
    <View style={[styles.wrap, style]}>
    <GestureHandlerRootView style={StyleSheet.absoluteFill}>
      <GestureDetector gesture={gestures}>
        <View style={StyleSheet.absoluteFill} accessible accessibilityRole="image" accessibilityLabel={alt}
              onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
          <Animated.View style={[StyleSheet.absoluteFill, moved]}>
            <Image source={uri} placeholder={placeholder} style={StyleSheet.absoluteFill} contentFit="contain" />
          </Animated.View>
        </View>
      </GestureDetector>
      <View style={[styles.controls, dark ? styles.controlsDark : styles.controlsLight]}>
        <ZoomButton label="Diminuir zoom" dark={dark} disabled={shown <= MIN} onPress={() => zoomBy(1 / STEP)} Icon={ZoomOut} />
        <Text style={[styles.percent, { color: dark ? '#FFFFFF' : '#374151' }]} accessibilityLiveRegion="polite">{Math.round(shown * 100)}%</Text>
        <ZoomButton label="Aumentar zoom" dark={dark} disabled={shown >= MAX} onPress={() => zoomBy(STEP)} Icon={ZoomIn} />
        <ZoomButton label="Ver a foto inteira" dark={dark} disabled={shown === 1} onPress={() => set({ s: 1, x: 0, y: 0 }, true)} Icon={Maximize2} />
      </View>
    </GestureHandlerRootView>
    </View>
  );
}

function ZoomButton({ label, onPress, disabled, dark, Icon }: { label: string; onPress: () => void; disabled: boolean; dark: boolean; Icon: LucideIcon }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
               hitSlop={4} style={[styles.button, disabled && { opacity: 0.35 }]}>
      <Icon size={18} color={dark ? '#FFFFFF' : '#1F2937'} strokeWidth={1.8} absoluteStrokeWidth />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'relative', overflow: 'hidden' },
  controls: { position: 'absolute', bottom: 12, alignSelf: 'center', flexDirection: 'row', alignItems: 'center',
              gap: 2, paddingHorizontal: 6, paddingVertical: 3, borderRadius: 12 },
  controlsDark: { backgroundColor: 'rgba(0, 0, 0, 0.55)' },
  controlsLight: { backgroundColor: 'rgba(255, 255, 255, 0.92)', boxShadow: '0px 1px 6px rgba(0, 0, 0, 0.18)' },
  percent: { minWidth: 44, textAlign: 'center', fontFamily: 'Poppins_500Medium', fontSize: 12 },
  button: { width: 34, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
});
