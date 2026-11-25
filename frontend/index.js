// The app's first module (06/11/2026): the accessibility choices saved in the phone are applied to every style, so they
// must be in place before any screen's styles are made (see src/theme/appA11y.native.ts). On the site it does nothing.
import './src/theme/appA11y';
import 'expo-router/entry';
