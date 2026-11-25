import { Accessibility, Bold, Contrast, Minus, Plus, RotateCcw, Space, Underline, type LucideIcon } from 'lucide-react-native';
import { useRef, useSyncExternalStore, type ComponentRef } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Modal } from '@/components/panel/Modal';
import { Button } from '@/components/panel/ui';
import { A11Y_DEFAULT, isDefault, setAccessibility, TEXT_STEPS, useAccessibility, type A11y } from '@/theme/accessibility';
import { fonts, panel } from '@/theme/tokens';

/** One on/off choice, as a switch the screen reader announces ("Texto em negrito, interruptor, ligado"). */
function Toggle({ icon: Icon, label, help, value, onChange }: {
  icon: LucideIcon; label: string; help: string; value: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <Pressable accessibilityRole="switch" accessibilityState={{ checked: value }} aria-checked={value} accessibilityLabel={label}
               onPress={() => onChange(!value)} style={[styles.row, value && styles.rowOn]}>
      <Icon size={20} color={value ? panel.primary : panel.muted} strokeWidth={1.8} absoluteStrokeWidth />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.help}>{help}</Text>
      </View>
      <View style={[styles.track, value && styles.trackOn]}><View style={[styles.knob, value && styles.knobOn]} /></View>
    </Pressable>
  );
}

// One window for the whole site, opened by any of the buttons. It used to live inside each button, and every
// header still mounted (the pages kept in the history, the one swapped when a larger text turns the computer layout
// into the phone one) opened its own copy: the windows piled up (01/11/2026, user test).
let open = false;
const listeners = new Set<() => void>();
function setOpen(v: boolean) { open = v; listeners.forEach((l) => l()); }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const useOpen = () => useSyncExternalStore(subscribe, () => open, () => false);

/** Beside the sun/moon, on every page with a header (panel and public site). It only opens the menu below. */
export function AccessibilityButton() {
  const a = useAccessibility();
  const custom = !isDefault(a);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Acessibilidade" aria-haspopup="dialog"
               onPress={() => setOpen(true)}
               style={({ hovered }: any) => [styles.round, (hovered || custom) && { borderColor: panel.primary }]}>
      <Accessibility size={19} color={custom ? panel.primary : panel.navText} strokeWidth={1.8} absoluteStrokeWidth />
    </Pressable>
  );
}

/**
 * Text size, bold, high contrast, spacing and underlined links (01/11/2026). Mounted once, in the root
 * layout. The choices apply at once to the whole site and stay in this browser.
 */
export function AccessibilityMenu() {
  const visible = useOpen();
  const a = useAccessibility();
  const bigger = useRef<ComponentRef<typeof View>>(null);
  const set = (patch: Partial<A11y>) => setAccessibility({ ...a, ...patch });
  const step = TEXT_STEPS.indexOf(a.text);
  const custom = !isDefault(a);
  return (
    <Modal visible={visible} onClose={() => setOpen(false)} icon={Accessibility} title="Acessibilidade">
      <View style={{ gap: 14 }}>
        {/* At 100% or 200% the buttons stay focusable (aria-disabled, no "disabled"): a button disabled under the
            keyboard drops the focus out of the window. For the same reason "Restaurar o padrão", which turns itself
            off, hands the focus to "Aumentar o texto". */}
        <View style={styles.sizeRow}>
          <View style={{ flex: 1, gap: 2, minWidth: 160 }}>
            <Text style={styles.label}>Tamanho do texto</Text>
            <Text style={styles.help}>De 100% a 200%. Vale para o site inteiro.</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Diminuir o texto" aria-disabled={step <= 0}
                     onPress={() => step > 0 && set({ text: TEXT_STEPS[step - 1] })}
                     style={[styles.sizeButton, step <= 0 && styles.off]}>
            <Minus size={18} color={panel.text} strokeWidth={2} absoluteStrokeWidth />
          </Pressable>
          <Text style={styles.percent} aria-live="polite" accessibilityLabel={`Texto em ${Math.round(a.text * 100)}%`}>
            {Math.round(a.text * 100)}%
          </Text>
          <Pressable ref={bigger} accessibilityRole="button" accessibilityLabel="Aumentar o texto" aria-disabled={step >= TEXT_STEPS.length - 1}
                     onPress={() => step < TEXT_STEPS.length - 1 && set({ text: TEXT_STEPS[step + 1] })}
                     style={[styles.sizeButton, step >= TEXT_STEPS.length - 1 && styles.off]}>
            <Plus size={18} color={panel.text} strokeWidth={2} absoluteStrokeWidth />
          </Pressable>
        </View>
        <Toggle icon={Bold} label="Texto em negrito" help="Todas as letras ficam mais grossas." value={a.bold} onChange={(bold) => set({ bold })} />
        <Toggle icon={Contrast} label="Alto contraste" help="Textos e bordas mais escuros (mais claros no modo escuro)."
                value={a.contrast} onChange={(contrast) => set({ contrast })} />
        <Toggle icon={Space} label="Mais espaço no texto" help="Mais espaço entre linhas, letras e palavras."
                value={a.spacing} onChange={(spacing) => set({ spacing })} />
        <Toggle icon={Underline} label="Sublinhar links" help="Mostra o que é link sem depender da cor."
                value={a.underline} onChange={(underline) => set({ underline })} />
        <Text style={styles.help}>
          {Platform.OS === 'web'
            ? 'As escolhas ficam só neste navegador; nada é enviado ao FOTOMAC. O zoom do navegador (Ctrl ou Cmd e +) também funciona.'
            : 'As escolhas ficam só neste celular; nada é enviado ao FOTOMAC. O app reabre para aplicar cada mudança. O tamanho de letra dos ajustes do celular também vale.'}
        </Text>
        <View style={styles.actions}>
          <Button variant="secondary" icon={RotateCcw} label="Restaurar o padrão" disabled={!custom}
                  onPress={() => { setAccessibility(A11Y_DEFAULT); if (Platform.OS === 'web') (bigger.current as unknown as HTMLElement | null)?.focus(); }} />
          <Button label="Fechar" onPress={() => setOpen(false)} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  round: { width: 38, height: 38, borderRadius: 999, backgroundColor: panel.page, borderWidth: 1, borderColor: 'transparent',
           alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: panel.radius, borderWidth: 1,
         borderColor: panel.border },
  rowOn: { borderColor: panel.primary, backgroundColor: panel.primarySoft },
  label: { fontFamily: fonts.semiBold, fontSize: 15, color: panel.text },
  help: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: panel.muted },
  track: { width: 40, height: 24, borderRadius: 999, backgroundColor: panel.border, padding: 3 },
  trackOn: { backgroundColor: panel.action },
  knob: { width: 18, height: 18, borderRadius: 999, backgroundColor: '#FFFFFF' },
  knobOn: { alignSelf: 'flex-end' },
  sizeRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: 12, borderRadius: panel.radius,
             borderWidth: 1, borderColor: panel.border },
  sizeButton: { width: 40, height: 40, borderRadius: 999, borderWidth: 1, borderColor: panel.border, alignItems: 'center',
                justifyContent: 'center', backgroundColor: panel.surface },
  off: { opacity: 0.4 },
  percent: { fontFamily: fonts.bold, fontSize: 16, color: panel.text, minWidth: 52, textAlign: 'center' },
  actions: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' },
});
