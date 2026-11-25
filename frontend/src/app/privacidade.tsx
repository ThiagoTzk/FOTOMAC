import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { getPrivacy } from '@/api/public';
import { VisitorHeader } from '@/components/visitor/Header';
import { Column, useJustified, useWide, vtext } from '@/components/visitor/ui';
import { PageBand, WebPage, Wrap } from '@/components/visitor/web/Site';
import { visitor } from '@/theme/tokens';

type Privacy = Awaited<ReturnType<typeof getPrivacy>>;

/**
 * Política de Privacidade: public, plain language, reachable from every screen through
 * the header menu and from the permission notice. The retention shown is the one the system
 * actually applies, read from the server.
 *
 * Engineering text written with the law at hand (Lei nº 13.709/2018) — it must be reviewed by
 * CESMAC's legal area before going into production.
 */
export default function PrivacyPolicy() {
  const [info, setInfo] = useState<Privacy | null>(null);
  useEffect(() => { getPrivacy().then(setInfo).catch(() => undefined); }, []);
  const intro = 'Como o FOTOMAC trata dados pessoais, em conformidade com a Lei Geral de Proteção de Dados Pessoais (Lei nº 13.709/2018, a LGPD).';

  if (useWide()) {
    return (
      <WebPage>
        <PageBand crumbs={[{ label: 'Política de Privacidade' }]} title="Política de Privacidade" sub={intro} />
        <Wrap style={{ paddingVertical: 48 }}>
          <View style={styles.card}><Policy info={info} /></View>
        </Wrap>
      </WebPage>
    );
  }
  return (
    <ScrollView style={styles.page} contentContainerStyle={{ paddingBottom: 48 }}>
      <VisitorHeader back />
      <Column narrow style={{ gap: 20, marginTop: 24 }}>
        <View style={{ gap: 6 }}>
          <Text style={vtext.h1} accessibilityRole="header">Política de Privacidade</Text>
          <Text style={vtext.body}>{intro}</Text>
        </View>
        <Policy info={info} />
      </Column>
    </ScrollView>
  );
}

