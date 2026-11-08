(() => {
  // Inicializa Socket.io com fallback seguro para ambientes Serverless (Vercel / GitHub Pages / Netlify)
  let socket = null;
  let useServerlessP2P = false;
  try {
    if (typeof window.io === 'function') {
      socket = window.io({
        reconnectionAttempts: 2,
        timeout: 1500
      });
    } else {
      useServerlessP2P = true;
    }
  } catch (_) {
    useServerlessP2P = true;
  }

  // Estado local
  let mySocketId = 'user_' + Math.random().toString(36).slice(2, 9);
  let roomState = null;
  let selectedAvatar = '🍿';
  let currentCategory = 'all';
  let currentHeroMovie = null;
  let selectedDetailMovie = null;
  let allDriveMovies = [];
  let hlsInstance = null;
  let isApplyingRemoteSync = false;
  let lastLoadedMediaSignature = '';
  let sessionClockInterval = null;
  let searchDebounceTimer = null;

  // Estado PeerJS (Para funcionar em tempo real mesmo na Vercel / GitHub Pages sem servidor WebSocket)
  let peerInstance = null;
  let isP2PHost = false;
  let hostConnections = new Map(); // peerId -> DataConnection
  let guestConnToHost = null;

  const DEFAULT_LOCAL_MOVIES = [
    {
      id: 'drive_1jHPPYUSl1HEI0KmmBxxWgXogep1jAssU',
      title: 'Homem-Aranha: Um Novo Dia',
      year: '2026',
      rating: '8.5',
      category: 'Ficção & Fantasia',
      featured: true,
      driveFileId: '1jHPPYUSl1HEI0KmmBxxWgXogep1jAssU',
      rawUrl: 'https://drive.google.com/file/d/1jHPPYUSl1HEI0KmmBxxWgXogep1jAssU/view',
      streamUrl: '/api/gdrive/stream/1jHPPYUSl1HEI0KmmBxxWgXogep1jAssU',
      poster: 'https://image.tmdb.org/t/p/w500/x0nvYzQpyJc5pdT9lMnkMuYAg0O.jpg',
      backdrop: 'https://image.tmdb.org/t/p/original/subj7knTn4DeS6KS7qI66EQKe9i.jpg',
      overview:
        'É um novo dia para Peter Parker. Combatendo o crime em tempo integral como Homem-Aranha em um mundo que não se lembra mais dele e lidando com a pressão de ver seus antigos amigos seguirem em frente sem sua presença.',
      addedAt: 1794176579000
    },
    {
      id: 'drive_1NamT9cBP-X-sklL8NZKuZYRiC3FFXzNJ',
      title: 'O Resgate do Soldado Ryan',
      year: '1998',
      rating: '8.2',
      category: 'Lançamentos & Destaques',
      featured: true,
      driveFileId: '1NamT9cBP-X-sklL8NZKuZYRiC3FFXzNJ',
      rawUrl: 'https://drive.google.com/file/d/1NamT9cBP-X-sklL8NZKuZYRiC3FFXzNJ/view',
      streamUrl: '/api/gdrive/stream/1NamT9cBP-X-sklL8NZKuZYRiC3FFXzNJ',
      poster: 'https://image.tmdb.org/t/p/w500/hMLxNLCXRDd62acfCBn6mIyW1HU.jpg',
      backdrop: 'https://image.tmdb.org/t/p/original/rW2xRFlJRbTnBJlQTSjQmjevIwb.jpg',
      overview:
        'Ao desembarcar na Normandia, no dia 6 de junho de 1944, o capitão Miller recebe a missão de comandar um grupo do segundo batalhão para o resgate do soldado James Ryan.',
      addedAt: 1794176577505
    },
    {
      id: 'drive_1Tte7oU7xlxFeAhgVKTzkWcZv1KqffGT7',
      title: 'Gigantes de Aço',
      year: '2011',
      rating: '7.2',
      category: 'Ação & Aventura',
      featured: false,
      driveFileId: '1Tte7oU7xlxFeAhgVKTzkWcZv1KqffGT7',
      rawUrl: 'https://drive.google.com/file/d/1Tte7oU7xlxFeAhgVKTzkWcZv1KqffGT7/view',
      streamUrl: '/api/gdrive/stream/1Tte7oU7xlxFeAhgVKTzkWcZv1KqffGT7',
      poster: 'https://image.tmdb.org/t/p/w500/pp74uUjwQTknGPqNrerj4FvU0ce.jpg',
      backdrop: 'https://image.tmdb.org/t/p/original/pjlxrd646cBYznHoPBWTzz6FujX.jpg',
      overview:
        'Em um futuro próximo, as máquinas substituem os seres humanos no ringue. Charlie, um ex-lutador frustrado, se une ao filho para construir um competidor imbatível.',
      addedAt: 1794176577342
    },
    {
      id: 'drive_1f2Q4WoYpS-0A7Xwgyb881DRAOvmg7Gri',
      title: 'Carros',
      year: '2006',
      rating: '7.0',
      category: 'Animação & Família',
      featured: true,
      driveFileId: '1f2Q4WoYpS-0A7Xwgyb881DRAOvmg7Gri',
      rawUrl: 'https://drive.google.com/file/d/1f2Q4WoYpS-0A7Xwgyb881DRAOvmg7Gri/view',
      streamUrl: '/api/gdrive/stream/1f2Q4WoYpS-0A7Xwgyb881DRAOvmg7Gri',
      poster: 'https://image.tmdb.org/t/p/w500/A7nssMRIPauZhEVf2dzwsf4EALO.jpg',
      backdrop: 'https://image.tmdb.org/t/p/original/sd4xN5xi8tKRPrJOWwNiZEile7f.jpg',
      overview:
        'Ao viajar para a Califórnia para a disputa da corrida final da Copa Pistão, o famoso Relâmpago McQueen acaba preso em Radiator Springs e descobre o verdadeiro significado de amizade.',
      addedAt: 1794176577200
    },
    {
      id: 'drive_1LMNLyic4K4EPQhVJPPmgBkOdk6c3Vgqi',
      title: 'Carros 2',
      year: '2011',
      rating: '6.2',
      category: 'Animação & Família',
      featured: false,
      driveFileId: '1LMNLyic4K4EPQhVJPPmgBkOdk6c3Vgqi',
      rawUrl: 'https://drive.google.com/file/d/1LMNLyic4K4EPQhVJPPmgBkOdk6c3Vgqi/view',
      streamUrl: '/api/gdrive/stream/1LMNLyic4K4EPQhVJPPmgBkOdk6c3Vgqi',
      poster: 'https://image.tmdb.org/t/p/w500/fIKaabvE40T39nOIngcZPcPJeYe.jpg',
      backdrop: 'https://image.tmdb.org/t/p/original/robYRZk9LxJTwD7GlZCginji5k.jpg',
      overview:
        'O astro das corridas, Relâmpago McQueen, e o carro-guincho, Mate, viajam para disputar o primeiro Grand Prix Mundial, que irá revelar o carro mais veloz do planeta.',
      addedAt: 1794176577100
    },
    {
      id: 'drive_1O8YWLCL3qy33YI3FTHKnAp7GAJrOAV3B',
      title: 'Carros 3',
      year: '2017',
      rating: '6.9',
      category: 'Animação & Família',
      featured: false,
      driveFileId: '1O8YWLCL3qy33YI3FTHKnAp7GAJrOAV3B',
      rawUrl: 'https://drive.google.com/file/d/1O8YWLCL3qy33YI3FTHKnAp7GAJrOAV3B/view',
      streamUrl: '/api/gdrive/stream/1O8YWLCL3qy33YI3FTHKnAp7GAJrOAV3B',
      poster: 'https://image.tmdb.org/t/p/w500/oEmdfjqQnAWe1t23WiiW0icFhGv.jpg',
      backdrop: 'https://image.tmdb.org/t/p/original/4mlS1MitcOqdPLhxEFyk9Qwf5rr.jpg',
      overview:
        'Durante mais uma disputa eletrizante nas pistas, o campeão Relâmpago McQueen sofre um grave acidente e precisa da ajuda da jovem treinadora Cruz Ramirez para voltar às pistas.',
      addedAt: 1794176577000
    },
    {
      id: 'drive_134ZasWjMLyOFSHBcVtxNXvS_ZshNHLgH',
      title: 'Toy Story 5',
      year: '2026',
      rating: '8.3',
      category: 'Animação & Família',
      featured: false,
      driveFileId: '134ZasWjMLyOFSHBcVtxNXvS_ZshNHLgH',
      rawUrl: 'https://drive.google.com/file/d/134ZasWjMLyOFSHBcVtxNXvS_ZshNHLgH/view',
      streamUrl: '/api/gdrive/stream/134ZasWjMLyOFSHBcVtxNXvS_ZshNHLgH',
      poster: 'https://image.tmdb.org/t/p/w500/jTN1hdfP88Km63waezqIN1uUqT3.jpg',
      backdrop: 'https://image.tmdb.org/t/p/original/qjTqY5coNiz6sVtPng40IzltsoN.jpg',
      overview:
        'O trabalho de Buzz, Woody, Jessie e do resto da gangue fica exponencialmente mais difícil quando eles enfrentam uma nova ameaça à diversão: a tecnologia.',
      addedAt: 1794174767601
    },
    {
      id: 'drive_17CjmCYWUpjB8XlwobdKI7fCTE8Va-wpq',
      title: 'Harry Potter e o Prisioneiro de Azkaban',
      year: '2004',
      rating: '8.0',
      category: 'Ficção & Fantasia',
      featured: true,
      driveFileId: '17CjmCYWUpjB8XlwobdKI7fCTE8Va-wpq',
      rawUrl: 'https://drive.google.com/file/d/17CjmCYWUpjB8XlwobdKI7fCTE8Va-wpq/view',
      streamUrl: '/api/gdrive/stream/17CjmCYWUpjB8XlwobdKI7fCTE8Va-wpq',
      poster: 'https://image.tmdb.org/t/p/w500/1HdMUghqlgOIvbsU9ZtO40IPRzl.jpg',
      backdrop: 'https://image.tmdb.org/t/p/original/htmYEfH7TQgzsXHCnNXxmoYKQtL.jpg',
      overview:
        'É o início do terceiro ano na escola de magia e bruxaria de Hogwarts. Harry, Ron e Hermione têm muito o que aprender, mas Sirius Black escapou de Azkaban.',
      addedAt: 1794174767433
    },
    {
      id: 'drive_1FxU_dp2EAkrYdvg1pBXqb-kILHoUnQ5Z',
      title: 'Procurando Nemo',
      year: '2003',
      rating: '7.8',
      category: 'Animação & Família',
      featured: false,
      driveFileId: '1FxU_dp2EAkrYdvg1pBXqb-kILHoUnQ5Z',
      rawUrl: 'https://drive.google.com/file/d/1FxU_dp2EAkrYdvg1pBXqb-kILHoUnQ5Z/view',
      streamUrl: '/api/gdrive/stream/1FxU_dp2EAkrYdvg1pBXqb-kILHoUnQ5Z',
      poster: 'https://image.tmdb.org/t/p/w500/djbivExXSZb0sTO8uYaaQC5vMRM.jpg',
      backdrop: 'https://image.tmdb.org/t/p/original/eCynaAOgYYiw5yN5lBwz3IxqvaW.jpg',
      overview:
        'Nemo, um jovem peixe-palhaço aventureiro, é levado da Grande Barreira de Corais para um aquário. Cabe ao seu pai Marlin e à simpática Dory atravessar o oceano para resgatá-lo.',
      addedAt: 1794173573099
    },
    {
      id: 'drive_1TkM-Ch8w6lBDyc3DdJL1rZmdLyBwBd3e',
      title: 'Chicago P.D.: Distrito 21',
      year: '2014',
      rating: '8.4',
      category: 'Séries & Episódios',
      featured: false,
      driveFileId: '1TkM-Ch8w6lBDyc3DdJL1rZmdLyBwBd3e',
      rawUrl: 'https://drive.google.com/file/d/1TkM-Ch8w6lBDyc3DdJL1rZmdLyBwBd3e/view',
      streamUrl: '/api/gdrive/stream/1TkM-Ch8w6lBDyc3DdJL1rZmdLyBwBd3e',
      poster: 'https://image.tmdb.org/t/p/w500/3k9YHHlENlcIT8g2BqeXsaDI2Hh.jpg',
      backdrop: 'https://image.tmdb.org/t/p/original/18KSsDgcGQds7yOMC6MVRTbVJwt.jpg',
      overview:
        'O Distrito 21 do Departamento de Polícia de Chicago é composto pelos policiais uniformizados e pela Unidade de Inteligência que combate o crime organizado.',
      addedAt: 1794173572919
    },
    {
      id: 'drive_1WVL9lFYRRomMsvAibEukp1jrj7VX6CHm',
      title: 'Lilo & Stitch',
      year: '2025',
      rating: '7.8',
      category: 'Animação & Família',
      featured: true,
      driveFileId: '1WVL9lFYRRomMsvAibEukp1jrj7VX6CHm',
      rawUrl: 'https://drive.google.com/file/d/1WVL9lFYRRomMsvAibEukp1jrj7VX6CHm/view',
      streamUrl: '/api/gdrive/stream/1WVL9lFYRRomMsvAibEukp1jrj7VX6CHm',
      poster: 'https://image.tmdb.org/t/p/w500/ottRXMCQ9jPB318syTcfIdtJWIE.jpg',
      backdrop: 'https://image.tmdb.org/t/p/original/AcxbOWUbwtIEDisfuhNGHQNfnMK.jpg',
      overview:
        'Stitch, um experimento alienígena, cai no Havaí e é adotado pela jovem Lilo, aprendendo o significado de Ohana (família).',
      addedAt: 1794173572650
    },
    {
      id: 'drive_1RFhTNE1ygeKhGa8w5ysN3Vo6UexRXYnn',
      title: 'A Princesa e o Sapo',
      year: '2009',
      rating: '7.2',
      category: 'Animação & Família',
      featured: false,
      driveFileId: '1RFhTNE1ygeKhGa8w5ysN3Vo6UexRXYnn',
      rawUrl: 'https://drive.google.com/file/d/1RFhTNE1ygeKhGa8w5ysN3Vo6UexRXYnn/view',
      streamUrl: '/api/gdrive/stream/1RFhTNE1ygeKhGa8w5ysN3Vo6UexRXYnn',
      poster: 'https://image.tmdb.org/t/p/w500/z21DCxiT2h0AnZsqp8VjFdHJw0N.jpg',
      backdrop: 'https://image.tmdb.org/t/p/w500/z21DCxiT2h0AnZsqp8VjFdHJw0N.jpg',
      overview:
        'Trabalhadora e ambiciosa, Tiana sonha em abrir seu próprio restaurante em Nova Orleans, mas tudo muda quando ela conhece o príncipe Naveen transformado em sapo.',
      addedAt: 1794173572491
    },
    {
      id: 'drive_19pYQK72iWgHojbZeAJ5cjfmexFoyu4DN',
      title: 'Barbie: A Princesa e a Pop Star',
      year: '2012',
      rating: '7.4',
      category: 'Animação & Família',
      featured: false,
      driveFileId: '19pYQK72iWgHojbZeAJ5cjfmexFoyu4DN',
      rawUrl: 'https://drive.google.com/file/d/19pYQK72iWgHojbZeAJ5cjfmexFoyu4DN/view',
      streamUrl: '/api/gdrive/stream/19pYQK72iWgHojbZeAJ5cjfmexFoyu4DN',
      poster: 'https://image.tmdb.org/t/p/w500/dMxSConpq47TFVTV6tcBTNIVvZp.jpg',
      backdrop: 'https://image.tmdb.org/t/p/original/kCQKdkfNc7Smox53QRalBO3Doe0.jpg',
      overview:
        'A princesa Tori e sua pop star favorita Keira descobrem que têm muito em comum e usam sua magia para trocar de lugar!',
      addedAt: 1794173572331
    },
    {
      id: 'drive_1WMuYuKP2UCWOrIdeN8twMuBD6DxRC5Y2',
      title: 'Barbie: Escola de Princesas',
      year: '2011',
      rating: '7.6',
      category: 'Animação & Família',
      featured: false,
      driveFileId: '1WMuYuKP2UCWOrIdeN8twMuBD6DxRC5Y2',
      rawUrl: 'https://drive.google.com/file/d/1WMuYuKP2UCWOrIdeN8twMuBD6DxRC5Y2/view',
      streamUrl: '/api/gdrive/stream/1WMuYuKP2UCWOrIdeN8twMuBD6DxRC5Y2',
      poster: 'https://image.tmdb.org/t/p/w500/3jNK0WP5qDewsdJQl88qFy3Xu8v.jpg',
      backdrop: 'https://image.tmdb.org/t/p/original/jXD8EoKLyiQzfjWc125hrAzcJ07.jpg',
      overview:
        'Blair Willows é sorteada para frequentar a exclusiva Escola de Princesas e descobre um segredo real que pode mudar todo o reino.',
      addedAt: 1794173572169
    },
    {
      id: 'drive_1vlQOZLfXBkACbwSg4N1x68yzfKZXA8X_',
      title: 'Uma Sexta-Feira Mais Louca Ainda',
      year: '2025',
      rating: '6.8',
      category: 'Comédia',
      featured: false,
      driveFileId: '1vlQOZLfXBkACbwSg4N1x68yzfKZXA8X_',
      rawUrl: 'https://drive.google.com/file/d/1vlQOZLfXBkACbwSg4N1x68yzfKZXA8X_/view',
      streamUrl: '/api/gdrive/stream/1vlQOZLfXBkACbwSg4N1x68yzfKZXA8X_',
      poster: 'https://image.tmdb.org/t/p/w500/zAeOSpIY5FfaF4RhuZgUWyWF0VH.jpg',
      backdrop: 'https://image.tmdb.org/t/p/original/yQy9Y3p5INwkfTuHSnzYnz4MCV3.jpg',
      overview:
        'Anos depois de Tess e Anna passarem por uma crise de identidade, um novo feitiço faz a família inteira trocar de corpo novamente.',
      addedAt: 1794173249678
    },
    {
      id: 'drive_1R9PXGjplmt9f2kCQsQv1DzPpZJe7i3BT',
      title: 'Máquina de Guerra',
      year: '2026',
      rating: '7.5',
      category: 'Ação & Aventura',
      featured: true,
      driveFileId: '1R9PXGjplmt9f2kCQsQv1DzPpZJe7i3BT',
      rawUrl: 'https://drive.google.com/file/d/1R9PXGjplmt9f2kCQsQv1DzPpZJe7i3BT/view',
      streamUrl: '/api/gdrive/stream/1R9PXGjplmt9f2kCQsQv1DzPpZJe7i3BT',
      poster: 'https://image.tmdb.org/t/p/w500/48h40o6Q97hZaqH0g7bOiXOrImX.jpg',
      backdrop: 'https://image.tmdb.org/t/p/original/6yeVcxFR0j08vlv2OlL6zbewm4D.jpg',
      overview:
        'Em sua última missão de treinamento, um engenheiro de combate precisa liderar sua equipe de elite em uma luta pela sobrevivência contra uma máquina mortal.',
      addedAt: 1794173249512
    },
    {
      id: 'drive_11PUCi0OoEV2hsP5iZW3E-0IPt5bKL6Ka',
      title: 'Velozes & Furiosos 7',
      year: '2015',
      rating: '7.2',
      category: 'Ação & Aventura',
      featured: true,
      driveFileId: '11PUCi0OoEV2hsP5iZW3E-0IPt5bKL6Ka',
      rawUrl: 'https://drive.google.com/file/d/11PUCi0OoEV2hsP5iZW3E-0IPt5bKL6Ka/view',
      streamUrl: '/api/gdrive/stream/11PUCi0OoEV2hsP5iZW3E-0IPt5bKL6Ka',
      poster: 'https://image.tmdb.org/t/p/w500/spydMyyD81HjGJVwZvjajkrWW1h.jpg',
      backdrop: 'https://image.tmdb.org/t/p/original/ehzI1mVcnHqB58NqPyQwpMqcVoz.jpg',
      overview:
        'Deckard Shaw busca vingança contra Dominic Toretto e sua família. Dom, Brian e toda a equipe se reúnem para mais uma missão impossível.',
      addedAt: 1794172838591
    },
    {
      id: 'drive_1sOZ4eAXNWvLH8xy76Y5PZqSvcYm9APAk',
      title: 'Bird Box',
      year: '2018',
      rating: '6.8',
      category: 'Terror & Suspense',
      featured: true,
      driveFileId: '1sOZ4eAXNWvLH8xy76Y5PZqSvcYm9APAk',
      rawUrl: 'https://drive.google.com/file/d/1sOZ4eAXNWvLH8xy76Y5PZqSvcYm9APAk/view',
      streamUrl: '/api/gdrive/stream/1sOZ4eAXNWvLH8xy76Y5PZqSvcYm9APAk',
      poster: 'https://image.tmdb.org/t/p/w500/kTHDVXVTT62gJY9WfZnaXdmtvZE.jpg',
      backdrop: 'https://image.tmdb.org/t/p/original/pDKFL1zcHzEpmz4MJA5JJnRbJeD.jpg',
      overview:
        'Uma misteriosa presença dizima grande parte da sociedade. Cinco anos depois, Malorie e seus dois filhos saem de olhos vendados pelo rio em busca de um abrigo seguro.',
      addedAt: 1794172838434
    },
    {
      id: 'drive_10DYzJO7xYqUwVqyaXGtB7mtmDUf_4TlQ',
      title: 'Por Água Abaixo',
      year: '2006',
      rating: '6.3',
      category: 'Animação & Família',
      featured: false,
      driveFileId: '10DYzJO7xYqUwVqyaXGtB7mtmDUf_4TlQ',
      rawUrl: 'https://drive.google.com/file/d/10DYzJO7xYqUwVqyaXGtB7mtmDUf_4TlQ/view',
      streamUrl: '/api/gdrive/stream/10DYzJO7xYqUwVqyaXGtB7mtmDUf_4TlQ',
      poster: 'https://image.tmdb.org/t/p/w500/w6ODQ3TOsBtI1gDRYfQ4nucA1Qj.jpg',
      backdrop: 'https://image.tmdb.org/t/p/original/7xQk3HdCvkNmk3gblDGn9fVnbsT.jpg',
      overview:
        'Roddy St. James, um mimado ratinho de estimação, entra literalmente pelo cano e vai parar em uma agitada cidade subterrânea.',
      addedAt: 1794171659286
    },
    {
      id: 'drive_1XOa5GObpQn2urVO8EeTl2o7omZCTpwXN',
      title: 'Capitão América: Guerra Civil',
      year: '2016',
      rating: '7.5',
      category: 'Ação & Aventura',
      featured: true,
      driveFileId: '1XOa5GObpQn2urVO8EeTl2o7omZCTpwXN',
      rawUrl: 'https://drive.google.com/file/d/1XOa5GObpQn2urVO8EeTl2o7omZCTpwXN/view',
      streamUrl: '/api/gdrive/stream/1XOa5GObpQn2urVO8EeTl2o7omZCTpwXN',
      poster: 'https://image.tmdb.org/t/p/w500/dsvUR5aEVSkB1Sro7nT6Khqik71.jpg',
      backdrop: 'https://image.tmdb.org/t/p/original/7FWlcZq3r6525LWOcvO9kNWurN1.jpg',
      overview:
        'Depois do ataque de Ultron, os governos mundiais decidem controlar os Vingadores, colocando o Capitão América em rota de colisão com o Homem de Ferro.',
      addedAt: 1794171659115
    },
    {
      id: 'drive_1UPS01K81aZYh6sofmAUkwBjFYN7D09RH',
      title: 'Coração Selvagem',
      year: '2026',
      rating: '7.3',
      category: 'Ação & Aventura',
      featured: false,
      driveFileId: '1UPS01K81aZYh6sofmAUkwBjFYN7D09RH',
      rawUrl: 'https://drive.google.com/file/d/1UPS01K81aZYh6sofmAUkwBjFYN7D09RH/view',
      streamUrl: '/api/gdrive/stream/1UPS01K81aZYh6sofmAUkwBjFYN7D09RH',
      poster: 'https://image.tmdb.org/t/p/w500/n4PJa4xVo4SjIsBvTA0yGMKjTBh.jpg',
      backdrop: 'https://image.tmdb.org/t/p/original/kpqsljPQtWqPKJBTAEtoXtQZ9Ko.jpg',
      overview:
        'Um ex-soldado ferido e seu cão de guerra aposentado lutam para sobreviver na região selvagem do Alasca após um acidente aéreo.',
      addedAt: 1794170087996
    },
    {
      id: 'drive_1iZOHBAZExihvaMAlTSkcqsxYZRqkqULV',
      title: 'Hot Wheels AcceleRacers 1: Ignição',
      year: '2005',
      rating: '8.1',
      category: 'Animação & Família',
      featured: false,
      driveFileId: '1iZOHBAZExihvaMAlTSkcqsxYZRqkqULV',
      rawUrl: 'https://drive.google.com/file/d/1iZOHBAZExihvaMAlTSkcqsxYZRqkqULV/view',
      streamUrl: '/api/gdrive/stream/1iZOHBAZExihvaMAlTSkcqsxYZRqkqULV',
      poster: 'https://image.tmdb.org/t/p/w500/h5ekLNgBiSvKBdoC8l0rWiNK3Tg.jpg',
      backdrop: 'https://image.tmdb.org/t/p/w500/h5ekLNgBiSvKBdoC8l0rWiNK3Tg.jpg',
      overview:
        'O Dr. Tezla convoca os melhores pilotos das equipes Teku e Metal Maniacs para encarar os Reinos de Corrida contra os Racing Drones (4K Remastered).',
      addedAt: 1794169458458
    },
    {
      id: 'drive_1yZDOGrt0uDuxJMV49tKtWZLp08WPMmm6',
      title: 'Hot Wheels AcceleRacers 2: A Velocidade do Silêncio',
      year: '2005',
      rating: '8.2',
      category: 'Animação & Família',
      featured: false,
      driveFileId: '1yZDOGrt0uDuxJMV49tKtWZLp08WPMmm6',
      rawUrl: 'https://drive.google.com/file/d/1yZDOGrt0uDuxJMV49tKtWZLp08WPMmm6/view',
      streamUrl: '/api/gdrive/stream/1yZDOGrt0uDuxJMV49tKtWZLp08WPMmm6',
      poster: 'https://image.tmdb.org/t/p/w500/h5ekLNgBiSvKBdoC8l0rWiNK3Tg.jpg',
      backdrop: 'https://image.tmdb.org/t/p/w500/h5ekLNgBiSvKBdoC8l0rWiNK3Tg.jpg',
      overview:
        'Os pilotos Teku e Metal Maniacs enfrentam o Reino da Água e o Reino da Metrópole enquanto os misteriosos Silencerz entram na disputa (4K Remastered).',
      addedAt: 1794169458321
    },
    {
      id: 'drive_1JtQCKY79dzXi4VnicZp-3w3i_j7lKaJP',
      title: 'Hot Wheels AcceleRacers 3: Ponto de Ruptura',
      year: '2005',
      rating: '8.3',
      category: 'Animação & Família',
      featured: false,
      driveFileId: '1JtQCKY79dzXi4VnicZp-3w3i_j7lKaJP',
      rawUrl: 'https://drive.google.com/file/d/1JtQCKY79dzXi4VnicZp-3w3i_j7lKaJP/view',
      streamUrl: '/api/gdrive/stream/1JtQCKY79dzXi4VnicZp-3w3i_j7lKaJP',
      poster: 'https://image.tmdb.org/t/p/w500/h5ekLNgBiSvKBdoC8l0rWiNK3Tg.jpg',
      backdrop: 'https://image.tmdb.org/t/p/w500/h5ekLNgBiSvKBdoC8l0rWiNK3Tg.jpg',
      overview:
        'A disputa pelos AcceleChargers se intensifica entre os humanos, os Racing Drones e os Silencerz (4K Remastered).',
      addedAt: 1794169458183
    },
    {
      id: 'drive_1ITsZwQ8Bmk35OQRtdpWSz8bKjk-w_Krr',
      title: 'Hot Wheels AcceleRacers 4: A Corrida Final',
      year: '2005',
      rating: '8.5',
      category: 'Animação & Família',
      featured: false,
      driveFileId: '1ITsZwQ8Bmk35OQRtdpWSz8bKjk-w_Krr',
      rawUrl: 'https://drive.google.com/file/d/1ITsZwQ8Bmk35OQRtdpWSz8bKjk-w_Krr/view',
      streamUrl: '/api/gdrive/stream/1ITsZwQ8Bmk35OQRtdpWSz8bKjk-w_Krr',
      poster: 'https://image.tmdb.org/t/p/w500/h5ekLNgBiSvKBdoC8l0rWiNK3Tg.jpg',
      backdrop: 'https://image.tmdb.org/t/p/w500/h5ekLNgBiSvKBdoC8l0rWiNK3Tg.jpg',
      overview:
        'Vert Wheeler enfrenta Gelorum na Corrida Cósmica definitiva enquanto os Teku e Metal Maniacs invadem o quartel-general dos Drones (4K Remastered).',
      addedAt: 1794169458037
    }
  ];

  // Elementos DOM Gerais
  const lobbyModal = document.getElementById('lobbyModal');
  const joinForm = document.getElementById('joinForm');
  const userNameInput = document.getElementById('userNameInput');
  const roomIdInput = document.getElementById('roomIdInput');
  const roomPasswordInput = document.getElementById('roomPasswordInput');
  const lobbyError = document.getElementById('lobbyError');
  const avatarPicker = document.getElementById('avatarPicker');
  const activeRoomsSection = document.getElementById('activeRoomsSection');
  const activeRoomsList = document.getElementById('activeRoomsList');

  const logoHomeBtn = document.getElementById('logoHomeBtn');
  const navCatalogBtn = document.getElementById('navCatalogBtn');
  const navCinemaRoomBtn = document.getElementById('navCinemaRoomBtn');
  const navMovieShort = document.getElementById('navMovieShort');
  const streamingHomeView = document.getElementById('streamingHomeView');
  const cinemaRoomView = document.getElementById('cinemaRoomView');

  const globalSearchInput = document.getElementById('globalSearchInput');
  const globalSearchClearBtn = document.getElementById('globalSearchClearBtn');
  const searchResultsSection = document.getElementById('searchResultsSection');
  const searchResultsTitle = document.getElementById('searchResultsTitle');
  const searchResultsGrid = document.getElementById('searchResultsGrid');
  const backToHomeRowsBtn = document.getElementById('backToHomeRowsBtn');

  // Vitrine Streaming do Google Drive
  const heroBanner = document.getElementById('heroBanner');
  const heroRating = document.getElementById('heroRating');
  const heroYear = document.getElementById('heroYear');
  const heroTitle = document.getElementById('heroTitle');
  const heroOverview = document.getElementById('heroOverview');
  const heroWatchNowBtn = document.getElementById('heroWatchNowBtn');
  const heroManageDriveBtn = document.getElementById('heroManageDriveBtn');
  const streamingRowsContainer = document.getElementById('streamingRowsContainer');

  // Modal de Gerenciamento do Google Drive
  const driveManagerModal = document.getElementById('driveManagerModal');
  const openDriveManagerBtn = document.getElementById('openDriveManagerBtn');
  const openDriveFromRoomBtn = document.getElementById('openDriveFromRoomBtn');
  const closeDriveManagerBtn = document.getElementById('closeDriveManagerBtn');
  const syncFolderForm = document.getElementById('syncFolderForm');
  const driveFolderUrlInput = document.getElementById('driveFolderUrlInput');
  const driveFolderCategorySelect = document.getElementById('driveFolderCategorySelect');
  const syncFolderSubmitBtn = document.getElementById('syncFolderSubmitBtn');
  const syncFolderStatus = document.getElementById('syncFolderStatus');

  const addSingleMovieForm = document.getElementById('addSingleMovieForm');
  const singleMovieTitle = document.getElementById('singleMovieTitle');
  const autoFillMetaBtn = document.getElementById('autoFillMetaBtn');
  const singleMovieUrl = document.getElementById('singleMovieUrl');
  const singleMovieCategory = document.getElementById('singleMovieCategory');
  const singleMovieYear = document.getElementById('singleMovieYear');
  const singleMoviePoster = document.getElementById('singleMoviePoster');
  const singleMovieBackdrop = document.getElementById('singleMovieBackdrop');
  const singleMovieOverview = document.getElementById('singleMovieOverview');
  const managerMoviesCount = document.getElementById('managerMoviesCount');
  const managerMoviesList = document.getElementById('managerMoviesList');

  // Modal de Detalhes do Filme
  const movieDetailModal = document.getElementById('movieDetailModal');
  const closeDetailModal = document.getElementById('closeDetailModal');
  const detailBackdrop = document.getElementById('detailBackdrop');
  const detailCategoryBadge = document.getElementById('detailCategoryBadge');
  const detailRatingBadge = document.getElementById('detailRatingBadge');
  const detailYearBadge = document.getElementById('detailYearBadge');
  const detailTitle = document.getElementById('detailTitle');
  const detailOverview = document.getElementById('detailOverview');
  const playDriveMovieNowBtn = document.getElementById('playDriveMovieNowBtn');
  const deleteDriveMovieBtn = document.getElementById('deleteDriveMovieBtn');

  // Sala de Cinema e Player Nativo Cine Pompeia
  const roomNameDisplay = document.getElementById('roomNameDisplay');
  const seatCountBadge = document.getElementById('seatCountBadge');
  const copyInviteBtn = document.getElementById('copyInviteBtn');
  const toggleLightsBtn = document.getElementById('toggleLightsBtn');
  const toggleControlModeBtn = document.getElementById('toggleControlModeBtn');
  const lightsOverlay = document.getElementById('lightsOverlay');
  const clapperSyncBtn = document.getElementById('clapperSyncBtn');
  const useNativeStreamBtn = document.getElementById('useNativeStreamBtn');
  const useDrivePreviewBtn = document.getElementById('useDrivePreviewBtn');

  const screenWrapper = document.getElementById('screenWrapper');
  const playerBackToCatalogBtn = document.getElementById('playerBackToCatalogBtn');
  const drivePreviewIframe = document.getElementById('drivePreviewIframe');
  const cineNativePlayerContainer = document.getElementById('cineNativePlayerContainer');
  const nativeVideo = document.getElementById('nativeVideo');
  const nativeSourcesDrawer = document.getElementById('nativeSourcesDrawer');
  const closeSourcesDrawerBtn = document.getElementById('closeSourcesDrawerBtn');
  const nativeCenterPlayBtn = document.getElementById('nativeCenterPlayBtn');
  const nativeSeekBar = document.getElementById('nativeSeekBar');
  const nativePlayPauseBtn = document.getElementById('nativePlayPauseBtn');
  const nativeRewindBtn = document.getElementById('nativeRewindBtn');
  const nativeForwardBtn = document.getElementById('nativeForwardBtn');
  const nativeMuteBtn = document.getElementById('nativeMuteBtn');
  const nativeVolumeBar = document.getElementById('nativeVolumeBar');
  const nativeTimeLabel = document.getElementById('nativeTimeLabel');
  const nativeSettingsGearBtn = document.getElementById('nativeSettingsGearBtn');
  const nativeCastSyncBtn = document.getElementById('nativeCastSyncBtn');
  const nativeDownloadBtn = document.getElementById('nativeDownloadBtn');
  const nativeFullscreenBtn = document.getElementById('nativeFullscreenBtn');
  const screenReactionsLayer = document.getElementById('screenReactionsLayer');

  const syncModeIndicator = document.getElementById('syncModeIndicator');
  const syncTimerDisplay = document.getElementById('syncTimerDisplay');
  const resyncMeBtn = document.getElementById('resyncMeBtn');

  const seatRowA = document.getElementById('seatRowA');
  const seatRowB = document.getElementById('seatRowB');

  const currentMoviePoster = document.getElementById('currentMoviePoster');
  const currentMovieIds = document.getElementById('currentMovieIds');
  const currentMovieHeading = document.getElementById('currentMovieHeading');
  const currentMovieOverview = document.getElementById('currentMovieOverview');

  const onlineFriendsCount = document.getElementById('onlineFriendsCount');
  const chatMessages = document.getElementById('chatMessages');
  const chatForm = document.getElementById('chatForm');
  const chatInput = document.getElementById('chatInput');

  const clapperOverlay = document.getElementById('clapperOverlay');
  const clapperCount = document.getElementById('clapperCount');
  const clapperSub = document.getElementById('clapperSub');

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function extractDriveFileId(input) {
    const str = String(input || '').trim();
    if (!str) return null;
    if (/^[a-zA-Z0-9_-]{25,55}$/.test(str)) return str;
    const m1 = str.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (m1 && m1[1]) return m1[1];
    const m2 = str.match(/\/gdrive\/stream\/([a-zA-Z0-9_-]+)/);
    if (m2 && m2[1]) return m2[1];
    const m3 = str.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m3 && m3[1]) return m3[1];
    return null;
  }

  function extractDriveFolderId(input) {
    const str = String(input || '').trim();
    if (!str) return null;
    if (/^[a-zA-Z0-9_-]{25,55}$/.test(str)) return str;
    const matchFolder = str.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (matchFolder && matchFolder[1]) return matchFolder[1];
    const matchIdParam = str.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (matchIdParam && matchIdParam[1]) return matchIdParam[1];
    return null;
  }

  function parseMovieFilenameClient(filename) {
    let clean = String(filename || '')
      .replace(/&amp;/gi, '&')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/gi, '"')
      .replace(/\.(mp4|mkv|webm|avi|mov|m4v)$/i, '')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/[._]/g, ' ')
      .replace(/^\s*\d{1,3}\s*[-.]\s*/, '');

    const yearMatch = clean.match(/\b(19\d{2}|20\d{2})\b/);
    const year = yearMatch ? yearMatch[1] : '';

    clean = clean
      .replace(
        /\b(open\s*matte|imax|remastered|1080p|720p|2160p|4k|blu-?ray|web-?dl|webrip|hdrip|x264|x265|h264|h265|hevc|aac|ac3|dual|dublado|legendado|pt-?br|5\.1|brshares)\b.*/i,
        ''
      )
      .replace(/\(\s*(19\d{2}|20\d{2})\s*\)/g, '')
      .replace(/\([^)]*\)/g, '')
      .replace(/\b(19\d{2}|20\d{2})\b/g, '')
      .replace(/[-–—]+\s*$/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    return {
      title: clean || filename,
      year: year || new Date().getFullYear().toString()
    };
  }

  function isCloudHost() {
    const h = window.location.hostname;
    return h !== 'localhost' && h !== '127.0.0.1';
  }

  function getOptimalPlayerType() {
    // Sempre usa o Player Nativo CINE POMPEIA por padrão!
    return 'native';
  }

  function loadLocalMoviesBackup() {
    const merged = new Map();
    for (const m of DEFAULT_LOCAL_MOVIES) {
      merged.set(m.id, m);
    }
    try {
      const saved = localStorage.getItem('cine_pompeia_drive_movies_v2');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          for (const m of parsed) {
            if (m && m.id && m.id !== 'demo_1' && m.id !== 'demo_2') {
              merged.set(m.id, m);
            }
          }
        }
      }
    } catch (_) {}
    return Array.from(merged.values());
  }

  function saveLocalMoviesBackup(movies) {
    try {
      localStorage.setItem('cine_pompeia_drive_movies_v2', JSON.stringify(movies));
    } catch (_) {}
  }

  function switchMainView(view) {
    if (view === 'cinema') {
      streamingHomeView.classList.add('hidden');
      cinemaRoomView.classList.remove('hidden');
      navCinemaRoomBtn.classList.add('active');
      navCatalogBtn.classList.remove('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      cinemaRoomView.classList.add('hidden');
      streamingHomeView.classList.remove('hidden');
      navCatalogBtn.classList.add('active');
      navCinemaRoomBtn.classList.remove('active');
    }
  }

  logoHomeBtn.addEventListener('click', () => switchMainView('catalog'));
  navCatalogBtn.addEventListener('click', () => switchMainView('catalog'));
  navCinemaRoomBtn.addEventListener('click', () => switchMainView('cinema'));
  playerBackToCatalogBtn.addEventListener('click', () => switchMainView('catalog'));

  // ==========================================
  // CAMADA DE COMUNICAÇÃO UNIFICADA (SOCKET.IO OU PEERJS WEBRTC P2P NA VERCEL/GITHUB PAGES)
  // ==========================================
  function sendRoomAction(event, payload) {
    if (!useServerlessP2P && socket && socket.connected) {
      socket.emit(event, payload);
      return;
    }
    // Modo Serverless P2P (Vercel / GitHub Pages)
    if (isP2PHost) {
      handleP2PActionAsHost(mySocketId, event, payload);
    } else if (guestConnToHost && guestConnToHost.open) {
      guestConnToHost.send({ event, payload });
    }
  }

  function broadcastFromP2PHost(event, data) {
    for (const conn of hostConnections.values()) {
      if (conn && conn.open) {
        try {
          conn.send({ event, data });
        } catch (_) {}
      }
    }
    // Aplica também no próprio Host
    handleIncomingRoomEvent(event, data);
  }

  function handleIncomingRoomEvent(event, data) {
    if (event === 'room_state') {
      applyRoomState(data);
    } else if (event === 'media_changed') {
      if (!roomState) return;
      roomState.media = data.media;
      roomState.playback = data.playback;
      updatePlayerMedia(data.media, data.playback);
      switchMainView('cinema');
    } else if (event === 'playback_sync') {
      if (!roomState) return;
      roomState.playback = {
        status: data.status,
        currentTime: data.currentTime,
        playbackRate: data.playbackRate,
        serverTimestamp: Date.now()
      };
      applyPlaybackToNativeVideo(roomState.playback);
    } else if (event === 'playback_heartbeat') {
      if (!roomState) return;
      roomState.playback = {
        status: data.status,
        currentTime: data.currentTime,
        playbackRate: data.playbackRate,
        serverTimestamp: Date.now()
      };
      const drift = Math.abs(nativeVideo.currentTime - data.currentTime);
      if (drift > 2.2) {
        applyPlaybackToNativeVideo(roomState.playback);
      }
    } else if (event === 'clapperboard_countdown') {
      runClapperboardVisual(data);
    } else if (event === 'chat_message') {
      appendChatMessage(data);
    } else if (event === 'seat_reaction') {
      spawnFloatingReaction(data);
    } else if (event === 'catalog_synced') {
      if (Array.isArray(data.movies) && data.movies.length > 0) {
        allDriveMovies = data.movies;
        saveLocalMoviesBackup(allDriveMovies);
        renderCatalogFromMoviesList(allDriveMovies, currentCategory, '');
      }
    }
  }

  function handleP2PActionAsHost(senderId, event, payload) {
    if (!roomState) return;
    const canCtrl = roomState.hostSocketId === senderId || roomState.freeControl;
    const participant = roomState.seats.find((s) => s && s.socketId === senderId);

    if (event === 'select_seat') {
      const idx = Number(payload.seatIndex);
      if (idx >= 0 && idx < 12 && (!roomState.seats[idx] || roomState.seats[idx].socketId === senderId)) {
        const oldIdx = roomState.seats.findIndex((s) => s && s.socketId === senderId);
        if (oldIdx >= 0 && participant) {
          roomState.seats[oldIdx] = null;
          participant.seatIndex = idx;
          roomState.seats[idx] = participant;
          const seatLabel = idx < 6 ? `A${idx + 1}` : `B${idx - 5}`;
          broadcastSystemChat(`${participant.avatar} ${participant.name} mudou para a poltrona ${seatLabel}.`);
          broadcastFromP2PHost('room_state', roomState);
        }
      }
    } else if (event === 'change_media' && canCtrl) {
      roomState.media = { ...roomState.media, ...payload };
      roomState.playback = { status: 'paused', currentTime: 0, playbackRate: 1, serverTimestamp: Date.now() };
      if (participant && payload.title) {
        broadcastSystemChat(`🎬 ${participant.name} colocou no telão: "${roomState.media.title}"`);
      }
      broadcastFromP2PHost('media_changed', { media: roomState.media, playback: roomState.playback });
      broadcastFromP2PHost('room_state', roomState);
    } else if (event === 'playback_command' && canCtrl) {
      roomState.playback.status = payload.action === 'play' ? 'playing' : payload.action === 'pause' ? 'paused' : roomState.playback.status;
      if (typeof payload.currentTime === 'number') roomState.playback.currentTime = payload.currentTime;
      if (typeof payload.playbackRate === 'number') roomState.playback.playbackRate = payload.playbackRate;
      roomState.playback.serverTimestamp = Date.now();
      broadcastFromP2PHost('playback_sync', {
        action: payload.action,
        status: roomState.playback.status,
        currentTime: roomState.playback.currentTime,
        playbackRate: roomState.playback.playbackRate
      });
    } else if (event === 'trigger_clapperboard' && canCtrl) {
      roomState.playback = { status: 'playing', currentTime: payload.targetTime || 0, playbackRate: 1, serverTimestamp: Date.now() };
      broadcastFromP2PHost('clapperboard_countdown', {
        targetTime: payload.targetTime || 0,
        actorName: participant ? participant.name : 'Anfitrião'
      });
    } else if (event === 'toggle_room_setting' && roomState.hostSocketId === senderId) {
      if (payload.setting === 'lights') {
        roomState.lightsOff = !roomState.lightsOff;
        broadcastSystemChat(roomState.lightsOff ? '💡 As luzes foram apagadas.' : '💡 As luzes foram acesas.');
      } else if (payload.setting === 'freeControl') {
        roomState.freeControl = !roomState.freeControl;
        broadcastSystemChat(roomState.freeControl ? '🎮 Controle livre ativado!' : '👑 Controle exclusivo do Anfitrião ativado.');
      }
      broadcastFromP2PHost('room_state', roomState);
    } else if (event === 'transfer_host' && roomState.hostSocketId === senderId) {
      roomState.hostSocketId = payload.targetSocketId;
      broadcastFromP2PHost('room_state', roomState);
    } else if (event === 'send_chat' && participant) {
      const seatLabel = participant.seatIndex < 6 ? `A${participant.seatIndex + 1}` : `B${participant.seatIndex - 5}`;
      const msg = {
        id: `${Date.now()}-${Math.random()}`,
        type: 'user',
        socketId: senderId,
        userName: participant.name,
        avatar: participant.avatar,
        seatLabel,
        text: String(payload.text || '').slice(0, 400),
        timestamp: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      };
      roomState.chatHistory.push(msg);
      broadcastFromP2PHost('chat_message', msg);
    } else if (event === 'send_reaction' && participant) {
      broadcastFromP2PHost('seat_reaction', {
        socketId: senderId,
        userName: participant.name,
        seatIndex: participant.seatIndex,
        emoji: payload.emoji || '🍿'
      });
    }
  }

  function broadcastSystemChat(text) {
    if (!roomState) return;
    const msg = {
      id: `${Date.now()}-${Math.random()}`,
      type: 'system',
      text,
      timestamp: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    };
    roomState.chatHistory.push(msg);
    broadcastFromP2PHost('chat_message', msg);
  }

  function startServerlessP2PRoom(roomId, userName, avatar) {
    useServerlessP2P = true;
    const firstMovie = allDriveMovies[0] || DEFAULT_LOCAL_MOVIES[0];
    const myParticipant = {
      socketId: mySocketId,
      name: userName,
      avatar,
      seatIndex: 0,
      joinedAt: Date.now()
    };

    const seats = Array(12).fill(null);
    seats[0] = myParticipant;

    const initialRoom = {
      id: roomId,
      name: `Sessão ${roomId}`,
      hasPassword: false,
      hostSocketId: mySocketId,
      freeControl: false,
      lightsOff: false,
      seats,
      participantCount: 1,
      maxSeats: 12,
      media: {
        id: firstMovie.id,
        title: firstMovie.title,
        year: firstMovie.year || 'HD',
        category: firstMovie.category || 'Google Drive',
        poster: firstMovie.poster,
        backdrop: firstMovie.backdrop || firstMovie.poster,
        overview: firstMovie.overview,
        streamUrl: firstMovie.streamUrl,
        driveFileId: firstMovie.driveFileId || extractDriveFileId(firstMovie.rawUrl),
        playerType: getOptimalPlayerType(firstMovie.driveFileId || extractDriveFileId(firstMovie.rawUrl))
      },
      playback: {
        status: 'paused',
        currentTime: 0,
        playbackRate: 1,
        serverTimestamp: Date.now()
      },
      chatHistory: [
        {
          id: 'welcome_1',
          type: 'system',
          text: `${avatar} ${userName} abriu a sala ${roomId} e sentou na poltrona A1.`,
          timestamp: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        }
      ]
    };

    // Fecha o modal imediatamente para o usuário nunca ficar preso!
    lobbyModal.classList.add('hidden');
    const newUrl = `${window.location.pathname}?room=${encodeURIComponent(roomId)}`;
    window.history.replaceState({}, '', newUrl);
    isP2PHost = true;
    applyRoomState(initialRoom);

    // Conecta via PeerJS (WebRTC) para sincronizar com outros amigos que entrarem no mesmo link da Vercel/GitHub Pages!
    if (typeof window.Peer !== 'function') return;
    const hostPeerId = `cine-pompeia-v2-${roomId.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

    try {
      const peer = new window.Peer(hostPeerId);
      peerInstance = peer;

      peer.on('open', () => {
        isP2PHost = true;
      });

      peer.on('connection', (conn) => {
        conn.on('data', (msg) => {
          if (!msg) return;
          if (msg.event === 'guest_hello') {
            const seatIdx = roomState.seats.findIndex((s) => s === null);
            if (seatIdx === -1) return;
            const guestPart = {
              socketId: msg.guestId,
              name: msg.userName || 'Convidado',
              avatar: msg.avatar || '🍿',
              seatIndex: seatIdx,
              joinedAt: Date.now()
            };
            roomState.seats[seatIdx] = guestPart;
            roomState.participantCount = roomState.seats.filter(Boolean).length;
            hostConnections.set(msg.guestId, conn);

            const seatLabel = seatIdx < 6 ? `A${seatIdx + 1}` : `B${seatIdx - 5}`;
            broadcastSystemChat(`${guestPart.avatar} ${guestPart.name} entrou e sentou na poltrona ${seatLabel}.`);
            broadcastFromP2PHost('room_state', roomState);
            conn.send({ event: 'catalog_synced', data: { movies: allDriveMovies } });
          } else {
            handleP2PActionAsHost(msg.senderId || conn.peer, msg.event, msg.payload);
          }
        });

        conn.on('close', () => {
          for (const [gId, c] of hostConnections.entries()) {
            if (c === conn) {
              hostConnections.delete(gId);
              const sIdx = roomState.seats.findIndex((s) => s && s.socketId === gId);
              if (sIdx >= 0) {
                const leaver = roomState.seats[sIdx];
                roomState.seats[sIdx] = null;
                roomState.participantCount = roomState.seats.filter(Boolean).length;
                broadcastSystemChat(`${leaver.avatar} ${leaver.name} saiu da sala.`);
                broadcastFromP2PHost('room_state', roomState);
              }
            }
          }
        });
      });

      // Se o ID do Host já estiver em uso naquela sala, entra automaticamente como Convidado (Guest) da sala existente!
      peer.on('error', (err) => {
        if (err && err.type === 'unavailable-id') {
          isP2PHost = false;
          const guestPeer = new window.Peer();
          peerInstance = guestPeer;
          guestPeer.on('open', () => {
            const conn = guestPeer.connect(hostPeerId, { reliable: true });
            guestConnToHost = conn;
            conn.on('open', () => {
              conn.send({
                event: 'guest_hello',
                guestId: mySocketId,
                userName,
                avatar
              });
            });
            conn.on('data', (packet) => {
              if (packet && packet.event) {
                handleIncomingRoomEvent(packet.event, packet.data);
              }
            });
          });
        }
      });
    } catch (_) {}
  }

  // ==========================================
  // VITRINE STREAMING DO GOOGLE DRIVE (BACKEND + FALLBACK LOCALSTORAGE)
  // ==========================================
  function renderCatalogFromMoviesList(moviesList, category = 'all', query = '') {
    let filtered = [...moviesList].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

    if (category && category !== 'all') {
      filtered = filtered.filter((m) => (m.category || '').toLowerCase() === String(category).toLowerCase());
    }
    if (query) {
      const q = query.toLowerCase();
      filtered = filtered.filter(
        (m) =>
          (m.title || '').toLowerCase().includes(q) ||
          (m.category || '').toLowerCase().includes(q) ||
          (m.year || '').includes(q)
      );
    }

    renderManagerMoviesList(moviesList);

    if (query) {
      heroBanner.classList.add('hidden');
      streamingRowsContainer.classList.add('hidden');
      searchResultsSection.classList.remove('hidden');
      searchResultsTitle.textContent = `🔍 Resultados no seu Drive para "${query}"`;
      searchResultsGrid.innerHTML =
        filtered.length > 0
          ? filtered.map((m) => createPosterCardHtml(m)).join('')
          : '<p style="color:var(--text-muted);">Nenhum filme encontrado com esse nome no seu catálogo do Drive.</p>';
      bindPosterCardClicks(searchResultsGrid);
      return;
    }

    searchResultsSection.classList.add('hidden');
    heroBanner.classList.remove('hidden');
    streamingRowsContainer.classList.remove('hidden');

    const hero = filtered.find((m) => m.featured && m.backdrop) || filtered[0] || moviesList[0];
    if (hero) {
      currentHeroMovie = hero;
      const bgUrl = hero.backdrop || hero.poster;
      heroBanner.style.backgroundImage = `url('${bgUrl}')`;
      heroRating.textContent = `⭐ ${hero.rating || '8.5'}`;
      heroYear.textContent = hero.year || 'HD';
      heroTitle.textContent = hero.title;
      heroOverview.textContent = hero.overview;
    }

    const rows = [];
    if (filtered.length > 0) {
      rows.push({
        id: 'recent_drive',
        title: '☁️ Adicionados Recentemente no Seu Google Drive',
        style: 'top10',
        items: filtered.slice(0, 10)
      });
    }

    const catMap = new Map();
    for (const m of filtered) {
      const c = m.category || 'Filmes no Google Drive';
      if (!catMap.has(c)) catMap.set(c, []);
      catMap.get(c).push(m);
    }
    for (const [cName, items] of catMap.entries()) {
      rows.push({ id: `cat_${cName}`, title: `🎬 ${cName}`, style: 'standard', items });
    }

    renderStreamingRows(rows);
  }

  async function loadDriveStreamingCatalog(category = 'all', query = '') {
    currentCategory = category;
    const localSaved = loadLocalMoviesBackup();
    const mergedMap = new Map();
    for (const m of localSaved) {
      mergedMap.set(m.id, m);
    }

    try {
      const params = new URLSearchParams({ category: 'all', query: '' });
      const res = await fetch(`/api/drive/catalog?${params.toString()}`);
      if (res.ok) {
        const rawText = await res.text();
        if (rawText) {
          const data = JSON.parse(rawText);
          for (const m of data.movies || []) {
            if (m && m.id && m.id !== 'demo_1' && m.id !== 'demo_2') {
              mergedMap.set(m.id, m);
            }
          }
        }
      }
    } catch (_) {}

    try {
      const staticRes = await fetch('/drive_catalog.json');
      if (staticRes.ok) {
        const staticData = await staticRes.json();
        for (const m of staticData.movies || []) {
          if (m && m.id && !mergedMap.has(m.id)) {
            mergedMap.set(m.id, m);
          }
        }
      }
    } catch (_) {}

    allDriveMovies = Array.from(mergedMap.values());
    saveLocalMoviesBackup(allDriveMovies);
    renderCatalogFromMoviesList(allDriveMovies, category, query);
  }

  function createPosterCardHtml(item) {
    return `
      <div class="stream-card" data-id="${escapeHtml(item.id)}">
        <div class="stream-card-poster">
          <img src="${escapeHtml(item.poster)}" alt="${escapeHtml(item.title)}" loading="lazy" />
          <span class="stream-card-rating">⭐ ${escapeHtml(item.rating || '8.5')}</span>
          <span class="stream-card-native-badge">☁️ DRIVE</span>
          <div class="stream-card-hover">
            <div class="hover-play-pill">▶ Assistir na Sala</div>
          </div>
        </div>
        <div class="stream-card-info">
          <div class="stream-card-title">${escapeHtml(item.title)}</div>
          <div class="stream-card-year">${escapeHtml(item.year || 'HD')} • ${escapeHtml(
      item.category || 'Filme'
    )}</div>
        </div>
      </div>
    `;
  }

  function bindPosterCardClicks(container) {
    container.querySelectorAll('.stream-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        e.stopPropagation();
        const found = allDriveMovies.find((m) => m.id === card.dataset.id);
        if (found) openMovieDetailModal(found);
      });
    });
  }

  function renderStreamingRows(rows) {
    if (!rows || rows.length === 0) {
      streamingRowsContainer.innerHTML = `
        <div style="text-align:center; padding: 3rem 1rem; background: var(--bg-panel); border-radius: 16px; border: 1px solid var(--border-color);">
          <h3 style="color: var(--gold); margin-bottom: 0.5rem;">☁️ Seu Catálogo do Google Drive está pronto para receber seus filmes!</h3>
          <p style="color: var(--text-muted); margin-bottom: 1.2rem;">Clique no botão abaixo para sincronizar uma pasta inteira do seu Google Drive ou adicionar vídeos individuais.</p>
          <button id="emptyStateAddBtn" class="btn-gold btn-large">☁️ Sincronizar Pasta ou Adicionar Filme do Drive</button>
        </div>
      `;
      const btn = document.getElementById('emptyStateAddBtn');
      if (btn) btn.addEventListener('click', () => driveManagerModal.classList.remove('hidden'));
      return;
    }

    streamingRowsContainer.innerHTML = rows
      .filter((r) => Array.isArray(r.items) && r.items.length > 0)
      .map((row) => {
        const cardsHtml =
          row.style === 'top10'
            ? row.items
                .slice(0, 10)
                .map(
                  (item, idx) => `
                  <div class="top10-card" data-id="${escapeHtml(item.id)}">
                    <span class="top10-rank-number">${idx + 1}</span>
                    ${createPosterCardHtml(item)}
                  </div>
                `
                )
                .join('')
            : row.items.map((item) => createPosterCardHtml(item)).join('');

        return `
          <div class="catalog-row">
            <div class="row-header">
              <h3 class="row-title">${escapeHtml(row.title)}</h3>
            </div>
            <div class="row-scroll-wrapper">
              <button class="row-arrow left" aria-label="Anterior">‹</button>
              <div class="row-track">${cardsHtml}</div>
              <button class="row-arrow right" aria-label="Próximo">›</button>
            </div>
          </div>
        `;
      })
      .join('');

    streamingRowsContainer.querySelectorAll('.row-scroll-wrapper').forEach((wrapper) => {
      const track = wrapper.querySelector('.row-track');
      const leftBtn = wrapper.querySelector('.row-arrow.left');
      const rightBtn = wrapper.querySelector('.row-arrow.right');

      leftBtn.addEventListener('click', () => track.scrollBy({ left: -780, behavior: 'smooth' }));
      rightBtn.addEventListener('click', () => track.scrollBy({ left: 780, behavior: 'smooth' }));
    });

    bindPosterCardClicks(streamingRowsContainer);
  }

  heroWatchNowBtn.addEventListener('click', () => {
    if (!currentHeroMovie) return;
    projectDriveMovieToRoom(currentHeroMovie);
  });

  heroManageDriveBtn.addEventListener('click', () => {
    driveManagerModal.classList.remove('hidden');
  });

  document.querySelectorAll('.platform-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.platform-pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      loadDriveStreamingCatalog(pill.dataset.category, '');
    });
  });

  globalSearchInput.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    const q = globalSearchInput.value.trim();
    globalSearchClearBtn.classList.toggle('hidden', !q);
    searchDebounceTimer = setTimeout(() => {
      switchMainView('catalog');
      renderCatalogFromMoviesList(allDriveMovies, currentCategory, q);
    }, 200);
  });

  globalSearchClearBtn.addEventListener('click', () => {
    globalSearchInput.value = '';
    globalSearchClearBtn.classList.add('hidden');
    renderCatalogFromMoviesList(allDriveMovies, currentCategory, '');
  });

  backToHomeRowsBtn.addEventListener('click', () => {
    globalSearchInput.value = '';
    globalSearchClearBtn.classList.add('hidden');
    renderCatalogFromMoviesList(allDriveMovies, 'all', '');
  });

  // ==========================================
  // CENTRAL DE GERENCIAMENTO DO GOOGLE DRIVE
  // ==========================================
  function openDriveManager() {
    syncFolderStatus.classList.add('hidden');
    renderManagerMoviesList(allDriveMovies);
    driveManagerModal.classList.remove('hidden');
  }

  openDriveManagerBtn.addEventListener('click', openDriveManager);
  openDriveFromRoomBtn.addEventListener('click', openDriveManager);
  closeDriveManagerBtn.addEventListener('click', () => driveManagerModal.classList.add('hidden'));

  function renderManagerMoviesList(movies) {
    managerMoviesCount.textContent = String(movies.length);
    if (movies.length === 0) {
      managerMoviesList.innerHTML =
        '<p style="font-size:0.8rem; color:var(--text-muted);">Nenhum filme cadastrado ainda.</p>';
      return;
    }

    managerMoviesList.innerHTML = movies
      .map(
        (m) => `
        <div class="addon-row-item">
          <div style="display:flex; align-items:center; gap:0.65rem;">
            <img src="${escapeHtml(m.poster)}" alt="" style="width:32px; height:46px; object-fit:cover; border-radius:4px;" />
            <div>
              <strong>${escapeHtml(m.title)} (${escapeHtml(m.year || 'HD')})</strong>
              <div style="font-size:0.72rem; color:var(--text-muted);">${escapeHtml(m.category)}</div>
            </div>
          </div>
          <div style="display:flex; gap:0.4rem;">
            <button type="button" class="btn-blue-pill btn-xs play-mgr-btn" data-id="${escapeHtml(m.id)}">▶ Projetar</button>
            <button type="button" class="btn-secondary btn-xs del-mgr-btn" data-id="${escapeHtml(m.id)}" style="color:#fca5a5;">🗑️</button>
          </div>
        </div>
      `
      )
      .join('');

    managerMoviesList.querySelectorAll('.play-mgr-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const movie = allDriveMovies.find((x) => x.id === btn.dataset.id);
        if (movie) {
          driveManagerModal.classList.add('hidden');
          projectDriveMovieToRoom(movie);
        }
      });
    });

    managerMoviesList.querySelectorAll('.del-mgr-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idToRemove = btn.dataset.id;
        allDriveMovies = allDriveMovies.filter((m) => m.id !== idToRemove);
        saveLocalMoviesBackup(allDriveMovies);
        renderCatalogFromMoviesList(allDriveMovies, currentCategory, '');
        try {
          await fetch(`/api/drive/movies/${encodeURIComponent(idToRemove)}`, { method: 'DELETE' });
        } catch (_) {}
      });
    });
  }

  async function scanDriveFolderClientSide(folderUrl, defaultCategory) {
    const folderId = extractDriveFolderId(folderUrl);
    if (!folderId) {
      throw new Error('Link de pasta inválido. Use um link de pasta compartilhada do Google Drive.');
    }

    const targetUrl = `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}#list`;
    const proxyUrls = [
      `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`,
      `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`
    ];

    let html = '';
    for (const pUrl of proxyUrls) {
      try {
        const r = await fetch(pUrl);
        if (r.ok) {
          const text = await r.text();
          if (text && text.includes('flip-entry')) {
            html = text;
            break;
          }
        }
      } catch (_) {}
    }

    if (!html) {
      throw new Error(
        'Não foi possível ler a pasta pública. Verifique se ela está compartilhada como "Qualquer pessoa com o link".'
      );
    }

    const entryRegex = /id="entry-([a-zA-Z0-9_-]+)"[\s\S]*?<div class="flip-entry-title">([^<]+)<\/div>/g;
    const discoveredFiles = [];
    let match;
    while ((match = entryRegex.exec(html)) !== null) {
      const fileId = match[1];
      const fileName = match[2].trim();
      if (!/\.(jpg|jpeg|png|gif|srt|vtt|txt|nfo|pdf|zip|rar)$/i.test(fileName)) {
        discoveredFiles.push({ fileId, fileName });
      }
    }

    let addedCount = 0;
    for (const file of discoveredFiles) {
      if (allDriveMovies.some((m) => m.driveFileId === file.fileId)) continue;
      const parsed = parseMovieFilenameClient(file.fileName);
      const newMovie = {
        id: `drive_${file.fileId}`,
        title: parsed.title,
        year: parsed.year,
        rating: '8.5',
        category: defaultCategory !== 'Auto' ? defaultCategory : 'Filmes do Google Drive',
        featured: addedCount === 0,
        driveFileId: file.fileId,
        rawUrl: `https://drive.google.com/file/d/${file.fileId}/view`,
        streamUrl: `/api/gdrive/stream/${file.fileId}`,
        poster: `https://placehold.co/500x750/151828/f5c518?text=${encodeURIComponent(parsed.title)}`,
        backdrop: '',
        overview: `Arquivo sincronizado da sua pasta do Google Drive (${file.fileName}).`,
        addedAt: Date.now()
      };
      allDriveMovies.unshift(newMovie);
      addedCount += 1;
    }

    saveLocalMoviesBackup(allDriveMovies);
    return {
      success: true,
      discoveredCount: discoveredFiles.length,
      addedCount,
      movies: allDriveMovies
    };
  }

  syncFolderForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const folderUrl = driveFolderUrlInput.value.trim();
    if (!folderUrl) return;

    syncFolderStatus.classList.remove('hidden');
    syncFolderStatus.style.background = 'rgba(82, 123, 255, 0.16)';
    syncFolderStatus.style.color = '#93b4ff';
    syncFolderStatus.textContent = '⏳ Escaneando pasta do Google Drive e buscando capas...';
    syncFolderSubmitBtn.disabled = true;

    try {
      let data = null;
      try {
        const res = await fetch('/api/drive/sync-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            folderUrl,
            defaultCategory: driveFolderCategorySelect.value
          })
        });
        const rawText = await res.text();
        if (rawText && rawText.trim().startsWith('{')) {
          data = JSON.parse(rawText);
        }
      } catch (_) {}

      // Se a rota Serverless deu timeout ou retornou resposta vazia, usa o Scanner Cliente!
      if (!data || (!data.success && !data.error)) {
        data = await scanDriveFolderClientSide(folderUrl, driveFolderCategorySelect.value);
      }

      if (data.error) {
        syncFolderStatus.style.background = 'rgba(239, 68, 68, 0.2)';
        syncFolderStatus.style.color = '#fca5a5';
        syncFolderStatus.textContent = data.error;
      } else {
        if (Array.isArray(data.movies) && data.movies.length > 0) {
          const merged = new Map();
          for (const m of [...allDriveMovies, ...data.movies]) {
            if (m && m.id && m.id !== 'demo_1' && m.id !== 'demo_2') {
              merged.set(m.id, m);
            }
          }
          allDriveMovies = Array.from(merged.values());
          saveLocalMoviesBackup(allDriveMovies);
        }
        syncFolderStatus.style.background = 'rgba(16, 185, 129, 0.2)';
        syncFolderStatus.style.color = '#34d399';
        syncFolderStatus.textContent = `✅ Pasta sincronizada! ${data.discoveredCount} vídeo(s) encontrado(s) na pasta (${data.addedCount} novo(s) importado(s))!`;
        driveFolderUrlInput.value = '';
        renderCatalogFromMoviesList(allDriveMovies, 'all', '');
        if (isP2PHost) {
          broadcastFromP2PHost('catalog_synced', { movies: allDriveMovies });
        }
      }
    } catch (err) {
      syncFolderStatus.style.background = 'rgba(239, 68, 68, 0.2)';
      syncFolderStatus.style.color = '#fca5a5';
      syncFolderStatus.textContent = 'Erro ao escanear pasta: ' + err.message;
    } finally {
      syncFolderSubmitBtn.disabled = false;
    }
  });

  // Busca de capa direto no cliente ou via backend
  async function fetchClientMovieMeta(title) {
    try {
      const res = await fetch(`/api/drive/autofill?title=${encodeURIComponent(title)}`);
      if (res.ok) return await res.json();
    } catch (_) {}
    return null;
  }

  autoFillMetaBtn.addEventListener('click', async () => {
    const title = singleMovieTitle.value.trim();
    if (!title) {
      alert('Digite primeiro o nome do filme para puxar a capa e a sinopse!');
      singleMovieTitle.focus();
      return;
    }

    const prevText = autoFillMetaBtn.textContent;
    autoFillMetaBtn.textContent = '⏳ Buscando...';
    const data = await fetchClientMovieMeta(title);
    if (data) {
      if (data.title) singleMovieTitle.value = data.title;
      if (data.year) singleMovieYear.value = data.year;
      if (data.poster) singleMoviePoster.value = data.poster;
      if (data.backdrop) singleMovieBackdrop.value = data.backdrop;
      if (data.overview) singleMovieOverview.value = data.overview;
      if (data.category) singleMovieCategory.value = data.category;
      autoFillMetaBtn.textContent = '✅ Capa Preenchida!';
    } else {
      autoFillMetaBtn.textContent = '⚠️ Preencha manual';
    }
    setTimeout(() => {
      autoFillMetaBtn.textContent = prevText;
    }, 2000);
  });

  addSingleMovieForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = singleMovieTitle.value.trim();
    const rawUrl = singleMovieUrl.value.trim();
    if (!title || !rawUrl) return;

    let savedMovie = null;
    try {
      const res = await fetch('/api/drive/movies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          rawUrl,
          category: singleMovieCategory.value,
          year: singleMovieYear.value.trim(),
          poster: singleMoviePoster.value.trim(),
          backdrop: singleMovieBackdrop.value.trim(),
          overview: singleMovieOverview.value.trim(),
          autoFetchCover: true
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.movie) savedMovie = data.movie;
      }
    } catch (_) {}

    if (!savedMovie) {
      const fileId = extractDriveFileId(rawUrl);
      const posterUrl =
        singleMoviePoster.value.trim() ||
        `https://placehold.co/500x750/151828/f5c518?text=${encodeURIComponent(title)}`;
      savedMovie = {
        id: `drive_${Date.now()}`,
        title,
        year: singleMovieYear.value.trim() || '2026',
        rating: '8.5',
        category:
          singleMovieCategory.value === 'Auto' ? 'Lançamentos & Destaques' : singleMovieCategory.value,
        featured: true,
        driveFileId: fileId,
        rawUrl,
        streamUrl: fileId ? `/api/gdrive/stream/${fileId}` : rawUrl,
        poster: posterUrl,
        backdrop: singleMovieBackdrop.value.trim() || posterUrl,
        overview:
          singleMovieOverview.value.trim() ||
          'Filme armazenado no seu Google Drive pronto para assistir com amigos.',
        addedAt: Date.now()
      };
    }

    allDriveMovies.unshift(savedMovie);
    saveLocalMoviesBackup(allDriveMovies);
    renderCatalogFromMoviesList(allDriveMovies, 'all', '');

    if (isP2PHost) {
      broadcastFromP2PHost('catalog_synced', { movies: allDriveMovies });
    }

    singleMovieTitle.value = '';
    singleMovieUrl.value = '';
    singleMovieYear.value = '';
    singleMoviePoster.value = '';
    singleMovieBackdrop.value = '';
    singleMovieOverview.value = '';

    driveManagerModal.classList.add('hidden');
    projectDriveMovieToRoom(savedMovie);
  });

  // ==========================================
  // MODAL DE DETALHES E PROJEÇÃO NA SALA
  // ==========================================
  function openMovieDetailModal(movie) {
    selectedDetailMovie = movie;
    const bg = movie.backdrop || movie.poster;
    detailBackdrop.style.backgroundImage = `url('${bg}')`;
    detailCategoryBadge.textContent = movie.category || 'GOOGLE DRIVE HD';
    detailRatingBadge.textContent = `⭐ ${movie.rating || '8.5'}`;
    detailYearBadge.textContent = movie.year || 'HD';
    detailTitle.textContent = movie.title;
    detailOverview.textContent = movie.overview || '';
    movieDetailModal.classList.remove('hidden');
  }

  closeDetailModal.addEventListener('click', () => movieDetailModal.classList.add('hidden'));

  function projectDriveMovieToRoom(movie) {
    if (roomState && !iCanControl()) {
      alert('Apenas o Anfitrião (👑) pode trocar o filme em cartaz na sala.');
      return;
    }

    const driveFileId = movie.driveFileId || extractDriveFileId(movie.rawUrl || movie.streamUrl);

    sendRoomAction('change_media', {
      id: movie.id,
      title: movie.title,
      year: movie.year || 'HD',
      category: movie.category || 'Google Drive',
      poster: movie.poster,
      backdrop: movie.backdrop || movie.poster,
      overview: movie.overview,
      streamUrl: movie.streamUrl,
      rawUrl: movie.rawUrl,
      driveFileId,
      playerType: getOptimalPlayerType(driveFileId)
    });

    movieDetailModal.classList.add('hidden');
    switchMainView('cinema');
  }

  playDriveMovieNowBtn.addEventListener('click', () => {
    if (!selectedDetailMovie) return;
    projectDriveMovieToRoom(selectedDetailMovie);
  });

  deleteDriveMovieBtn.addEventListener('click', async () => {
    if (!selectedDetailMovie) return;
    if (!confirm(`Remover "${selectedDetailMovie.title}" do catálogo?`)) return;
    const idToRemove = selectedDetailMovie.id;
    allDriveMovies = allDriveMovies.filter((m) => m.id !== idToRemove);
    saveLocalMoviesBackup(allDriveMovies);
    renderCatalogFromMoviesList(allDriveMovies, currentCategory, '');
    movieDetailModal.classList.add('hidden');
    try {
      await fetch(`/api/drive/movies/${encodeURIComponent(idToRemove)}`, { method: 'DELETE' });
    } catch (_) {}
  });

  // ==========================================
  // PLAYER NATIVO CINE POMPEIA + FALLBACK PLAYER INTERNO DO DRIVE (.MKV / 4K)
  // ==========================================
  function switchPlayerRenderer(type) {
    if (!roomState) return;
    const fileId =
      roomState.media.driveFileId ||
      extractDriveFileId(roomState.media.rawUrl || roomState.media.streamUrl);

    if (type === 'drive_preview' && fileId) {
      try {
        nativeVideo.pause();
      } catch (_) {}
      cineNativePlayerContainer.classList.add('hidden');
      drivePreviewIframe.classList.remove('hidden');
      drivePreviewIframe.src = `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/preview`;
      syncModeIndicator.textContent = '☁️ Player Oficial do Drive Ativo (Use a Claquete 3-2-1 para sincronizar)';
    } else {
      drivePreviewIframe.src = 'about:blank';
      drivePreviewIframe.classList.add('hidden');
      cineNativePlayerContainer.classList.remove('hidden');
      syncModeIndicator.textContent = '⚡ Sincronia Automática WebSocket/P2P Ativa';
    }
  }

  useNativeStreamBtn.addEventListener('click', () => {
    if (!iCanControl()) return;
    sendRoomAction('change_media', { playerType: 'native' });
  });

  useDrivePreviewBtn.addEventListener('click', () => {
    if (!roomState) return;
    const fileId =
      roomState.media.driveFileId ||
      extractDriveFileId(roomState.media.rawUrl || roomState.media.streamUrl);
    if (!fileId) {
      alert('Este vídeo é um link direto (.mp4) e já está rodando no Player Nativo.');
      return;
    }
    if (iCanControl()) {
      sendRoomAction('change_media', { playerType: 'drive_preview' });
    } else {
      switchPlayerRenderer('drive_preview');
    }
  });

  function updatePlayerMedia(media, playback) {
    const signature = JSON.stringify({
      streamUrl: media.streamUrl,
      driveFileId: media.driveFileId,
      playerType: media.playerType || 'native'
    });

    if (signature === lastLoadedMediaSignature) return;
    lastLoadedMediaSignature = signature;

    if (media.playerType === 'drive_preview') {
      switchPlayerRenderer('drive_preview');
      return;
    }

    switchPlayerRenderer('native');
    const url = media.streamUrl;
    if (!url) return;
    nativeDownloadBtn.href = url;

    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }

    const isHls = url.includes('.m3u8');
    if (isHls && window.Hls && window.Hls.isSupported()) {
      hlsInstance = new window.Hls();
      hlsInstance.loadSource(url);
      hlsInstance.attachMedia(nativeVideo);
      hlsInstance.on(window.Hls.Events.MANIFEST_PARSED, () => {
        applyPlaybackToNativeVideo(playback);
      });
    } else {
      nativeVideo.src = url;
      nativeVideo.addEventListener(
        'loadedmetadata',
        () => {
          applyPlaybackToNativeVideo(playback);
        },
        { once: true }
      );
      nativeVideo.onerror = null;
    }
  }

  function updateCustomPlayerUi() {
    const isPaused = nativeVideo.paused;
    nativePlayPauseBtn.textContent = isPaused ? '▶' : '⏸';
    nativeCenterPlayBtn.classList.toggle('playing', !isPaused);

    const cur = nativeVideo.currentTime || 0;
    const dur = nativeVideo.duration && Number.isFinite(nativeVideo.duration) ? nativeVideo.duration : 0;
    if (dur > 0) {
      nativeSeekBar.value = String((cur / dur) * 100);
    }
    nativeTimeLabel.textContent = `${formatSeconds(cur)} / ${formatSeconds(dur)}`;
  }

  function applyPlaybackToNativeVideo(playback) {
    if (!playback) return;
    isApplyingRemoteSync = true;

    const targetTime = Number(playback.currentTime) || 0;
    if (Math.abs(nativeVideo.currentTime - targetTime) > 1.2) {
      nativeVideo.currentTime = targetTime;
    }

    if (playback.playbackRate && nativeVideo.playbackRate !== playback.playbackRate) {
      nativeVideo.playbackRate = playback.playbackRate;
    }

    if (playback.status === 'playing') {
      nativeVideo.play().catch(() => {});
    } else {
      nativeVideo.pause();
    }

    updateCustomPlayerUi();
    setTimeout(() => {
      isApplyingRemoteSync = false;
    }, 250);
  }

  function toggleNativePlayPause() {
    if (!iCanControl()) {
      alert('Apenas o Anfitrião (👑) pode pausar ou iniciar o filme.');
      return;
    }
    if (nativeVideo.paused) {
      nativeVideo.play().catch(() => {});
    } else {
      nativeVideo.pause();
    }
  }

  nativeCenterPlayBtn.addEventListener('click', toggleNativePlayPause);
  nativePlayPauseBtn.addEventListener('click', toggleNativePlayPause);
  nativeVideo.addEventListener('click', toggleNativePlayPause);

  nativeRewindBtn.addEventListener('click', () => {
    if (!iCanControl()) return;
    nativeVideo.currentTime = Math.max(0, nativeVideo.currentTime - 10);
  });

  nativeForwardBtn.addEventListener('click', () => {
    if (!iCanControl()) return;
    nativeVideo.currentTime = Math.min(nativeVideo.duration || 99999, nativeVideo.currentTime + 10);
  });

  nativeSeekBar.addEventListener('input', () => {
    if (!iCanControl()) return;
    const dur = nativeVideo.duration;
    if (dur && Number.isFinite(dur)) {
      nativeVideo.currentTime = (Number(nativeSeekBar.value) / 100) * dur;
    }
  });

  nativeMuteBtn.addEventListener('click', () => {
    nativeVideo.muted = !nativeVideo.muted;
    nativeMuteBtn.textContent = nativeVideo.muted ? '🔇' : '🔊';
  });

  nativeVolumeBar.addEventListener('input', () => {
    nativeVideo.volume = Number(nativeVolumeBar.value);
    nativeVideo.muted = nativeVideo.volume === 0;
    nativeMuteBtn.textContent = nativeVideo.muted ? '🔇' : '🔊';
  });

  nativeSettingsGearBtn.addEventListener('click', () => {
    nativeSourcesDrawer.classList.toggle('hidden');
  });

  closeSourcesDrawerBtn.addEventListener('click', () => {
    nativeSourcesDrawer.classList.add('hidden');
  });

  document.querySelectorAll('.speed-option').forEach((opt) => {
    opt.addEventListener('click', () => {
      if (!iCanControl()) return;
      const rate = Number(opt.dataset.speed) || 1;
      nativeVideo.playbackRate = rate;
      nativeSourcesDrawer.classList.add('hidden');
      sendRoomAction('playback_command', {
        action: 'seek',
        currentTime: nativeVideo.currentTime,
        playbackRate: rate
      });
    });
  });

  nativeCastSyncBtn.addEventListener('click', () => {
    if (!iCanControl()) return;
    sendRoomAction('trigger_clapperboard', { targetTime: nativeVideo.currentTime || 0 });
  });

  nativeFullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      screenWrapper.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });

  nativeVideo.addEventListener('timeupdate', updateCustomPlayerUi);
  nativeVideo.addEventListener('play', () => {
    updateCustomPlayerUi();
    if (isApplyingRemoteSync || !iCanControl()) return;
    sendRoomAction('playback_command', {
      action: 'play',
      currentTime: nativeVideo.currentTime,
      playbackRate: nativeVideo.playbackRate
    });
  });

  nativeVideo.addEventListener('pause', () => {
    updateCustomPlayerUi();
    if (isApplyingRemoteSync || !iCanControl()) return;
    sendRoomAction('playback_command', {
      action: 'pause',
      currentTime: nativeVideo.currentTime,
      playbackRate: nativeVideo.playbackRate
    });
  });

  nativeVideo.addEventListener('seeked', () => {
    updateCustomPlayerUi();
    if (isApplyingRemoteSync || !iCanControl()) return;
    sendRoomAction('playback_command', {
      action: 'seek',
      currentTime: nativeVideo.currentTime,
      playbackRate: nativeVideo.playbackRate
    });
  });

  // ==========================================
  // BILHETERIA (NUNCA TRAVA MESMO EM AMBIENTES SERVERLESS/VERCEL)
  // ==========================================
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('room')) {
    roomIdInput.value = urlParams.get('room').toUpperCase();
  }

  const savedName = localStorage.getItem('cine_pompeia_name');
  if (savedName) userNameInput.value = savedName;

  async function loadActiveRooms() {
    try {
      const res = await fetch('/api/rooms');
      if (!res.ok) return;
      const rooms = await res.json();
      if (Array.isArray(rooms) && rooms.length > 0) {
        activeRoomsSection.classList.remove('hidden');
        activeRoomsList.innerHTML = rooms
          .map(
            (r) => `
          <div class="active-room-item" data-room="${r.id}">
            <div>
              <strong>${r.hasPassword ? '🔒 ' : '🎟️ '}${r.id}</strong>
              <span style="color: var(--text-muted); margin-left: 6px;">• ${escapeHtml(r.currentMovie)}</span>
            </div>
            <span class="seat-count-badge">${r.participantCount}/${r.maxSeats} poltronas</span>
          </div>
        `
          )
          .join('');

        activeRoomsList.querySelectorAll('.active-room-item').forEach((el) => {
          el.addEventListener('click', () => {
            roomIdInput.value = el.dataset.room;
            userNameInput.focus();
          });
        });
      }
    } catch (_) {}
  }

  loadDriveStreamingCatalog('all', '');
  loadActiveRooms();

  avatarPicker.querySelectorAll('.avatar-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      avatarPicker.querySelectorAll('.avatar-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      selectedAvatar = btn.dataset.avatar;
    });
  });

  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    lobbyError.classList.add('hidden');

    const userName = userNameInput.value.trim();
    const roomId = (roomIdInput.value.trim() || 'SALA-POMPEIA').toUpperCase();
    const password = roomPasswordInput.value;

    if (!userName) return;
    localStorage.setItem('cine_pompeia_name', userName);

    // Se Socket.io estiver conectado (Node.js local/VPS), tenta via Socket.io com fallback automático de 1s
    if (socket && socket.connected && !useServerlessP2P) {
      let handled = false;
      const fallbackTimer = setTimeout(() => {
        if (!handled) {
          handled = true;
          startServerlessP2PRoom(roomId, userName, selectedAvatar);
        }
      }, 1000);

      socket.emit(
        'join_room',
        { roomId, roomName: roomId, password, userName, avatar: selectedAvatar },
        (response) => {
          if (handled) return;
          handled = true;
          clearTimeout(fallbackTimer);

          if (response && response.error) {
            lobbyError.textContent = response.error;
            lobbyError.classList.remove('hidden');
            return;
          }
          if (response && response.success) {
            mySocketId = response.mySocketId;
            lobbyModal.classList.add('hidden');
            const newUrl = `${window.location.pathname}?room=${encodeURIComponent(response.room.id)}`;
            window.history.replaceState({}, '', newUrl);
            applyRoomState(response.room);
          } else {
            startServerlessP2PRoom(roomId, userName, selectedAvatar);
          }
        }
      );
    } else {
      // Na Vercel / GitHub Pages / Netlify, entra instantaneamente usando o motor WebRTC P2P!
      startServerlessP2PRoom(roomId, userName, selectedAvatar);
    }
  });

  function renderAuditoriumSeats(seats, hostSocketId) {
    const createSeatHtml = (seatData, index) => {
      const label = index < 6 ? `A${index + 1}` : `B${index - 5}`;
      const isOccupied = Boolean(seatData);
      const isMine = isOccupied && seatData.socketId === mySocketId;
      const isHost = isOccupied && seatData.socketId === hostSocketId;

      let stateClass = '';
      if (isMine) stateClass = 'mine';
      else if (isOccupied) stateClass = 'occupied';

      return `
        <div class="cinema-seat ${stateClass}" data-seat-index="${index}" title="${
        isOccupied
          ? `Poltrona ${label}: ${seatData.name}${isHost ? ' (Anfitrião)' : ''}`
          : `Sentar na Poltrona ${label}`
      }">
          <span class="seat-number-tag">${label}</span>
          ${isHost ? '<span class="seat-crown-tag" title="Anfitrião da Sala">👑</span>' : ''}
          ${
            isOccupied
              ? `
                <div class="seat-avatar">${seatData.avatar || '🍿'}</div>
                <div class="seat-user-name">${escapeHtml(seatData.name)}</div>
              `
              : `
                <div class="seat-avatar" style="opacity:0.25;">💺</div>
                <div class="seat-empty-label">Livre</div>
              `
          }
        </div>
      `;
    };

    seatRowA.innerHTML = seats.slice(0, 6).map((s, idx) => createSeatHtml(s, idx)).join('');
    seatRowB.innerHTML = seats.slice(6, 12).map((s, idx) => createSeatHtml(s, idx + 6)).join('');

    document.querySelectorAll('.cinema-seat').forEach((seatEl) => {
      seatEl.addEventListener('click', () => {
        const idx = Number(seatEl.dataset.seatIndex);
        const occupant = roomState && roomState.seats[idx];

        if (!occupant) {
          sendRoomAction('select_seat', { seatIndex: idx });
        } else if (
          occupant.socketId !== mySocketId &&
          roomState &&
          roomState.hostSocketId === mySocketId
        ) {
          if (confirm(`Deseja passar a coroa de Anfitrião (👑) para ${occupant.name}?`)) {
            sendRoomAction('transfer_host', { targetSocketId: occupant.socketId });
          }
        }
      });
    });
  }

  function iCanControl() {
    if (!roomState) return true;
    return roomState.hostSocketId === mySocketId || roomState.freeControl;
  }

  function applyRoomState(state) {
    roomState = state;

    roomNameDisplay.textContent = state.id;
    seatCountBadge.textContent = `${state.participantCount}/${state.maxSeats} poltronas`;
    onlineFriendsCount.textContent = `${state.participantCount} na sala`;

    navMovieShort.textContent = state.media.title;
    currentMoviePoster.src =
      state.media.poster || 'https://placehold.co/500x750/14141f/e50914?text=Cine+Pompeia';
    currentMovieIds.textContent = `☁️ ${state.media.category || 'GOOGLE DRIVE HD'}`;
    currentMovieHeading.textContent = state.media.title;
    currentMovieOverview.textContent = state.media.overview || '';

    if (state.lightsOff) {
      lightsOverlay.classList.remove('hidden');
      toggleLightsBtn.textContent = '💡 Acender Luzes';
    } else {
      lightsOverlay.classList.add('hidden');
      toggleLightsBtn.textContent = '💡 Luzes';
    }

    toggleControlModeBtn.textContent = state.freeControl ? '🎮 Controle Livre' : '👑 Só Anfitrião';

    renderAuditoriumSeats(state.seats, state.hostSocketId);
    updatePlayerMedia(state.media, state.playback);

    if (chatMessages.children.length === 0 && Array.isArray(state.chatHistory)) {
      state.chatHistory.forEach((msg) => appendChatMessage(msg));
    }
  }

  function formatSeconds(sec) {
    const total = Math.max(0, Math.floor(sec || 0));
    const hrs = Math.floor(total / 3600);
    const mins = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const secs = String(total % 60).padStart(2, '0');
    return hrs > 0 ? `${hrs}:${mins}:${secs}` : `${mins}:${secs}`;
  }

  if (sessionClockInterval) clearInterval(sessionClockInterval);
  sessionClockInterval = setInterval(() => {
    const current = nativeVideo.currentTime || 0;
    syncTimerDisplay.textContent = `⏱️ Tempo do Filme: ${formatSeconds(current)}`;
  }, 500);

  setInterval(() => {
    if (roomState && roomState.hostSocketId === mySocketId && !nativeVideo.paused) {
      if (!useServerlessP2P && socket && socket.connected) {
        socket.emit('host_time_heartbeat', {
          currentTime: nativeVideo.currentTime,
          status: nativeVideo.paused ? 'paused' : 'playing'
        });
      } else if (isP2PHost) {
        broadcastFromP2PHost('playback_heartbeat', {
          currentTime: nativeVideo.currentTime,
          status: nativeVideo.paused ? 'paused' : 'playing',
          playbackRate: nativeVideo.playbackRate
        });
      }
    }
  }, 3000);

  if (socket) {
    socket.on('room_state', (state) => handleIncomingRoomEvent('room_state', state));
    socket.on('media_changed', (data) => handleIncomingRoomEvent('media_changed', data));
    socket.on('playback_sync', (data) => handleIncomingRoomEvent('playback_sync', data));
    socket.on('playback_heartbeat', (data) => handleIncomingRoomEvent('playback_heartbeat', data));
    socket.on('clapperboard_countdown', (data) => handleIncomingRoomEvent('clapperboard_countdown', data));
    socket.on('chat_message', (msg) => handleIncomingRoomEvent('chat_message', msg));
    socket.on('seat_reaction', (data) => handleIncomingRoomEvent('seat_reaction', data));
  }

  function playBeep(freq = 660, duration = 0.14) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.value = 0.12;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration);
    } catch (_) {}
  }

  function runClapperboardVisual({ targetTime, actorName }) {
    switchMainView('cinema');
    clapperOverlay.classList.remove('hidden');
    clapperSub.textContent = `${actorName} acionou a Claquete! Iniciando juntos em...`;
    let count = 3;
    clapperCount.textContent = '3';
    playBeep(520, 0.15);

    const timer = setInterval(() => {
      count -= 1;
      if (count > 0) {
        clapperCount.textContent = String(count);
        playBeep(520, 0.15);
      } else if (count === 0) {
        clapperCount.textContent = '🎬 PLAY!';
        playBeep(880, 0.35);
        if (roomState) {
          roomState.playback = {
            status: 'playing',
            currentTime: targetTime || 0,
            playbackRate: 1,
            serverTimestamp: Date.now()
          };
          applyPlaybackToNativeVideo(roomState.playback);
        }
      } else {
        clearInterval(timer);
        clapperOverlay.classList.add('hidden');
      }
    }, 1000);
  }

  copyInviteBtn.addEventListener('click', () => {
    const inviteUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(
      roomState ? roomState.id : roomIdInput.value
    )}`;
    navigator.clipboard.writeText(inviteUrl).then(() => {
      const prev = copyInviteBtn.textContent;
      copyInviteBtn.textContent = '✅ Link Copiado!';
      setTimeout(() => {
        copyInviteBtn.textContent = prev;
      }, 2000);
    });
  });

  toggleLightsBtn.addEventListener('click', () => {
    if (roomState && roomState.hostSocketId === mySocketId) {
      sendRoomAction('toggle_room_setting', { setting: 'lights' });
    } else {
      lightsOverlay.classList.toggle('hidden');
    }
  });

  toggleControlModeBtn.addEventListener('click', () => {
    if (!roomState || roomState.hostSocketId !== mySocketId) {
      alert('Apenas o Anfitrião (👑) pode alterar o modo de controle da sala.');
      return;
    }
    sendRoomAction('toggle_room_setting', { setting: 'freeControl' });
  });

  clapperSyncBtn.addEventListener('click', () => {
    if (!iCanControl()) {
      alert('Peça ao Anfitrião (👑) para disparar a Claquete de Sincronia.');
      return;
    }
    sendRoomAction('trigger_clapperboard', { targetTime: nativeVideo.currentTime || 0 });
  });

  resyncMeBtn.addEventListener('click', () => {
    if (!roomState) return;
    applyPlaybackToNativeVideo(roomState.playback);
  });

  function appendChatMessage(msg) {
    const div = document.createElement('div');
    if (msg.type === 'system') {
      div.className = 'chat-msg system';
      div.textContent = msg.text;
    } else {
      div.className = 'chat-msg';
      div.innerHTML = `
        <div class="chat-msg-header">
          <div>
            <span class="chat-author">${escapeHtml(msg.avatar)} ${escapeHtml(msg.userName)}</span>
            <span class="chat-seat-pill">Poltrona ${escapeHtml(msg.seatLabel)}</span>
          </div>
          <span class="chat-time">${escapeHtml(msg.timestamp)}</span>
        </div>
        <div>${escapeHtml(msg.text)}</div>
      `;
    }
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    sendRoomAction('send_chat', { text });
    chatInput.value = '';
  });

  document.querySelectorAll('.reaction-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      sendRoomAction('send_reaction', { emoji: btn.dataset.emoji });
    });
  });

  function spawnFloatingReaction({ userName, seatIndex, emoji }) {
    const el = document.createElement('div');
    el.className = 'floating-reaction';
    const col = typeof seatIndex === 'number' ? seatIndex % 6 : Math.floor(Math.random() * 6);
    const leftPercent = 10 + col * 15 + (Math.random() * 6 - 3);
    el.style.left = `${leftPercent}%`;
    el.innerHTML = `${escapeHtml(emoji)}<span>${escapeHtml(userName)}</span>`;
    screenReactionsLayer.appendChild(el);
    setTimeout(() => el.remove(), 2700);
  }
})();
