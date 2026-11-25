import { Redirect, Slot } from 'expo-router';

import { useAuth } from '@/auth/AuthContext';
import { BlockedAccount } from '@/components/auth/BlockedAccount';
import { Shell } from '@/components/panel/Shell';

/** Every operation-area screen shares the sidebar + header of the Figma "Área autenticada". */
export default function PanelLayout() {
  const { account } = useAuth();
  // Without a session (never logged in, or just clicked "Sair") the panel sends to the staff
  // login — not to "/", which is the visitor's home. The API refuses the data anyway.
  if (!account) return <Redirect href="/login" />;
  // Suspended, deactivated or expired (31/10/2026): only its situation, its data and the Support page, whatever
  // panel address was opened. The server refuses every other route to this session anyway.
  if (account.status !== 'active') return <BlockedAccount account={account} />;
  return (
    <Shell>
      <Slot />
    </Shell>
  );
}
