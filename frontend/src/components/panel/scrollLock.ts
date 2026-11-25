import { createContext, useContext } from 'react';

/**
 * Stops the panel's page from scrolling while a finger is on a map that is being edited (08/11/2026, measured on the
 * Android emulator: dragging the event's pin scrolled the form instead, and the pin barely moved). The panel's frame
 * (Shell.tsx) gives it; outside the panel it does nothing.
 */
export const ScrollLock = createContext<(locked: boolean) => void>(() => {});

export const useScrollLock = () => useContext(ScrollLock);
