(() => {
  const socket = io();

  // Estado local
  let mySocketId = null;
  let roomState = null;
  let selectedAvatar = '🍿';
  let currentCategory = 'all';
  let currentHeroMovie = null;
  let selectedDetailMovie = null;
  let allDriveMovies = [];
  let hlsInstance = null;
  let isApplyingRemoteSync = false;
  let lastLoadedStreamUrl = '';
  let sessionClockInterval = null;
  let searchDebounceTimer = null;

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

  const screenWrapper = document.getElementById('screenWrapper');
  const playerBackToCatalogBtn = document.getElementById('playerBackToCatalogBtn');
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
  // VITRINE STREAMING DO GOOGLE DRIVE
  // ==========================================
  async function loadDriveStreamingCatalog(category = 'all', query = '') {
    currentCategory = category;
    try {
      const params = new URLSearchParams({ category, query });
      const res = await fetch(`/api/drive/catalog?${params.toString()}`);
      const data = await res.json();

      allDriveMovies = data.movies || [];
      renderManagerMoviesList(allDriveMovies);

      if (query) {
        heroBanner.classList.add('hidden');
        streamingRowsContainer.classList.add('hidden');
        searchResultsSection.classList.remove('hidden');
        searchResultsTitle.textContent = `🔍 Resultados no seu Drive para "${query}"`;
        searchResultsGrid.innerHTML =
          allDriveMovies.length > 0
            ? allDriveMovies.map((m) => createPosterCardHtml(m)).join('')
            : '<p style="color:var(--text-muted);">Nenhum filme encontrado com esse nome no seu catálogo do Drive.</p>';
        bindPosterCardClicks(searchResultsGrid);
        return;
      }

      searchResultsSection.classList.add('hidden');
      heroBanner.classList.remove('hidden');
      streamingRowsContainer.classList.remove('hidden');

      if (data.hero) {
        currentHeroMovie = data.hero;
        const bgUrl = data.hero.backdrop || data.hero.poster;
        heroBanner.style.backgroundImage = `url('${bgUrl}')`;
        heroRating.textContent = `⭐ ${data.hero.rating || '8.5'}`;
        heroYear.textContent = data.hero.year || 'HD';
        heroTitle.textContent = data.hero.title;
        heroOverview.textContent = data.hero.overview;
      }

      renderStreamingRows(data.rows || []);
    } catch (err) {
      streamingRowsContainer.innerHTML = `<p style="color:#fca5a5;">Erro ao carregar seu catálogo do Google Drive: ${escapeHtml(
        err.message
      )}</p>`;
    }
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

  // Botões do Hero Banner
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

  // Busca no Catálogo do Drive
  globalSearchInput.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    const q = globalSearchInput.value.trim();
    globalSearchClearBtn.classList.toggle('hidden', !q);
    searchDebounceTimer = setTimeout(() => {
      switchMainView('catalog');
      loadDriveStreamingCatalog(currentCategory, q);
    }, 250);
  });

  globalSearchClearBtn.addEventListener('click', () => {
    globalSearchInput.value = '';
    globalSearchClearBtn.classList.add('hidden');
    loadDriveStreamingCatalog(currentCategory, '');
  });

  backToHomeRowsBtn.addEventListener('click', () => {
    globalSearchInput.value = '';
    globalSearchClearBtn.classList.add('hidden');
    loadDriveStreamingCatalog('all', '');
  });

  // ==========================================
  // CENTRAL DE GERENCIAMENTO DO GOOGLE DRIVE (PASTA & ARQUIVOS)
  // ==========================================
  function openDriveManager() {
    syncFolderStatus.classList.add('hidden');
    loadDriveStreamingCatalog(currentCategory, '');
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
        await fetch(`/api/drive/movies/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
        loadDriveStreamingCatalog(currentCategory, '');
      });
    });
  }

  // Sincronizar Pasta Inteira do Google Drive
  syncFolderForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const folderUrl = driveFolderUrlInput.value.trim();
    if (!folderUrl) return;

    syncFolderStatus.classList.remove('hidden');
    syncFolderStatus.style.background = 'rgba(82, 123, 255, 0.16)';
    syncFolderStatus.style.color = '#93b4ff';
    syncFolderStatus.textContent =
      '⏳ Escaneando pasta do Google Drive e buscando capas para cada vídeo...';
    syncFolderSubmitBtn.disabled = true;

    try {
      const res = await fetch('/api/drive/sync-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folderUrl,
          defaultCategory: driveFolderCategorySelect.value
        })
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        syncFolderStatus.style.background = 'rgba(239, 68, 68, 0.2)';
        syncFolderStatus.style.color = '#fca5a5';
        syncFolderStatus.textContent = data.error || 'Erro ao sincronizar pasta.';
      } else {
        syncFolderStatus.style.background = 'rgba(16, 185, 129, 0.2)';
        syncFolderStatus.style.color = '#34d399';
        syncFolderStatus.textContent = `✅ Pasta sincronizada! ${data.discoveredCount} vídeo(s) encontrado(s) e ${data.addedCount} novo(s) adicionado(s) ao catálogo!`;
        driveFolderUrlInput.value = '';
        await loadDriveStreamingCatalog('all', '');
      }
    } catch (err) {
      syncFolderStatus.style.background = 'rgba(239, 68, 68, 0.2)';
      syncFolderStatus.style.color = '#fca5a5';
      syncFolderStatus.textContent = err.message;
    } finally {
      syncFolderSubmitBtn.disabled = false;
    }
  });

  // Botão Auto-Preencher Capa pelo Nome
  autoFillMetaBtn.addEventListener('click', async () => {
    const title = singleMovieTitle.value.trim();
    if (!title) {
      alert('Digite primeiro o nome do filme para puxar a capa e a sinopse!');
      singleMovieTitle.focus();
      return;
    }

    const prevText = autoFillMetaBtn.textContent;
    autoFillMetaBtn.textContent = '⏳ Buscando...';
    try {
      const res = await fetch(`/api/drive/autofill?title=${encodeURIComponent(title)}`);
      const data = await res.json();
      if (res.ok && data) {
        if (data.title) singleMovieTitle.value = data.title;
        if (data.year) singleMovieYear.value = data.year;
        if (data.poster) singleMoviePoster.value = data.poster;
        if (data.backdrop) singleMovieBackdrop.value = data.backdrop;
        if (data.overview) singleMovieOverview.value = data.overview;
        if (data.category) singleMovieCategory.value = data.category;
        autoFillMetaBtn.textContent = '✅ Capa Preenchida!';
      } else {
        autoFillMetaBtn.textContent = '⚠️ Não encontrado';
      }
    } catch (_) {
      autoFillMetaBtn.textContent = '⚠️ Erro';
    }
    setTimeout(() => {
      autoFillMetaBtn.textContent = prevText;
    }, 2000);
  });

  // Salvar Filme Individual do Google Drive
  addSingleMovieForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = singleMovieTitle.value.trim();
    const rawUrl = singleMovieUrl.value.trim();
    if (!title || !rawUrl) return;

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
    const data = await res.json();
    if (data && data.success) {
      singleMovieTitle.value = '';
      singleMovieUrl.value = '';
      singleMovieYear.value = '';
      singleMoviePoster.value = '';
      singleMovieBackdrop.value = '';
      singleMovieOverview.value = '';
      await loadDriveStreamingCatalog('all', '');
      driveManagerModal.classList.add('hidden');
      projectDriveMovieToRoom(data.movie);
    }
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

    socket.emit('change_media', {
      id: movie.id,
      title: movie.title,
      year: movie.year || 'HD',
      category: movie.category || 'Google Drive',
      poster: movie.poster,
      backdrop: movie.backdrop || movie.poster,
      overview: movie.overview,
      streamUrl: movie.streamUrl
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
    await fetch(`/api/drive/movies/${encodeURIComponent(selectedDetailMovie.id)}`, {
      method: 'DELETE'
    });
    movieDetailModal.classList.add('hidden');
    loadDriveStreamingCatalog(currentCategory, '');
  });

  // ==========================================
  // PLAYER NATIVO CINE POMPEIA (CONECTADO AO GOOGLE DRIVE)
  // ==========================================
  function updatePlayerMedia(media, playback) {
    const url = media.streamUrl;
    if (!url) return;

    if (url === lastLoadedStreamUrl) {
      return;
    }
    lastLoadedStreamUrl = url;
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
      socket.emit('playback_command', {
        action: 'seek',
        currentTime: nativeVideo.currentTime,
        playbackRate: rate
      });
    });
  });

  nativeCastSyncBtn.addEventListener('click', () => {
    if (!iCanControl()) return;
    socket.emit('trigger_clapperboard', { targetTime: nativeVideo.currentTime || 0 });
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
    socket.emit('playback_command', {
      action: 'play',
      currentTime: nativeVideo.currentTime,
      playbackRate: nativeVideo.playbackRate
    });
  });

  nativeVideo.addEventListener('pause', () => {
    updateCustomPlayerUi();
    if (isApplyingRemoteSync || !iCanControl()) return;
    socket.emit('playback_command', {
      action: 'pause',
      currentTime: nativeVideo.currentTime,
      playbackRate: nativeVideo.playbackRate
    });
  });

  nativeVideo.addEventListener('seeked', () => {
    updateCustomPlayerUi();
    if (isApplyingRemoteSync || !iCanControl()) return;
    socket.emit('playback_command', {
      action: 'seek',
      currentTime: nativeVideo.currentTime,
      playbackRate: nativeVideo.playbackRate
    });
  });

  // ==========================================
  // BILHETERIA, 12 POLTRONAS E WEBSOCKETS
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
    const roomId = roomIdInput.value.trim().toUpperCase();
    const password = roomPasswordInput.value;

    if (!userName) return;
    localStorage.setItem('cine_pompeia_name', userName);

    socket.emit(
      'join_room',
      { roomId, roomName: roomId, password, userName, avatar: selectedAvatar },
      (response) => {
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
        }
      }
    );
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
          socket.emit('select_seat', { seatIndex: idx });
        } else if (
          occupant.socketId !== mySocketId &&
          roomState &&
          roomState.hostSocketId === mySocketId
        ) {
          if (confirm(`Deseja passar a coroa de Anfitrião (👑) para ${occupant.name}?`)) {
            socket.emit('transfer_host', { targetSocketId: occupant.socketId });
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
      socket.emit('host_time_heartbeat', {
        currentTime: nativeVideo.currentTime,
        status: nativeVideo.paused ? 'paused' : 'playing'
      });
    }
  }, 3000);

  socket.on('room_state', (state) => applyRoomState(state));

  socket.on('media_changed', ({ media, playback }) => {
    if (!roomState) return;
    roomState.media = media;
    roomState.playback = playback;
    updatePlayerMedia(media, playback);
    switchMainView('cinema');
  });

  socket.on('playback_sync', (payload) => {
    if (!roomState) return;
    roomState.playback = {
      status: payload.status,
      currentTime: payload.currentTime,
      playbackRate: payload.playbackRate,
      serverTimestamp: Date.now()
    };
    applyPlaybackToNativeVideo(roomState.playback);
  });

  socket.on('playback_heartbeat', (payload) => {
    if (!roomState) return;
    roomState.playback = {
      status: payload.status,
      currentTime: payload.currentTime,
      playbackRate: payload.playbackRate,
      serverTimestamp: Date.now()
    };
    const drift = Math.abs(nativeVideo.currentTime - payload.currentTime);
    if (drift > 2.2) {
      applyPlaybackToNativeVideo(roomState.playback);
    }
  });

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

  socket.on('clapperboard_countdown', ({ targetTime, actorName }) => {
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
  });

  copyInviteBtn.addEventListener('click', () => {
    const inviteUrl = `${window.location.origin}/?room=${encodeURIComponent(
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
      socket.emit('toggle_room_setting', { setting: 'lights' });
    } else {
      lightsOverlay.classList.toggle('hidden');
    }
  });

  toggleControlModeBtn.addEventListener('click', () => {
    if (!roomState || roomState.hostSocketId !== mySocketId) {
      alert('Apenas o Anfitrião (👑) pode alterar o modo de controle da sala.');
      return;
    }
    socket.emit('toggle_room_setting', { setting: 'freeControl' });
  });

  clapperSyncBtn.addEventListener('click', () => {
    if (!iCanControl()) {
      alert('Peça ao Anfitrião (👑) para disparar a Claquete de Sincronia.');
      return;
    }
    socket.emit('trigger_clapperboard', { targetTime: nativeVideo.currentTime || 0 });
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

  socket.on('chat_message', (msg) => appendChatMessage(msg));

  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    socket.emit('send_chat', { text });
    chatInput.value = '';
  });

  document.querySelectorAll('.reaction-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      socket.emit('send_reaction', { emoji: btn.dataset.emoji });
    });
  });

  socket.on('seat_reaction', ({ userName, seatIndex, emoji }) => {
    const el = document.createElement('div');
    el.className = 'floating-reaction';
    const col = typeof seatIndex === 'number' ? seatIndex % 6 : Math.floor(Math.random() * 6);
    const leftPercent = 10 + col * 15 + (Math.random() * 6 - 3);
    el.style.left = `${leftPercent}%`;
    el.innerHTML = `${escapeHtml(emoji)}<span>${escapeHtml(userName)}</span>`;
    screenReactionsLayer.appendChild(el);
    setTimeout(() => el.remove(), 2700);
  });
})();
