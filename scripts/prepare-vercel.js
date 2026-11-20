#!/usr/bin/env node
'use strict';

/**
 * Script de build para o Front-end Híbrido na Vercel.
 * - Valida presença dos assets essenciais em public/
 * - Gera public/env-config.js (APENAS metadados públicos, NUNCA segredos!)
 * - Permite diferenciar Preview/Staging vs Production via CLOUDFLARE_BACKEND_URL
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const requiredFiles = ['index.html', 'app.js', 'style.css', 'design-tokens.css', 'theme-redesign.css'];
for (const f of requiredFiles) {
  const full = path.join(PUBLIC_DIR, f);
  if (!fs.existsSync(full)) {
    console.error(`[VERCEL_BUILD] Arquivo obrigatório ausente: public/${f}`);
    process.exit(1);
  }
}

const vercelEnv = process.env.VERCEL_ENV || process.env.NODE_ENV || 'development';
const backendUrl = (
  process.env.CLOUDFLARE_BACKEND_URL ||
  (vercelEnv === 'preview'
    ? 'https://cine-pomp-staging.cz-santosf.workers.dev'
    : 'https://cine-pomp.cz-santosf.workers.dev')
).replace(/\/+$/, '');

const envConfigContent = `// Gerado automaticamente em build por scripts/prepare-vercel.js (sem segredos)
window.__CINE_ENV__ = Object.freeze({
  environment: ${JSON.stringify(vercelEnv)},
  architecture: 'hybrid-vercel-cloudflare',
  backendOrigin: ${JSON.stringify(backendUrl)},
  useSameOriginProxy: true,
  builtAt: ${JSON.stringify(new Date().toISOString())}
});
`;

fs.writeFileSync(path.join(PUBLIC_DIR, 'env-config.js'), envConfigContent, 'utf8');
console.log(
  `[VERCEL_BUILD] Front-end preparado | env=${vercelEnv} | backend=${backendUrl} | proxy=same-origin`
);
