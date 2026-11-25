import { ChevronDown, ChevronRight, Info } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { getImageDetails, type ImageDetails } from '@/api/images';
import { Modal } from '@/components/panel/Modal';
import { Button } from '@/components/panel/ui';
import { fonts, panel } from '@/theme/tokens';

/**
 * What the camera wrote in the photo (24/10/2026), wherever the panel shows a photo: the main details
 * (size of the original — the RAW too —, dimensions, camera, lens, exposure, date…) and, on "Ver mais
 * detalhes", every tag of the file, by group. The location is never there: it is removed at upload.
 */
/** personId: a photo opened from an institutional person's page (read through that consultation). */
export function FileDetails({ imageId, dark, personId }: { imageId: string; dark?: boolean; personId?: string }) {
  const [data, setData] = useState<{ id: string; details: ImageDetails } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [more, setMore] = useState(false);

  useEffect(() => {
    let alive = true;
    getImageDetails(imageId, personId).then((d) => { if (alive) setData({ id: imageId, details: d }); })
      .catch(() => { if (alive) setFailed(imageId); });
    return () => { alive = false; };
  }, [imageId, personId]);

  const label = [styles.label, dark && { color: 'rgba(255,255,255,0.6)' }];
  const value = [styles.value, dark && { color: '#FFFFFF' }];
  if (failed === imageId) return <Text style={label}>Não foi possível ler os dados do arquivo agora.</Text>;
  if (data?.id !== imageId) return <ActivityIndicator color={dark ? '#FFFFFF' : panel.primary} />;
  const d = data.details;
  return (
    <View style={{ gap: 12 }}>
      {d.summary.map((i) => (
        <View key={i.label} style={{ gap: 3 }}>
          <Text style={label}>{i.label}</Text>
          <Text style={value} selectable>{i.value}</Text>
        </View>
      ))}
      {!d.complete && <Text style={label}>Os dados gravados no arquivo não puderam ser lidos agora.</Text>}
      {d.groups.length > 0 && (
        <View style={{ alignItems: 'flex-start' }}>
          <Button variant="secondary" icon={Info} label="Ver mais detalhes" onPress={() => setMore(true)} />
        </View>
      )}
      <Modal visible={more} onClose={() => setMore(false)} icon={Info} title="Todos os detalhes do arquivo" width={760}>
        <Text style={styles.help}>
          Tudo o que a câmera e os programas gravaram no arquivo original, por grupo. A localização não aparece: ela é
          removida no envio, por privacidade.
        </Text>
        {d.groups.map((g) => <Group key={g.name} name={g.name} items={g.items} />)}
        <View style={{ alignItems: 'flex-end' }}><Button label="Fechar" onPress={() => setMore(false)} /></View>
      </Modal>
    </View>
  );
}

function Group({ name, items }: ImageDetails['groups'][number]) {
  const [open, setOpen] = useState(name === 'Arquivo' || name.startsWith('EXIF (captura)'));
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <View style={styles.group}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} aria-expanded={open} onPress={() => setOpen((o) => !o)}
                 style={styles.groupHead}>
        <Icon size={16} color={panel.primary} strokeWidth={2} absoluteStrokeWidth />
        <Text style={styles.groupName}>{name}</Text>
        <Text style={styles.help}>{items.length} {items.length === 1 ? 'item' : 'itens'}</Text>
      </Pressable>
      {open && items.map((i) => (
        <View key={i.label} style={styles.row}>
          <Text style={styles.rowLabel}>{i.label}</Text>
          <Text style={styles.rowValue} selectable>{i.value}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontFamily: fonts.bold, fontSize: 12, color: panel.muted },
  value: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: panel.text },
  help: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: panel.muted },
  group: { borderWidth: 1, borderColor: panel.border, borderRadius: 10, overflow: 'hidden' },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: panel.page },
  groupName: { fontFamily: fonts.bold, fontSize: 14, color: panel.text, flex: 1 },
  row: { flexDirection: 'row', gap: 16, paddingHorizontal: 14, paddingVertical: 7, borderTopWidth: 1, borderColor: panel.borderSoft },
  rowLabel: { fontFamily: fonts.medium, fontSize: 13, color: panel.muted, width: 220 },
  rowValue: { fontFamily: fonts.regular, fontSize: 13, color: panel.text, flex: 1 },
});
