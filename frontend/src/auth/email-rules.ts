/**
 * Same rules and messages as backend/app/email_address.py (31/10/2026). The screen says at once what to fix;
 * the SERVER checks again and is the one that decides. A backend test makes sure the messages stay the same.
 */
const LOCAL_MAX = 64;
const LABEL_MAX = 63;

export function emailProblem(email: string, maxLength = 254): string | null {
  if (!email) return 'Informe o e-mail.';
  if (/\s/.test(email)) return 'O e-mail não pode ter espaços.';
  if (email.length > maxLength) return `O e-mail pode ter até ${maxLength} caracteres.`;
  const ats = email.split('@').length - 1;
  if (ats === 0) return 'Falta o @ no e-mail (exemplo: nome@cesmac.edu.br).';
  if (ats > 1) return 'O e-mail tem mais de um @. Use apenas um.';
  const [local, domain] = email.split('@');
  if (!local) return 'Falta o nome antes do @ (exemplo: nome@cesmac.edu.br).';
  if (local.length > LOCAL_MAX) return `A parte antes do @ pode ter até ${LOCAL_MAX} caracteres.`;
  if (!/^[A-Za-z0-9._%+'-]+$/.test(local)) return 'Antes do @, use só letras sem acento, números e os sinais . _ - +';
  if (local.startsWith('.') || local.endsWith('.')) return 'A parte antes do @ não pode começar nem terminar com ponto.';
  if (email.includes('..')) return 'O e-mail não pode ter dois pontos seguidos.';
  if (!domain) return 'Falta o domínio depois do @ (exemplo: cesmac.edu.br).';
  if (!/^[A-Za-z0-9.-]+$/.test(domain)) return 'Depois do @, use só letras sem acento, números, hífen e ponto.';
  if (domain.startsWith('.') || domain.endsWith('.')) return 'O domínio não pode começar nem terminar com ponto.';
  const labels = domain.split('.');
  if (labels.length < 2) return 'O domínio precisa de um ponto (exemplo: cesmac.edu.br).';
  if (labels.some((l) => l.length > LABEL_MAX)) return `Cada parte do domínio pode ter até ${LABEL_MAX} caracteres.`;
  if (labels.some((l) => l.startsWith('-') || l.endsWith('-'))) return 'Nenhuma parte do domínio pode começar ou terminar com hífen.';
  if (!/^[A-Za-z]{2,}$/.test(labels[labels.length - 1])) return 'O final do domínio precisa ter ao menos 2 letras (exemplo: .br, .com).';
  return null;
}
