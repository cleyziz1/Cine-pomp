# Arquitetura Híbrida — Vercel (Front-end) + Cloudflare Workers (Back-end & Mídia)

## Visão Geral
- **Vercel (Front-end CDN Global — Plano Hobby):** serve `public/` (`index.html`, `app.js`, `style.css`, `env-config.js`) com upload ultra-leve (~290 KB via `.vercelignore`, sem duplicar `public/media_cache/`).
- **Cloudflare Workers (Back-end API + Streaming Proxy + Assets HLS — Plano Free):** executa `src/worker.js` + `src/shared/media-utils.mjs`, entrega `/api/*` e `/media_cache/*` (segmentos HLS AAC-LC, sprites de timeline e fallbacks).
- **Google Drive:** armazenamento original dos filmes (pasta `185iFV7I5x107sxJDTVbSxA9F0pY3GtTr`), intocado.

## Integração Same-Origin & CORS
- `vercel.json` configura rewrites transparentes:
  - `/api/:path*` → `https://cine-pomp.cz-santosf.workers.dev/api/:path*`
  - `/media_cache/:path*` → `https://cine-pomp.cz-santosf.workers.dev/media_cache/:path*`
- `src/worker.js` também implementa CORS seguro (allowlist para `*.vercel.app`, `*.workers.dev`, `localhost` e `ALLOWED_ORIGINS`) e `OPTIONS` preflight `204`, garantindo funcionamento tanto via rewrite same-origin quanto em acessos cross-origin.

## Mapa de Endpoints
| Endpoint | Método | Responsabilidade |
| :--- | :--- | :--- |
| `/api/health` | `GET`, `HEAD` | Health-check para monitoramento da arquitetura híbrida |
| `/api/auth/login`, `/me`, `/logout` | `POST`, `GET` | RBAC Admin HMAC + rate limit `429` (`8` falhas / `15 min`) |
| `/api/drive/catalog` | `GET` | Catálogo enriquecido + auto-sync `60s` + `ETag`/`304` + `no-cache` |
| `/api/drive/sync-status` | `GET` | Estado da sincronização + logs estruturados `recentEvents` |
| `/api/drive/sync-folder` | `POST` (Admin) | Reconciliação manual (adição, renomeação, exclusão) |
| `/api/admin/movies-health` | `GET` (Admin) | Diagnóstico de saúde por filme (codecs, áudio completo, capas) |
| `/api/videos/:id/stream` | `GET`, `HEAD` | Streaming HTTP `206`/`416` (`8 MB` chunks) + patch EBML `A_AC3`/`A_EAC3`/`A_DTS` |
| `/api/videos/:id/download` | `GET`, `HEAD` | Download direto seguro (`302` / `Content-Disposition: attachment`) |
| `/api/videos/:id/diagnostics` | `GET` | Codecs, faixas, idioma e URL do sidecar HLS AAC-LC |
| `/api/videos/:id/thumbnails/*` | `GET` | `meta`, `thumbnails.vtt` e recorte de sprites na linha do tempo |

## Ambientes: Homologação vs. Produção
- **Cloudflare Staging:** `npx wrangler deploy --env staging` (`cine-pomp-staging`)
- **Cloudflare Production:** `npx wrangler deploy` (`cine-pomp`)
- **Vercel Preview (Homologação):** deploy automático em Pull Requests / branch `staging`
- **Vercel Production:** somente após aprovação explícita

## Custos e Limites dos Planos Gratuitos
- **Vercel Hobby (Gratuito):** `100 GB`/mês de banda Fast Data Transfer; sem funções serverless ativas neste projeto (custo `$0`).
- **Cloudflare Workers Free (Gratuito):** `100.000` requisições/dia, `10 ms` CPU/req, Static Assets até `25 MiB`/arquivo e `20.000` arquivos (atualmente ~1.200 arquivos, todos `< 210 KB`).
- **Google Drive:** armazenamento existente do usuário (sem custo adicional).

## Procedimento de Reversão (Rollback)
1. **Reversão completa para o ponto pré-migração híbrida (tag criada antes das alterações):**
   ```powershell
   git checkout backup/pre-hybrid-vercel-cloudflare
   ```
2. **Reversão em produção após merge/deploy:**
   ```powershell
   git revert HEAD --no-edit
   git push origin main
   ```
   A Cloudflare restaura automaticamente o Worker anterior em ~45s e o site continua 100% operacional em `https://cine-pomp.cz-santosf.workers.dev` mesmo sem a Vercel.
