import type { ReactNode, RefObject, ComponentRef } from 'react';
import { View } from 'react-native';

type Props = { anchor: RefObject<ComponentRef<typeof View> | null>; onClose: () => void; height: number; children: ReactNode };

/** The app (no portal): the menu opens right under the field. The web version is Floating.web.tsx. */
export function Floating({ children }: Props) {
  return <View style={{ position: 'absolute', top: 46, left: 0, right: 0 }}>{children}</View>;
}
