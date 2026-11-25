import { Baby, Square, SquareCheck } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Field, Input } from '@/components/panel/ui';
import { fonts, panel } from '@/theme/tokens';

export type ChildrenValue = { on: boolean; declared: boolean; reference: string };
export const NO_CHILDREN: ChildrenValue = { on: false, declared: false, reference: '' };

/** What is missing to turn the switch on; null when the declaration is complete. */
export function childrenProblem(v: ChildrenValue): string | null {
  if (!v.on) return null;
  if (!v.declared) return 'Marque a declaração de que a autorização dos responsáveis foi coletada.';
  if (!v.reference.trim()) return 'Informe onde estão guardados os termos assinados.';
  return null;
}

function Check({ checked, label, help, onPress, icon }: {
  checked: boolean; label: string; help?: string; onPress: () => void; icon?: boolean;
}) {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} aria-checked={checked} accessibilityLabel={label}
               onPress={onPress} style={styles.row}>
      {checked ? <SquareCheck size={22} color={panel.primary} strokeWidth={1.8} absoluteStrokeWidth />
        : <Square size={22} color={panel.muted} strokeWidth={1.8} absoluteStrokeWidth />}
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
          {icon && <Baby size={16} color={panel.text} strokeWidth={1.8} absoluteStrokeWidth />}
          <Text style={styles.label}>{label}</Text>
        </View>
        {help && <Text style={styles.help}>{help}</Text>}
      </View>
    </Pressable>
  );
}

/**
 * "Este evento contém imagens com crianças" (04/11/2026, answer of the coordinator: CESMAC keeps the parents'
 * authorisation). Turning it on asks for the declaration and where the signed terms are: the system cannot prove
 * the authorisation by itself, so it records who declared it (LGPD Art. 8, § 2; Art. 14, § 1). Nothing comes
 * pre-checked (Art. 8, § 1: no tacit acceptance).
 */
export function ChildrenDeclaration({ value, onChange, error, showSwitch = true }: {
  value: ChildrenValue; onChange: (v: ChildrenValue) => void; error?: string | null; showSwitch?: boolean;
}) {
  return (
    <View style={{ gap: 10 }}>
      {showSwitch && (
        <Check icon checked={value.on} label="Este evento contém imagens com crianças"
               help="Aparece um aviso para a equipe e para o visitante, mesmo que os rostos das crianças sejam borrados."
               onPress={() => onChange(value.on ? NO_CHILDREN : { ...value, on: true })} />
      )}
      {value.on && (
        <View style={styles.box}>
          <Check checked={value.declared}
                 label="Declaro que a autorização de uso de imagem dos responsáveis pelas crianças foi coletada."
                 help="A declaração fica registrada com o seu nome, a data e a hora."
                 onPress={() => onChange({ ...value, declared: !value.declared })} />
          <Field label="Onde estão guardados os termos assinados" help={`${value.reference.length} de 300 caracteres`}>
            <Input placeholder="Exemplo: Secretaria do curso, pasta OBR 2026" value={value.reference} maxLength={300}
                   onChangeText={(reference) => onChange({ ...value, reference })} invalid={!!error && !value.reference.trim()}
                   accessibilityLabel="Onde estão guardados os termos assinados" />
          </Field>
          {error && <Text style={styles.error} role="alert">{error}</Text>}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', padding: 14, borderRadius: 10, borderWidth: 1, borderColor: panel.border },
  box: { gap: 12, padding: 14, borderRadius: 10, backgroundColor: panel.primarySoft },
  label: { fontFamily: fonts.bold, fontSize: 12, color: panel.text, flexShrink: 1 },
  help: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: panel.muted },
  error: { fontFamily: fonts.regular, fontSize: 12, color: panel.danger },
});
