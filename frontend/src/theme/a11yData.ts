/**
 * The accessibility choices' data, shared by the site (theme/accessibility.ts, by CSS) and the app
 * (theme/appA11y.native.ts, when the styles are made): the same heavier fonts and the same high-contrast palette.
 */
// Which file each family uses in bold mode: one step heavier.
export const HEAVIER: Record<string, string> = {
  Inter_400Regular: 'Inter_600SemiBold', Inter_500Medium: 'Inter_700Bold', Inter_600SemiBold: 'Inter_700Bold',
  Inter_700Bold: 'Inter_800ExtraBold', Poppins_400Regular: 'Poppins_600SemiBold', Poppins_500Medium: 'Poppins_700Bold',
  Poppins_600SemiBold: 'Poppins_700Bold', Montserrat_400Regular: 'Montserrat_800ExtraBold',
};

// High contrast: text-like greys and borders get darker (lighter on the dark mode); buttons keep their colours.
export const HIGH_LIGHT = {
  '--fm-p-text': '#0B1820', '--fm-p-muted': '#2E3C45', '--fm-p-placeholder': '#4E5D66', '--fm-p-border': '#6B7A84',
  '--fm-p-borderSoft': '#A9B6BF', '--fm-p-navText': '#000000', '--fm-p-primary': '#005A8E', '--fm-p-primaryText': '#004F7D',
  '--fm-p-success': '#0B5E42', '--fm-p-warning': '#6E4800', '--fm-p-danger': '#A0303C',
  '--fm-c-text': '#0B1218', '--fm-c-textMuted': '#2F3B45', '--fm-c-placeholder': '#55626C', '--fm-c-border': '#6B7A84',
  '--fm-c-inputBorder': '#4E5D66', '--fm-c-primary': '#005A8E', '--fm-c-primaryText': '#004F7D', '--fm-c-danger': '#A0303C',
  '--fm-v-title': '#000000', '--fm-v-heading': '#0B1218', '--fm-v-text': '#111827', '--fm-v-muted': '#1F2937',
  '--fm-v-placeholder': '#4B5563', '--fm-v-primary': '#005A8E', '--fm-v-cardBorder': 'rgba(0, 0, 0, 0.45)',
};
export const HIGH_DARK = {
  '--fm-p-text': '#FFFFFF', '--fm-p-muted': '#D5DEE5', '--fm-p-placeholder': '#AEBBC5', '--fm-p-border': '#8597A5',
  '--fm-p-borderSoft': '#4A5C69', '--fm-p-navText': '#FFFFFF', '--fm-p-primaryText': '#A8D8F7', '--fm-p-page': '#000000',
  '--fm-c-text': '#FFFFFF', '--fm-c-textMuted': '#D5DEE5', '--fm-c-placeholder': '#AEBBC5', '--fm-c-border': '#8597A5',
  '--fm-c-inputBorder': '#A3B3BF', '--fm-c-primaryText': '#A8D8F7', '--fm-c-background': '#000000',
  '--fm-v-title': '#FFFFFF', '--fm-v-heading': '#FFFFFF', '--fm-v-text': '#F1F5F9', '--fm-v-muted': '#E2E8F0',
  '--fm-v-placeholder': '#A3AEBB', '--fm-v-cardBorder': 'rgba(255, 255, 255, 0.45)', '--fm-v-page': '#000000',
};
