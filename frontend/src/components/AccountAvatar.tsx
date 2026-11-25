import { Image } from '@/ui/Image';
import { Text, View, type ImageStyle, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { API_URL } from '@/api/client';
import type { Account } from '@/auth/AuthContext';

/** The account's photo, or its initials when there is none (28/10/2026). The owner sees their own; since 30/10/2026
 * the administrator also sees every account's photo in "Contas" (photoUrl). */
export const myPhotoUrl = (version: string) => `${API_URL}/api/v1/auth/me/photo?v=${version}`;

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

type Props = {
  account: Pick<Account, 'full_name' | 'photo_version'>;
  /** The circle: size, radius and the background behind the initials. */
  style: ViewStyle & ImageStyle;
  textStyle: StyleProp<TextStyle>;
  /** Another account's photo (administrator only); by default, the signed-in account's own. */
  photoUrl?: string;
};

export function AccountAvatar({ account, style, textStyle, photoUrl }: Props) {
  if (account.photo_version) {
    return <Image source={{ uri: photoUrl ?? myPhotoUrl(account.photo_version) }} style={style} contentFit="cover" accessibilityLabel="Foto de perfil" />;
  }
  return <View style={style}><Text style={textStyle}>{initials(account.full_name)}</Text></View>;
}
