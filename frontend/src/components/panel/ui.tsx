/**
 * Building blocks of the operation area, read from the Figma file (.fig, node names in
 * quotes): "Botão", "Cartão", "Status", "Aviso", "Campo"/"Entrada", "Abas".
 */
import type { LucideIcon } from 'lucide-react-native';
import { forwardRef, useState, type ReactNode, type ComponentRef } from 'react';
import {
  ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View,
  type StyleProp, type TextInputProps, type ViewStyle,
} from 'react-native';

import { fonts, panel } from '@/theme/tokens';
import { FIELD_BOX, usePhone, useTextScale } from '@/theme/accessibility';

// ------------------------------------------------------------------ Botão

type ButtonProps = {
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  icon?: LucideIcon;
  loading?: boolean;
  disabled?: boolean;
};

export function Button({ label, onPress, variant = 'primary', icon: Icon, loading, disabled }: ButtonProps) {
  const inactive = disabled || loading;
  const color = variant === 'secondary' ? panel.text : '#FFFFFF';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive, busy: !!loading }} aria-disabled={!!inactive} aria-busy={!!loading}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        ui.button,
        variant === 'primary' && ui.buttonPrimary,
        variant === 'secondary' && ui.buttonSecondary,
        variant === 'danger' && ui.buttonDanger,
        pressed && !inactive && { opacity: 0.85 },
        inactive && { opacity: 0.6 },
      ]}>
      {loading ? (
        <ActivityIndicator color={color} />
      ) : (
        <>
          {Icon && <Icon size={16} color={color} strokeWidth={1.6} absoluteStrokeWidth />}
          <Text style={[ui.buttonLabel, { color }]}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

// ------------------------------------------------------------------ Cartão

export function Card({ children, style, padding = 20 }: { children: ReactNode; style?: StyleProp<ViewStyle>; padding?: number }) {
  return <View style={[ui.card, { padding }, style]}>{children}</View>;
}

/** A label over a value, as in the event summary card. */
export function InfoItem({ label, value, style }: { label: string; value: string; style?: object }) {
  // Side-by-side cells widen with a larger text (accessibility menu) instead of breaking the words.
  const scale = useTextScale();
  const basis = (StyleSheet.flatten(style) as { flexBasis?: unknown } | undefined)?.flexBasis;
  return (
    <View style={[{ gap: 5 }, style, typeof basis === 'number' && { flexBasis: basis * scale }]}>
      <Text style={{ fontFamily: fonts.bold, fontSize: 12, color: panel.muted }}>{label}</Text>
      <Text style={{ fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: panel.text }}>{value}</Text>
    </View>
  );
}

export function SectionTitle({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <View style={ui.sectionTitle}>
      <Text style={ui.sectionTitleText} accessibilityRole="header" aria-level={2}>{title}</Text>
      {/* On a phone the buttons go under the title and wrap, instead of running past the card. */}
      {action && <View style={{ flexShrink: 1, maxWidth: '100%' }}>{action}</View>}
    </View>
  );
}

// ------------------------------------------------------------------ Status

export type EventStatus = 'editing' | 'processing' | 'published' | 'expired';

const STATUS: Record<EventStatus, { label: string; bg: string; fg: string }> = {
  editing: { label: 'Em edição', bg: panel.warningSoft, fg: panel.warning },
  processing: { label: 'Em processamento', bg: panel.primarySoft, fg: panel.primaryText },
  published: { label: 'Publicado', bg: panel.successSoft, fg: panel.success },
  expired: { label: 'Expirado', bg: panel.page, fg: panel.muted },
};

/** A scheduled deletion overrides the status: the event left the site and is about to go. */
const DELETING = { label: 'Exclusão agendada', bg: panel.dangerSoft, fg: panel.danger };

export const statusLabel = (s: EventStatus, deleting = false) => (deleting ? DELETING : STATUS[s]).label;

export function StatusPill({ status, deleting = false }: { status: EventStatus; deleting?: boolean }) {
  const s = deleting ? DELETING : STATUS[status];
  return <Pill label={s.label} bg={s.bg} fg={s.fg} />;
}

export function Pill({ label, bg = panel.primarySoft, fg = panel.primaryText }: { label: string; bg?: string; fg?: string }) {
  return (
    <View style={[ui.pill, { backgroundColor: bg }]}>
      <Text style={[ui.pillText, { color: fg }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

// ------------------------------------------------------------------ Aviso

type Tone = 'info' | 'success' | 'warning' | 'danger';
const TONES: Record<Tone, { bg: string; fg: string }> = {
  info: { bg: panel.primarySoft, fg: panel.primaryText },
  success: { bg: panel.successSoft, fg: panel.success },
  warning: { bg: panel.warningSoft, fg: panel.warning },
  danger: { bg: panel.dangerSoft, fg: panel.danger },
};

type NoticeProps = {
  tone: Tone;
  icon: LucideIcon;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
  /** Extra content under the description (e.g. the reason of a rejection, in a block of its own). */
  children?: ReactNode;
};

export function Notice({ tone, icon: Icon, title, description, actionLabel, onAction, style, children }: NoticeProps) {
  const t = TONES[tone];
  // On a phone the action goes under the text (06/11/2026): beside it, the text was squeezed into a thin, tall column.
  const phone = usePhone();
  const action = actionLabel && onAction && (
    <Pressable accessibilityRole="button" onPress={onAction} style={phone && ui.noticeActionPhone}>
      <Text style={[ui.noticeAction, { color: t.fg }, phone && { fontFamily: fonts.bold, textDecorationLine: 'underline' }]}>{actionLabel}</Text>
    </Pressable>
  );
  return (
    <View style={[ui.notice, { backgroundColor: t.bg }, phone && { alignItems: 'flex-start' }, style]}
          accessibilityRole={tone === 'danger' ? 'alert' : undefined}>
      <Icon size={18} color={t.fg} strokeWidth={1.6} absoluteStrokeWidth />
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={[ui.noticeTitle, { color: t.fg }]}>{title}</Text>
        {!!description && <Text style={ui.noticeText}>{description}</Text>}
        {children}
        {phone && action}
      </View>
      {!phone && action}
    </View>
  );
}

// ------------------------------------------------------------------ Campo

type FieldProps = { label?: string; help?: string; error?: string; children: ReactNode; style?: StyleProp<ViewStyle> };

export function Field({ label, help, error, children, style }: FieldProps) {
  return (
    <View style={[{ gap: 7 }, style]}>
      {!!label && <Text style={ui.label}>{label}</Text>}
      {children}
      {!!error && <Text style={ui.error} accessibilityLiveRegion="polite">{error}</Text>}
      {!error && !!help && <Text style={ui.help}>{help}</Text>}
    </View>
  );
}

type InputProps = TextInputProps & { icon?: LucideIcon; invalid?: boolean; multiline?: boolean; readOnly?: boolean };

export const Input = forwardRef<ComponentRef<typeof TextInput>, InputProps>(function Input(
  { icon: Icon, invalid, multiline, readOnly, style, ...props }, ref) {
  const [focused, setFocused] = useState(false);
  return (
    <View {...FIELD_BOX} style={[ui.input, multiline && ui.inputMultiline, focused && { borderColor: panel.primary },
                  invalid && { borderColor: panel.danger, borderWidth: 2 }, readOnly && { backgroundColor: panel.page }]}>
      {Icon && <Icon size={16} color={panel.muted} strokeWidth={1.6} absoluteStrokeWidth />}
      <TextInput
        ref={ref}
        placeholderTextColor={panel.placeholder}
        editable={!readOnly}
        multiline={multiline}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        aria-invalid={!!invalid}
        style={[ui.inputText, multiline && { height: '100%', textAlignVertical: 'top' }, style] as StyleProp<object>}
        {...props}
      />
    </View>
  );
});

// ------------------------------------------------------------------ Chave

/**
 * On/off switch with its state written on the element itself (role="switch" + aria-checked). React Native's Switch
 * is a hidden <input> whose state React changes by script, and Safari with VoiceOver read it wrong, even the
 * starting state (user test, 01/11/2026). Space and Enter press it (theme/keyboard.ts).
 */
export function Switch({ value, onChange, label, disabled }: {
  value: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean;
}) {
  return (
    <Pressable accessibilityRole="switch" accessibilityState={{ checked: value, disabled: !!disabled }} aria-checked={value}
               aria-disabled={!!disabled} accessibilityLabel={label} onPress={() => { if (!disabled) onChange(!value); }}
               style={[ui.switchTrack, value && ui.switchTrackOn, disabled && { opacity: 0.5 }]}>
      <View style={[ui.switchKnob, value && ui.switchKnobOn]} />
    </Pressable>
  );
}

// ------------------------------------------------------------------ Abas

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: string }[]; value: T; onChange: (k: T) => void }) {
  // A small phone (320 px) cut "Configuração" at the edge (06/11/2026): closer there, and a tab that does not fit
  // goes to a second line instead of out of the screen.
  const phone = usePhone();
  return (
    <View style={[ui.tabs, phone && ui.tabsPhone]} accessibilityRole="tablist">
      {tabs.map((t) => (
        <Pressable key={t.key} accessibilityRole="tab" accessibilityState={{ selected: t.key === value }} aria-selected={t.key === value}
                   onPress={() => onChange(t.key)} style={[ui.tab, t.key === value && ui.tabActive]}>
          <Text style={[ui.tabText, t.key === value && { color: panel.primary }]}>{t.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export const ui = StyleSheet.create({
  button: { height: 40, borderRadius: panel.radius, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center',
            justifyContent: 'center', gap: 8, borderWidth: 1, borderColor: 'transparent' },
  buttonPrimary: { backgroundColor: panel.action },
  buttonSecondary: { backgroundColor: panel.surface, borderColor: panel.border },
  buttonDanger: { backgroundColor: panel.danger },
  buttonLabel: { fontFamily: fonts.bold, fontSize: 14 },
  card: { backgroundColor: panel.surface, borderWidth: 1, borderColor: panel.border, borderRadius: panel.cardRadius,
          boxShadow: panel.cardShadow, gap: 16 },
  sectionTitle: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  sectionTitleText: { fontFamily: fonts.regular, fontSize: 20, color: panel.text },
  // maxWidth: a long label ("Vídeos MP4, MOV e outros…") went past a 320 px screen instead of using two lines.
  pill: { minHeight: 26, paddingVertical: 3, borderRadius: 999, paddingHorizontal: 10, justifyContent: 'center', alignSelf: 'flex-start',
          maxWidth: '100%' },
  pillText: { fontFamily: fonts.bold, fontSize: 12 },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: panel.radius },
  noticeTitle: { fontFamily: fonts.bold, fontSize: 14 },
  noticeText: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: panel.text },
  noticeAction: { fontFamily: fonts.regular, fontSize: 12 },
  noticeActionPhone: { alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center', marginTop: 4 },
  label: { fontFamily: fonts.bold, fontSize: 12, color: panel.text },
  help: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: panel.muted },
  error: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: panel.danger },
  input: { height: 42, borderWidth: 1, borderColor: panel.border, borderRadius: panel.radius, backgroundColor: panel.surface,
           paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', gap: 9 },
  inputMultiline: { height: 88, paddingVertical: 12, alignItems: 'flex-start' },
  switchTrack: { width: 40, height: 24, borderRadius: 999, backgroundColor: panel.border, padding: 3 },
  switchTrackOn: { backgroundColor: panel.action },
  switchKnob: { width: 18, height: 18, borderRadius: 999, backgroundColor: '#FFFFFF' },
  switchKnobOn: { alignSelf: 'flex-end' },
  inputText: { flex: 1, minWidth: 0, height: '100%', fontFamily: fonts.regular, fontSize: 14, color: panel.text, outlineStyle: 'none' } as object,
  tabs: { flexDirection: 'row', gap: 28, borderBottomWidth: 1, borderColor: panel.border },
  tabsPhone: { flexWrap: 'wrap', columnGap: 16, rowGap: 6 },
  tab: { paddingBottom: 10, marginBottom: -1, borderBottomWidth: 2, borderColor: 'transparent' },
  tabActive: { borderColor: panel.primary },
  tabText: { fontFamily: fonts.regular, fontSize: 14, color: panel.muted },
});
