import { router } from 'expo-router';
import { Info } from 'lucide-react-native';
import { View } from 'react-native';

import { createAccount } from '@/api/accounts';
import { AccountForm } from '@/components/admin/AccountForm';
import { PageHeader } from '@/components/panel/PageHeader';
import { Card, Notice } from '@/components/panel/ui';

/** "Cadastro de Contas". The account is born WITHOUT a password. */
export default function NewAccountScreen() {
  return (
    <View style={{ gap: 24, maxWidth: 760 }}>
      <PageHeader crumbs={[{ label: 'Contas', href: '/contas' }, { label: 'Nova conta' }]} title="Nova conta"
                  subtitle="Cadastre uma conta de operação. O titular define a própria senha." />
      <Notice tone="info" icon={Info} title="A conta é criada sem senha"
              description="O titular recebe no e-mail um link de uso único, válido por 24 horas, para definir a senha. Ninguém conhece ou vê a senha, nem o administrador." />
      <Card padding={24}>
        <AccountForm submitLabel="Criar conta e enviar link"
                     onSubmit={async (data) => {
                       const created = await createAccount(data);
                       // The mail server failed after the account was saved: open it all the same and say so.
                       router.replace(`/contas/${created.id}?criada=${created.link_sent === false ? 'sem-email' : '1'}`);
                     }} />
      </Card>
    </View>
  );
}
