import { Timer } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { formatDateTime } from '@/api/images';
import { useAuth } from '@/auth/AuthContext';
import { fonts, panel } from '@/theme/tokens';

const URGENT_MS = 3 * 3600 * 1000;   // the last 3 hours in red

/** "2d 03:12:45": days only when there are any; hours, minutes and seconds always. */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const hms = [Math.floor(total / 3600) % 24, Math.floor(total / 60) % 60, total % 60].map((n) => String(n).padStart(2, '0')).join(':');
  return d ? `${d}d ${hms}` : hms;
}

/**
 * Beside the bell, for a temporary account only (31/10/2026, user test): "CONTA TEMPORÁRIA · EXPIRA EM" and a
 * clock going down second by second, with the date below. It replaced the notice that stayed in the bell. At zero,
 * the account asks the server again and the restricted page opens (the server ends the access by itself anyway).
 */
export function ContractClock({ strip }: { strip?: boolean }) {
  const { account, refresh } = useAuth();
  const [now, setNow] = useState(() => Date.now());
  const until = account?.role === 'contractor' && account.valid_until ? Date.parse(account.valid_until) : null;

  useEffect(() => {
    if (until === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [until]);
  const over = until !== null && now >= until;
  useEffect(() => { if (over) refresh(); }, [over, refresh]);

  if (until === null) return null;
  const left = until - now;
  const urgent = left < URGENT_MS;
  const [bg, fg] = urgent ? [panel.dangerSoft, panel.danger] : [panel.warningSoft, panel.warning];
  const label = `Conta temporária: expira em ${formatDateTime(account!.valid_until!)}`;
  // Phone and tablet (06/11/2026): beside the bell, the clock pushed the photo and the name off the screen.
  // There it is a strip of its own under the header, the whole width, and its text goes to a second line if needed.
  if (strip) {
    return (
      <View style={[styles.strip, { backgroundColor: bg }]} accessible accessibilityLabel={label}>
        <Timer size={16} color={fg} strokeWidth={1.8} absoluteStrokeWidth />
        <Text style={[styles.stripText, { color: fg }]}>
          Conta temporária · expira em <Text style={styles.stripClock}>{countdown(left)}</Text>
        </Text>
        <Text style={[styles.stripDate, { color: fg }]}>{formatDateTime(account!.valid_until!)}</Text>
      </View>
    );
  }
  return (
    // No live region: a screen reader would read it every second. The label says it once, with the date.
    <View style={[styles.chip, { backgroundColor: bg }]} accessible accessibilityLabel={label}>
      <Timer size={18} color={fg} strokeWidth={1.8} absoluteStrokeWidth />
      <View>
        <Text style={[styles.small, { color: fg }]}>CONTA TEMPORÁRIA · EXPIRA EM</Text>
        <Text style={[styles.clock, { color: fg }]}>{countdown(left)}</Text>
        <Text style={[styles.small, { color: fg }]}>{formatDateTime(account!.valid_until!)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 10 },
  small: { fontFamily: fonts.bold, fontSize: 10, letterSpacing: 0.4 },
  // Same width for every digit: the clock does not shake while it counts.
  clock: { fontFamily: fonts.bold, fontSize: 16, fontVariant: ['tabular-nums'] },
  strip: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 2, paddingHorizontal: 16, paddingVertical: 8 },
  stripText: { flexShrink: 1, fontFamily: fonts.semiBold, fontSize: 13 },
  stripClock: { fontFamily: fonts.bold, fontVariant: ['tabular-nums'] },
  stripDate: { fontFamily: fonts.regular, fontSize: 12 },
});
