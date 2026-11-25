// react-dom is already a dependency (react-native-web draws with it); only the one function the web code uses is
// typed here, instead of adding @types/react-dom for it.
declare module 'react-dom' {
  import type { ReactNode, ReactPortal } from 'react';
  export function createPortal(children: ReactNode, container: Element | DocumentFragment, key?: string | null): ReactPortal;
}
