import { EventForm } from '@/components/panel/EventForm';
import { PageHeader } from '@/components/panel/PageHeader';

/** Create an event. */
export default function NewEventScreen() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Eventos', href: '/eventos' }, { label: 'Novo evento' }]} title="Novo evento" />
      <EventForm />
    </>
  );
}
