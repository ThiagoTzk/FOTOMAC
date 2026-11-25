import { useEffect, useRef, type ComponentRef, type ReactNode, type RefObject } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

type Props = {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<ComponentRef<typeof View> | null>;
  width?: number;
  style?: StyleProp<ViewStyle>;
  /** Where the list sits on the site: under the button, or the screen's width on a narrow window. */
  webStyle?: StyleProp<ViewStyle>;
  children: (maxHeight: number) => ReactNode;
};

/**
 * THE SITE: the list that opens from a button of the panel's header (the bell, the account menu), drawn under the
 * button as before. A click or touch anywhere outside it, or Esc, closes it (08/11/2026: it closed only through
 * "Abrir a Visão geral"). The app's version is HeaderPopover.tsx.
 */
export function HeaderPopover({ open, onClose, anchor, style, webStyle, children }: Props) {
  const box = useRef<ComponentRef<typeof View>>(null);
  useEffect(() => {
    if (!open) return;
    function outside(e: PointerEvent) {
      const target = e.target as Node;
      const inside = (r: RefObject<ComponentRef<typeof View> | null>) => (r.current as unknown as HTMLElement | null)?.contains(target);
      // The button itself toggles the list: a press there is left to it.
      if (!inside(box) && !inside(anchor)) onClose();
    }
    function key(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key);
    };
  }, [open, onClose, anchor]);
  if (!open) return null;
  return <View ref={box} style={[style, webStyle]}>{children(420)}</View>;
}
