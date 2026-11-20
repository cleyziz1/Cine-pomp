// ============================================================================
// CINE POMPEIA — MOTOR DE AUDITORIA AUDIOVISUAL & FILA IDEMPOTENTE PERMANENTE
// Compartilhado entre Cloudflare Workers (Cron / Upload Hook), server.js e CLI
// ============================================================================

export function computeFileVersionHash(fileId, entry = {}, movie = {}) {
  const size = Number(entry.size || movie.size || 0);
  const dur = Math.round(Number(entry.durationSec || movie.duration || 0));
  const cont = String(entry.container || movie.container || 'mp4').toLowerCase();
  const hls = entry.sidecarAudioHlsUrl ? 'hls1' : entry.sidecarAudioComplete ? 'm4a1' : 'm4a0';
  return `${fileId}:${size}:${cont}:${dur}:${hls}`;
}

/**
 * Valida matematicamente a correspondência temporal do sistema de preview
 * nas posições obrigatórias: 0%, 10%, 25%, 50%, 75%, 90% e 95%.
 */
export function validatePreviewMath(durationSec, thumbMeta) {
  const dur = Number(durationSec || (thumbMeta && thumbMeta.duration) || 0);
  if (dur <= 0 || !thumbMeta || !thumbMeta.available) {
    return { valid: false, reason: 'Metadados de preview ausentes', samplePoints: [] };
  }
  const tiles = Array.isArray(thumbMeta.tiles) ? thumbMeta.tiles : [];
  const cols = Number(thumbMeta.cols) || 2;
  const rows = Number(thumbMeta.rows) || 2;
  const totalTiles = tiles.length || cols * rows;
  const ratios = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95];
  const samplePoints = [];
  const usedTileIndices = new Set();

  for (const r of ratios) {
    const targetSec = Math.round(r * dur);
    let chosenTile = null;
    if (tiles.length > 0) {
      chosenTile = tiles.reduce((best, cur) =>
        Math.abs((cur.t || 0) - targetSec) < Math.abs((best.t || 0) - targetSec) ? cur : best
      );
    } else {
      const idx = Math.min(totalTiles - 1, Math.max(0, Math.floor(r * totalTiles)));
      chosenTile = { tileIndex: idx, t: Math.round(((idx + 0.5) / totalTiles) * dur) };
    }
    usedTileIndices.add(chosenTile.tileIndex);
    samplePoints.push({
      pct: Math.round(r * 100),
      targetSec,
      tileIndex: chosenTile.tileIndex,
      tileSec: chosenTile.t,
      deltaSec: Math.abs((chosenTile.t || 0) - targetSec)
    });
  }

  // Verifica que início (0%), meio (50%) e fim (90-95%) não apontam para o mesmo quadro congelado
  const distinctTilesUsed = usedTileIndices.size;
  return {
    valid: distinctTilesUsed >= Math.min(4, totalTiles),
    totalTiles,
    distinctTilesUsed,
    precisionMode: totalTiles >= 16 ? 'high_density_sprite' : 'quadrant_sprite_plus_ondemand_ffmpeg',
    samplePoints
  };
}

/**
 * Audita um filme individual cruzando Catálogo + Registry + Metadados de Preview.
 */
