/**
 * Content of the credits ("Sobre"), asked by the course after the final banca (17/11/2026) for every software
 * registration: developed by students of Sistemas de Informação with the support of CITEC, plus stakeholder, advisor
 * and developer. One source for the public page (/creditos) and the panel page (/sobre), so they never disagree.
 *
 * Only name and role of each person (LGPD, Art. 6º, III: minimization): no e-mail, phone or any other contact.
 */
export const CREDITS = {
  sub: 'Quem desenvolveu, orientou e acompanhou o projeto FOTOMAC.',
  about: [
    'O FOTOMAC é a plataforma de acervo fotográfico e audiovisual dos eventos do Centro Universitário CESMAC, com busca '
      + 'por reconhecimento facial: cada pessoa encontra somente as fotografias e os vídeos em que aparece, sem que o '
      + 'acervo fique aberto ao público.',
    'Desenvolvido como Trabalho de Conclusão de Curso (TCC) por Thiago José Camêlo Nunes, aluno do curso de Sistemas '
      + 'de Informação do CESMAC, com o suporte do CITEC.',
  ],
  people: [
    { role: 'Desenvolvedor', name: 'Thiago José Camêlo Nunes',
      about: 'Aluno do curso de Bacharelado em Sistemas de Informação do Centro Universitário CESMAC' },
    { role: 'Orientador', name: 'Prof. Me. Wagner de Oliveira Lima Palmeira de Araujo',
      about: 'Professor do curso de Sistemas de Informação do Centro Universitário CESMAC' },
    { role: 'Coordenador do curso', name: 'Prof. Me. Mozart de Melo Alves Junior',
      about: 'Coordenador do curso de Sistemas de Informação do Centro Universitário CESMAC' },
    { role: 'Cliente (stakeholder)', name: 'Moacir Barbosa da Silva',
      about: 'Fotógrafo institucional do Centro Universitário CESMAC' },
  ],
  institution: [
    'Centro Universitário CESMAC, curso de Bacharelado em Sistemas de Informação, com o suporte do CITEC.',
    'Maceió, Alagoas, 2026.',
  ],
} as const;
