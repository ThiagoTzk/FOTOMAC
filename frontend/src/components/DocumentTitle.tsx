import { useGlobalSearchParams, usePathname } from 'expo-router';
import { useEffect, useReducer } from 'react';
import { Platform } from 'react-native';

/**
 * The browser tab's name follows the page: "FOTOMAC - Legolas", "FOTOMAC - Painel"… (28/10/2026), so someone
 * working with many tabs tells them apart. Events show their name; people (institutional, accounts) show only
 * the section — a name in the title would stay in the browser history of a shared computer.
 */
const eventNames = new Map<string, string>();
const listeners = new Set<() => void>();

/** Called where an event is loaded (panel and public site): its tab gets the event's name. */
export function rememberEventName(id: string, name: string): void {
  if (eventNames.get(id) === name) return;
  eventNames.set(id, name);
  listeners.forEach((l) => l());
}

const SECTIONS: [RegExp, string][] = [
  [/^\/$/, 'Início'],
  [/^\/explorar/, 'Eventos'],
  [/^\/como-funciona/, 'Como funciona'],
  [/^\/privacidade/, 'Privacidade'],
  [/^\/creditos/, 'Créditos'],
  [/^\/login/, 'Entrar'],
  [/^\/recuperar-senha/, 'Recuperar senha'],
  [/^\/redefinir-senha/, 'Nova senha'],
  [/^\/primeiro-acesso/, 'Primeiro acesso'],
  [/^\/autorizacao\/revogar/, 'Revogar autorização'],
  [/^\/autorizacao\/email/, 'Confirmar novo e-mail'],
  [/^\/autorizacao/, 'Autorização de uso de imagem'],
  [/^\/painel/, 'Painel'],
  [/^\/sobre/, 'Sobre'],
  [/^\/eventos\/novo/, 'Novo evento'],
  [/^\/eventos\/?$/, 'Eventos'],
  [/^\/contas\/nova/, 'Nova conta'],
  [/^\/contas/, 'Contas'],
  [/^\/pessoas-institucionais/, 'Pessoas institucionais'],
  [/^\/reconhecimento/, 'Reconhecimento facial'],
  [/^\/temas/, 'Temas'],
  [/^\/registros/, 'Registros'],
  [/^\/perfil/, 'Meu perfil'],
  [/^\/suporte/, 'Suporte'],
];

const EVENT_PAGES: Record<string, string> = {
  imagens: 'Imagens', enviar: 'Enviar imagens e vídeos', download: 'Download', editar: 'Editar', processamento: 'Processamento',
};

export function titleFor(path: string, tab?: string): string {
  const event = path.match(/^\/(?:eventos|evento)\/([0-9a-f-]{36})(?:\/([^/]+))?(\/[^/]+)?/);
  if (event) {
    const name = eventNames.get(event[1]) ?? 'Evento';
    const page = event[3] ? 'Imagem' : event[2] ? EVENT_PAGES[event[2]] : tab === 'configuracao' ? 'Configuração' : null;
    return page ? `${name} · ${page}` : name;
  }
  return SECTIONS.find(([re]) => re.test(path))?.[1] ?? 'Fotografias de eventos';
}

/** Mounted once, at the root. */
export function DocumentTitle() {
  const path = usePathname();
  const { aba } = useGlobalSearchParams<{ aba?: string }>();
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    listeners.add(bump);
    return () => { listeners.delete(bump); };
  }, []);
  useEffect(() => {
    if (Platform.OS === 'web') document.title = `FOTOMAC - ${titleFor(path, aba)}`;
  }, [path, aba, version]);
  return null;
}