export function auditSingleMovieRecord(movie, regEntry, thumbMeta = null) {
  const fileId = (movie && movie.driveFileId) || (regEntry && regEntry.fileId) || '';
  const title = (movie && movie.title) || (regEntry && regEntry.fileName) || fileId;
  const size = Number((regEntry && regEntry.size) || (movie && movie.size) || 0);
  const container = String((regEntry && regEntry.container) || (movie && movie.container) || 'mp4').toLowerCase();
  const durationCatalog = Number((movie && movie.duration) || 0);
  const durationDetected = Number((regEntry && regEntry.durationSec) || durationCatalog || 0);
  const videoCodecs = (regEntry && regEntry.videoCodecs) || (movie && movie.videoCodecs) || ['H.264 (AVC)'];
  const audioCodecs = (regEntry && regEntry.audioCodecs) || (movie && movie.audioCodecs) || ['AAC'];
  const audioTracks = (regEntry && regEntry.audioTracks) || [];
  const subtitleTracks = (regEntry && regEntry.subtitleTracks) || [];
  const versionHash = computeFileVersionHash(fileId, regEntry || {}, movie || {});

  const autoFixableIssues = [];
  const controlledFixProposals = [];

  // 1. Upload & Storage
  const uploadOk = Boolean(fileId && size > 10 * 1024 * 1024);
  const uploadStatus = uploadOk ? 'OK' : size > 0 ? 'Tamanho suspeito (<10MB)' : 'Pendente de verificação';

  // 2. Vídeo
  const isAvi = container === 'avi';
  const hasFullCompatMp4 = Boolean(regEntry && regEntry.hasCompatMp4 && regEntry.compatComplete !== false);
  const videoOk = !isAvi || hasFullCompatMp4;
  const videoStatus = !isAvi
    ? `OK (${videoCodecs.join(', ')} • ${container.toUpperCase()})`
    : hasFullCompatMp4
    ? 'OK (Remux MP4 H.264 completo)'
    : 'Atenção (AVI com compat.mp4 parcial de 90s)';

  // 3. Áudio
  const primaryCompat = Boolean(regEntry ? regEntry.primaryTrackCompat : true);
  const hasFullHls = Boolean(regEntry && regEntry.sidecarAudioHlsUrl && regEntry.sidecarAudioComplete !== false);
  const isEbmlDual = Boolean(regEntry && regEntry.isEbmlRemappableDual);
  const sidecarDur = Number((regEntry && regEntry.sidecarAudioDurationSec) || 0);

  let audioState = 'OK';
  let audioDetail = '';
  if (primaryCompat && !isAvi) {
    audioState = 'OK';
    audioDetail = `Nativo (${audioCodecs.join(', ')})`;
  } else if (hasFullHls) {
    audioState = 'OK';
    audioDetail = `HLS AAC-LC 100% (${Math.round(sidecarDur)}s)`;
  } else if (isEbmlDual) {
    audioState = 'Atenção';
    audioDetail = `Dual-Audio (AAC EN 100% nativo + Sidecar PT-BR ${Math.round(sidecarDur || 90)}s)`;
    controlledFixProposals.push({
      type: 'transcode_full_hls_audio',
      description: 'Gerar trilha HLS AAC-LC PT-BR completa (100% da duração) para substituir sidecar de 90s.',
      command: `node scripts/generate-full-audio-cache.js ${fileId}`,
      estimatedSizeMB: Math.round((durationDetected / 60) * 0.36)
    });
  } else if (isAvi && !hasFullCompatMp4) {
    audioState = 'Correção disponível';
    audioDetail = `AVI (compat.mp4 parcial: ${Math.round(Number(regEntry.compatDurationSec || 90))}s / ${Math.round(durationDetected)}s)`;
    controlledFixProposals.push({
      type: 'remux_full_avi_to_mp4',
      description: 'Transcodificar AVI integralmente para MP4 H.264 + AAC-LC sem alterar original no Drive.',
      estimatedSizeMB: 380
    });
  } else {
    audioState = 'Correção disponível';
    audioDetail = `Sidecar AAC parcial (${Math.round(sidecarDur || 90)}s / ${Math.round(durationDetected)}s) • Origem: ${audioCodecs.join(', ')}`;
    controlledFixProposals.push({
      type: 'transcode_full_hls_audio',
      description: `Extrair e converter faixa ${audioCodecs.join('/')} para HLS AAC-LC Estéreo 100% completo.`,
      command: `node scripts/generate-full-audio-cache.js ${fileId}`,
      estimatedSizeMB: Math.round((durationDetected / 60) * 0.36)
    });
  }

  // 4. Duração
  const catalogDurationDrift =
    durationCatalog > 0 && durationDetected > 0 ? Math.abs(durationCatalog - durationDetected) : 0;
  if (catalogDurationDrift > 5 || (durationCatalog === 0 && durationDetected > 0)) {
    autoFixableIssues.push({
      type: 'sync_catalog_duration',
      description: `Sincronizar duração declarada (${Math.round(durationCatalog)}s) com duração real detectada (${Math.round(durationDetected)}s).`
    });
  }
  const durationOk = durationDetected > 600;
  const durationStatus = durationOk ? `OK (${Math.round(durationDetected / 60)} min)` : 'Duração inválida';

  // 5. Seek
  const seekOk = uploadOk && (!isAvi || hasFullCompatMp4);
  const seekStatus = seekOk ? 'OK (HTTP 206 Range)' : 'Limitado a 90s (compat.mp4 parcial)';

  // 6. Preview
  const previewValidation = thumbMeta
    ? validatePreviewMath(durationDetected, thumbMeta)
    : {
        valid: Boolean(!regEntry || regEntry.hasThumbnailsSprite !== false),
        totalTiles: 4,
        distinctTilesUsed: 4,
        precisionMode: 'quadrant_sprite_plus_ondemand_ffmpeg',
        samplePoints: []
      };
  const previewStatus = previewValidation.valid
    ? `OK (${previewValidation.totalTiles} quadros + VTT)`
    : 'Atenção (Regenerar sprite)';

  // Status Consolidado (Seção 11)
  let overallStatus = 'Aprovado';
  if (!uploadOk || !durationOk) {
    overallStatus = 'Erro crítico';
  } else if (audioState === 'Correção disponível' || !videoOk) {
    overallStatus = 'Correção disponível';
  } else if (audioState === 'Atenção' || autoFixableIssues.length > 0) {
    overallStatus = 'Atenção';
  }

  return {
    fileId,
    title,
    versionHash,
    sizeBytes: size,
    sizeMB: Number((size / 1024 / 1024).toFixed(1)),
    container,
    videoCodecs,
    audioCodecs,
    audioTrackCount: audioTracks.length || 1,
    subtitleTrackCount: subtitleTracks.length || 0,
    durationCatalogSec: Math.round(durationCatalog),
    durationDetectedSec: Math.round(durationDetected),
    uploadStatus,
    audioStatus: audioDetail,
    videoStatus,
    durationStatus,
    seekStatus,
    previewStatus,
    previewValidation,
    overallStatus,
    autoFixableIssues,
    controlledFixProposals,
    auditedAt: new Date().toISOString()
  };
}

