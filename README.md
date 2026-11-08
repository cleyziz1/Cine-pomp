# 🍿 CINE POMPEIA — Cinema Virtual Privado & Streaming via Google Drive

Plataforma privada de cinema virtual sincronizado para até **12 amigos** (com mapa de 12 poltronas numeradas `A1–A6` e `B1–B6`), vitrine estilo **Netflix / HBO Max / Prime Video** e reprodução direta de vídeos armazenados no **Google Drive** via **Player Nativo HTML5/HLS + WebSockets (`Socket.io`)**.

## ✨ Recursos

- **☁️ Streaming Conectado ao Google Drive:**
  - **Sincronizador de Pasta Inteira:** Cole o link de uma pasta pública do seu Google Drive (`https://drive.google.com/drive/folders/...`) para importar automaticamente todos os vídeos da pasta com capa, fundo widescreen, nota, ano e sinopse preenchidos automaticamente.
  - **Adição Individual de Filmes:** Adicione links individuais do Google Drive com preenchimento automático de pôster.
  - **Proxy de Stream para Arquivos Grandes (`/api/gdrive/stream/:fileId`):** Contorna a tela de aviso de antivírus do Google Drive para arquivos de múltiplos gigabytes e oferece suporte a `Range Requests (HTTP 206)` para avançar/voltar na timeline instantaneamente.
- **⚡ Sincronia em Tempo Real (WebSockets):**
  - Quando o Anfitrião (`👑`) aperta **Play**, **Pause** ou altera o tempo do filme (`-10s`, `+10s`, barra de progresso), o player sincroniza automaticamente o vídeo de todos os 12 participantes na sala.
  - **🎬 Claquete 3-2-1-PLAY** com sinal sonoro e visual sincronizado.
  - **💡 Modo Luzes Apagadas**, **Chat em Tempo Real** e **Reações Flutuantes** saindo da poltrona de cada amigo.

## 🚀 Como Executar

1. Instale as dependências:
   ```bash
   npm install
   ```
2. Copie o arquivo `.env.example` para `.env` (opcionalmente informe sua `TMDB_API_KEY` para busca automática de pôsteres):
   ```bash
   cp .env.example .env
   ```
3. Inicie o servidor:
   ```bash
   npm start
   ```
4. Acesse em `http://localhost:3000`.
