import * as ImagePicker from 'expo-image-picker';
import { CloudUpload } from 'lucide-react-native';
import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { pickedFile, pickFromFiles } from '@/components/panel/files';
import { Button } from '@/components/panel/ui';
import { fonts, panel } from '@/theme/tokens';

type Props = { onFiles: (files: File[]) => void; accept?: string; title?: string; phoneTitle?: string };

/**
 * The app's "Área de envio" (06/11/2026): the same box as the site (Dropzone.web.tsx), and one button that offers the
 * phone's three ways: the gallery, the camera, and Files (where RAW and HEIC files from a camera usually are). Only
 * the kinds this box accepts are offered (photos, videos or both).
 */
export function Dropzone({ onFiles, accept = 'image/jpeg', phoneTitle = 'Toque para escolher os arquivos' }: Props) {
  const videos = /video/.test(accept);
  const photos = /image|\.jpe?g|\.png|\.heic|\.webp/i.test(accept);
  const [busy, setBusy] = useState(false);
  const media: ImagePicker.MediaType[] = [...(photos ? ['images' as const] : []), ...(videos ? ['videos' as const] : [])];

  async function fromPicker(camera: boolean) {
    const allowed = camera ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!allowed.granted) {
      Alert.alert('FOTOMAC', camera ? 'Libere a câmera para o FOTOMAC nas configurações do celular.'
        : 'Libere o acesso às fotos para o FOTOMAC nas configurações do celular.');
      return;
    }
    // quality 1 and no editing: the photographer's file as it is (the server makes the copies for the screens).
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: media, quality: 1, exif: false, allowsEditing: false,
                                                      allowsMultipleSelection: !camera, selectionLimit: 0, videoQuality: ImagePicker.UIImagePickerControllerQualityType.High,
                                                      preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current };
    const r = camera ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
    if (r.canceled) return;
    onFiles(r.assets.map((a) => pickedFile(a.uri, a.fileName, a.mimeType, a.fileSize)));
  }

  async function fromFiles() {
    // The phone's Files, read where they are (no copy): RAW and HEIC files from a camera usually come this way.
    const types = [...(photos ? ['image/*', 'application/octet-stream'] : []), ...(videos ? ['video/*'] : [])];
    const files = await pickFromFiles(types);
    if (files.length) onFiles(files);
  }

  function choose() {
    Alert.alert('Selecionar arquivos', 'De onde vêm os arquivos?', [
      { text: 'Galeria', onPress: () => run(() => fromPicker(false)) },
      { text: videos && !photos ? 'Gravar com a câmera' : 'Câmera', onPress: () => run(() => fromPicker(true)) },
      { text: 'Arquivos', onPress: () => run(fromFiles) },
      { text: 'Cancelar', style: 'cancel' },
    ], { cancelable: true });
  }

  async function run(pick: () => Promise<void>) {
    setBusy(true);
    try { await pick(); } finally { setBusy(false); }
  }

  return (
    <View style={styles.zone}>
      <View style={styles.icon}><CloudUpload size={24} color={panel.primary} strokeWidth={1.6} absoluteStrokeWidth /></View>
      <Text style={styles.title}>{phoneTitle}</Text>
      <Text style={styles.hint}>da galeria, da câmera ou dos arquivos do celular</Text>
      <Button variant="secondary" label={busy ? 'Abrindo…' : 'Selecionar arquivos'} onPress={choose} disabled={busy} />
    </View>
  );
}

const styles = StyleSheet.create({
  zone: { minHeight: 230, backgroundColor: panel.surface, borderWidth: 1, borderColor: panel.primary, borderStyle: 'dashed',
          borderRadius: panel.cardRadius, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 16 },
  icon: { width: 48, height: 48, borderRadius: 999, backgroundColor: panel.primarySoft, alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: fonts.regular, fontSize: 20, color: panel.text, textAlign: 'center' },
  hint: { fontFamily: fonts.regular, fontSize: 14, color: panel.muted, textAlign: 'center' },
});
