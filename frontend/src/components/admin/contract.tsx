import { useEffect, useState } from 'react';

import { listEvents } from '@/api/events';
import { Select } from '@/components/panel/Select';
import { Field } from '@/components/panel/ui';

/** How long a hired photographer's account works (the server accepts 1 h to 30 days). */
const HOURS = [24, 48, 72, 120, 168, 360, 720];

export const hoursLabel = (h: number) =>
  h % 24 === 0 ? `${h / 24} ${h === 24 ? 'dia' : 'dias'} (${h} horas)` : `${h} ${h === 1 ? 'hora' : 'horas'}`;

export function ContractHoursField({ value, onChange, help }: { value: number; onChange: (h: number) => void; help: string }) {
  return (
    <Field label="Prazo da conta *" help={help}>
      <Select placeholder="Prazo" options={HOURS.map((h) => ({ value: h, label: hoursLabel(h) }))} value={value}
              onChange={(v: number | null) => v && onChange(v)} accessibilityLabel="Prazo da conta" />
    </Field>
  );
}

/** The events a hired photographer can be bound to (not expired), loaded only when needed. */
export function useCoverageEvents(enabled: boolean) {
  const [events, setEvents] = useState<{ value: string; label: string }[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled || events.length) return;
    (async () => {
      const out: { value: string; label: string }[] = [];
      for (let page = 1; page <= 10; page++) {
        const r = await listEvents({ page });
        r.items.filter((e) => e.status !== 'expired').forEach((e) => out.push({ value: e.id, label: `${e.name} · ${e.date_label}` }));
        if (page * r.page_size >= r.total) break;
      }
      setEvents(out);
    })().catch(() => setFailed(true));
  }, [enabled, events.length]);
  return { events, failed };
}