/** The policy itself — the same text on the phone and on the computer. */
function Policy({ info }: { info: Privacy | null }) {
  const retention = info?.retention ?? '…';
  return (
    <>
      <Section title="Quem trata os seus dados">
        O controlador é o {info?.controller ?? 'Centro Universitário CESMAC'}. O FOTOMAC existe para que cada pessoa
        fotografada nos eventos institucionais encontre as suas próprias fotos, e somente elas.
      </Section>

      <Section title="Quais dados tratamos">
        {'• Fotografias dos eventos, enviadas e conferidas pelos fotógrafos da instituição. Ficam numa galeria privada: '}
        {'ninguém navega pelo acervo; cada pessoa vê apenas as fotos em que foi reconhecida. A localização (GPS) que a '}
        {'câmera ou o celular grava no arquivo é apagada no envio. A foto que você baixa leva a identificação CESMAC no '}
        {'canto e, gravados no arquivo, o crédito do fotógrafo e o aviso de propriedade da instituição.\n'}
        {'• Vetor facial: uma sequência de números calculada a partir dos rostos das fotos publicadas, usada só para a '}
        {'comparação. É dado pessoal sensível de natureza biométrica (LGPD, Art. 5º, inciso II) e fica guardado '}
        {'separado das fotos, com acesso restrito.\n'}
        {'• A captura do seu rosto na busca: uma gravação curta, guiada por movimentos sorteados, que fica no seu '}
        {'aparelho; só alguns quadros são enviados. Eles servem para confirmar que há uma pessoa real diante da câmera e '}
        {'para comparar com as fotos daquele evento, apenas na memória do servidor, e são descartados em seguida. Nada é '}
        {'gravado em disco, em registro nem em cache, e não há opção de guardar para buscas futuras.\n'}
        {'• Registro da sua ciência: apenas a data, a hora, o evento e a versão do aviso, sem ligação com a sua imagem, '}
        {'seu nome ou seu aparelho.\n'}
        {'• E-mail informado numa solicitação de remoção: usado só para avisar a conclusão e apagado em seguida.\n'}
        {'• Representantes institucionais que assinaram o termo próprio: nome, cargo, e-mail, as fotos de referência e a '}
        {'assinatura do termo. Só a equipe autorizada consulta, e cada consulta fica registrada. Com a revogação, as fotos '}
        {'de referência e os dados de reconhecimento facial da pessoa são eliminados.'}
      </Section>

      <Section title="Para que usamos e para que não usamos">
        As fotos publicadas têm duas finalidades: permitir que cada pessoa encontre e baixe as fotos em que aparece e,
        para a equipe de marketing do CESMAC, servir à divulgação institucional: a equipe escolhe, entre as fotos
        publicadas, as que serão usadas na comunicação da instituição. Fotos com pedido de remoção deixam de estar
        disponíveis também para isso. Os vetores faciais servem exclusivamente à busca. Nada é cedido a terceiros fora
        da instituição, vendido ou usado para treinar sistemas de inteligência artificial. A sua busca acontece sempre
        dentro de um único evento: o sistema não procura um visitante em todos os eventos nem informa em quais eventos
        alguém aparece. A única exceção são os representantes institucionais (por exemplo, dirigentes e coordenadores),
        que assinam um termo próprio autorizando que as fotos em que aparecem sejam localizadas em todo o acervo, para a
        comunicação da instituição; eles podem revogar essa autorização a qualquer momento. A base legal da divulgação
        institucional está em validação pela área jurídica do CESMAC.
      </Section>

      <Section title="Sua permissão">
        A comparação do seu rosto só acontece depois que você lê o aviso “Permissão para uso de imagem” e clica (ou toca)
        em “Estou ciente”. Nunca há opção marcada de antemão. O tratamento de dado sensível depende de consentimento
        específico e destacado, para finalidade específica (LGPD, Art. 11, inciso I). Se você não concordar, basta não
        prosseguir: nada é processado.
      </Section>

      <Section title="O reconhecimento facial pode errar">
        O sistema compara a semelhança entre rostos e não confirma a identidade de ninguém. Existe margem de erro: ele
        pode mostrar a foto de uma pessoa parecida com você ou deixar de mostrar fotos suas. Por isso calibramos o sistema
        para mostrar apenas os resultados em que tem mais segurança, e algumas fotos suas podem ficar de fora. Se aparecer
        uma foto que não é sua, não a baixe nem compartilhe. Se precisar, procure o encarregado pelo tratamento de dados,
        indicado abaixo.
      </Section>

      <Section title="Uso da imagem de outras pessoas">
        As fotos destinam-se exclusivamente às pessoas nelas retratadas. A imagem de cada pessoa é protegida pela
        Constituição Federal (art. 5º, X) e pelo Código Civil (art. 20). Usar, publicar ou compartilhar a imagem de outra
        pessoa sem autorização pode gerar responsabilização civil, inclusive indenização, e criminal, conforme o caso.
      </Section>

      <Section title="Vídeos">
        Os eventos também podem ter vídeos. Vídeos podem conter imagem e voz, e a voz também é dado pessoal. A
        localização gravada no arquivo é removida antes de ele ser guardado. Depois de publicado, o vídeo também passa
        pelo reconhecimento facial: um quadro por segundo é analisado como uma foto, e os vetores faciais ficam guardados
        separados, com acesso restrito. Se a sua busca encontrar você em pelo menos dois segundos diferentes de um vídeo,
        você pode assistir e baixar o vídeo inteiro, com a identificação CESMAC no canto. O vídeo pode mostrar outras
        pessoas: valem para ele as mesmas regras de uso da imagem de outras pessoas descritas acima. Qualquer pessoa que
        apareça no vídeo pode pedir a remoção dele: o vídeo inteiro sai das buscas na hora e é excluído em até 72 horas.
        Os vídeos seguem o mesmo prazo das fotos e são excluídos ao fim dele, com os vetores faciais.
      </Section>

      <Section title="Crianças">
        Alguns eventos contêm imagens de crianças, e a página do evento avisa quando isso acontece. Nesses eventos, a
        autorização de uso de imagem é coletada pelo CESMAC com os pais ou responsáveis antes da publicação, e quem
        publica declara no sistema que a autorização foi coletada e onde os termos estão guardados (LGPD, Art. 14,
        § 1º). O fotógrafo pode borrar o rosto de uma criança no próprio arquivo: o rosto borrado não gera vetor facial.
        Os pais ou responsáveis podem pedir a remoção de uma imagem ou exercer os demais direitos pelo encarregado
        indicado abaixo.
      </Section>

      <Section title="Por quanto tempo">
        As fotos de cada evento ficam disponíveis por {retention} após a data do evento. Ao fim do prazo, o sistema
        exclui automaticamente as fotos, os vídeos, as cópias reduzidas e todos os vetores faciais derivados deles.
      </Section>

      <Section title="Seus direitos">
        Você pode pedir confirmação de tratamento, acesso, correção, eliminação e informações sobre o uso dos seus
        dados (LGPD, Art. 18). Para retirar uma foto em que você aparece, faça a busca no evento, abra a foto e toque em
        “Solicitar remoção”: a foto sai das buscas na hora e é excluída definitivamente em até 72 horas, mesmo sem ação
        do fotógrafo. Se a busca não encontrar a foto (por exemplo, quando você aparece de longe ou de perfil), ou se
        você é o representante legal de quem aparece nela (LGPD, Art. 18, § 3º), faça o pedido ao encarregado pelo
        tratamento de dados, indicado abaixo.
      </Section>

      <Section title="Mapa do evento">
        O mapa do local do evento fica no próprio servidor do FOTOMAC e usa dados do OpenStreetMap. Abrir a página de um
        evento não conecta você a nenhum serviço externo de mapas.
      </Section>

      <Section title="Segurança">
        A conexão com o servidor é protegida, o acesso da equipe é individual e registrado, os arquivos ficam em
        armazenamento privado e cada foto só é entregue a quem a encontrou na própria busca, por um endereço que expira
        em 15 minutos.
      </Section>

      <Section title="Encarregado pelo tratamento de dados">
        {info?.dpo ?? 'A indicação do encarregado (LGPD, Art. 41) é atribuição da instituição e será publicada aqui.'}
      </Section>

      <Text style={vtext.small}>Versão do aviso de permissão em vigor: {info?.consent_version ?? '…'}</Text>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const justified = useJustified();
  return (
    <View style={{ gap: 6 }}>
      <Text style={vtext.h3}>{title}</Text>
      <Text style={[vtext.body, justified]}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: visitor.page },
  // Reading width: long lines tire the eye, so the text keeps ~80 characters even on a wide screen.
  card: { width: '100%', maxWidth: 860, alignSelf: 'center', backgroundColor: visitor.surface, borderRadius: 16, paddingVertical: 40,
          paddingHorizontal: 48, gap: 24, boxShadow: visitor.cardShadow },
});