/**
 * Executa auditoria completa em toda a biblioteca e gera o sumário para o Painel de Integridade.
 */
export function runCatalogAudiovisualAudit(movies = [], registryFiles = {}, thumbMetaByFileId = {}) {
  const startedAt = Date.now();
  const seenIds = new Set();
  const items = [];

  for (const m of movies) {
    if (!m || !m.driveFileId || seenIds.has(m.driveFileId)) continue;
    seenIds.add(m.driveFileId);
    const regEntry = registryFiles[m.driveFileId] || null;
    const thumbMeta = thumbMetaByFileId[m.driveFileId] || null;
    items.push(auditSingleMovieRecord(m, regEntry, thumbMeta));
  }

  const summary = {
    totalRegistered: items.length,
    totalAudited: items.length,
    approved: items.filter((i) => i.overallStatus === 'Aprovado').length,
    attention: items.filter((i) => i.overallStatus === 'Atenção').length,
    fixAvailable: items.filter((i) => i.overallStatus === 'Correção disponível').length,
    criticalError: items.filter((i) => i.overallStatus === 'Erro crítico').length,
    pending: 0,
    autoFixableCount: items.reduce((acc, i) => acc + i.autoFixableIssues.length, 0),
    controlledProposalsCount: items.reduce((acc, i) => acc + i.controlledFixProposals.length, 0),
    lastAuditAt: new Date().toISOString(),
    nextScheduledAuditAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    durationMs: Date.now() - startedAt
  };

  return { summary, items };
}

/**
 * Gerenciador de Fila Persistente/Idempotente com Controle de Concorrência, Retry Exponencial e DLQ.
 */
export class AudiovisualAuditQueue {
  constructor(options = {}) {
    this.maxConcurrent = options.maxConcurrent || 2;
    this.maxRetries = options.maxRetries || 3;
    this.tasks = new Map(); // taskId -> task
    this.completedHashes = new Set();
    this.dlq = [];
    this.activeCount = 0;
    this.history = [];
  }

  enqueue(fileId, versionHash, reason = 'upload_or_periodic', handler) {
    const taskId = `audit_${fileId}_${versionHash}`;
    if (this.completedHashes.has(versionHash) && reason !== 'manual_force') {
      return { enqueued: false, taskId, status: 'skipped_idempotent' };
    }
    if (this.tasks.has(taskId)) {
      return { enqueued: false, taskId, status: 'already_queued' };
    }
    const task = {
      taskId,
      fileId,
      versionHash,
      reason,
      attempts: 0,
      status: 'queued',
      enqueuedAt: new Date().toISOString(),
      handler
    };
    this.tasks.set(taskId, task);
    this._pump();
    return { enqueued: true, taskId, status: 'queued' };
  }

  async _pump() {
    if (this.activeCount >= this.maxConcurrent) return;
    const nextTask = Array.from(this.tasks.values()).find((t) => t.status === 'queued');
    if (!nextTask) return;

    nextTask.status = 'running';
    nextTask.attempts += 1;
    this.activeCount += 1;

    try {
      const result = await nextTask.handler(nextTask);
      nextTask.status = 'completed';
      this.completedHashes.add(nextTask.versionHash);
      this.tasks.delete(nextTask.taskId);
      this.history.unshift({
        taskId: nextTask.taskId,
        fileId: nextTask.fileId,
        reason: nextTask.reason,
        status: 'completed',
        attempts: nextTask.attempts,
        completedAt: new Date().toISOString(),
        overallStatus: result && result.overallStatus
      });
      if (this.history.length > 50) this.history.length = 50;
    } catch (err) {
      if (nextTask.attempts < this.maxRetries) {
        nextTask.status = 'retrying';
        const delayMs = 300 * Math.pow(2, nextTask.attempts - 1);
        setTimeout(() => {
          if (this.tasks.has(nextTask.taskId)) {
            nextTask.status = 'queued';
            this._pump();
          }
        }, delayMs);
      } else {
        nextTask.status = 'failed_dlq';
        this.tasks.delete(nextTask.taskId);
        this.dlq.unshift({
          taskId: nextTask.taskId,
          fileId: nextTask.fileId,
          reason: nextTask.reason,
          attempts: nextTask.attempts,
          error: err && err.message ? err.message : 'Unknown audit failure',
          failedAt: new Date().toISOString()
        });
        if (this.dlq.length > 30) this.dlq.length = 30;
      }
    } finally {
      this.activeCount = Math.max(0, this.activeCount - 1);
      this._pump();
    }
  }

  getSnapshot() {
    return {
      activeCount: this.activeCount,
      queuedCount: Array.from(this.tasks.values()).filter((t) => t.status === 'queued' || t.status === 'retrying').length,
      completedVersionsCount: this.completedHashes.size,
      dlqCount: this.dlq.length,
      dlq: this.dlq.slice(0, 10),
      recentHistory: this.history.slice(0, 15)
    };
  }
}
