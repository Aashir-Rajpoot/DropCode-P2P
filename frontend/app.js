(() => {
  'use strict';

  const CODE_LENGTH = 5;
  const MAX_FILE_SIZE_BYTES = 1024 * 1024 * 1024; // ~1 GB, soft cap enforced client-side
  const CHUNK_SIZE = 64 * 1024; // 64 KB per DataChannel message
  const BUFFERED_HIGH_WATER = 4 * 1024 * 1024; // pause sending above this
  const BUFFERED_LOW_THRESHOLD = 1 * 1024 * 1024; // resume once drained below this

  function wsUrl() {
    if (window.DROPCODE_WS_URL) return window.DROPCODE_WS_URL;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Local dev default: signaling server on :4000. If the page itself is
    // already served from :4000 (or a reverse proxy strips the port),
    // fall back to same-origin.
    if (location.port && location.port !== '4000') return `${proto}//${location.hostname}:4000`;
    return `${proto}//${location.host}`;
  }

  // TURN servers are fetched once (from the signaling server's
  // GET /ice-servers) and cached for the page's lifetime — a manual
  // window.DROPCODE_TURN_SERVERS in config.js always wins over that fetch.
  let turnServersPromise = null;
  async function resolveTurnServers() {
    if (Array.isArray(window.DROPCODE_TURN_SERVERS)) return window.DROPCODE_TURN_SERVERS;
    if (!turnServersPromise) {
      turnServersPromise = (async () => {
        try {
          const base = wsUrl().replace(/^ws/, 'http');
          const res = await fetch(`${base}/ice-servers`, { cache: 'no-store' });
          if (!res.ok) return [];
          const data = await res.json();
          return Array.isArray(data.turnServers) ? data.turnServers : [];
        } catch {
          // Older/unreachable signaling server without this endpoint — fall
          // back to STUN-only rather than failing the whole connection.
          return [];
        }
      })();
    }
    return turnServersPromise;
  }

  async function rtcConfig() {
    const iceServers = [
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];
    const turnServers = await resolveTurnServers();
    if (window.DROPCODE_DEBUG_WEBRTC) {
      console.log('[DropCode] ICE servers:', iceServers.length, 'STUN +', turnServers.length, 'TURN entr(y/ies)');
    }
    return { iceServers: iceServers.concat(turnServers) };
  }

  // Attaches state-change diagnostics (gated by window.DROPCODE_DEBUG_WEBRTC)
  // and returns a small helper for queuing remote ICE candidates that arrive
  // before setRemoteDescription() has completed — addIceCandidate() throws
  // in that case, so without queuing those candidates are silently lost.
  function attachPeerDiagnostics(pc, label) {
    if (!window.DROPCODE_DEBUG_WEBRTC) return;
    pc.addEventListener('iceconnectionstatechange', () => {
      console.log(`[DropCode:${label}] iceConnectionState:`, pc.iceConnectionState);
    });
    pc.addEventListener('connectionstatechange', () => {
      console.log(`[DropCode:${label}] connectionState:`, pc.connectionState);
    });
    pc.addEventListener('icegatheringstatechange', () => {
      console.log(`[DropCode:${label}] iceGatheringState:`, pc.iceGatheringState);
    });
    pc.addEventListener('signalingstatechange', () => {
      console.log(`[DropCode:${label}] signalingState:`, pc.signalingState);
    });
  }

  function makePendingCandidateQueue(pc) {
    const pending = [];
    return {
      // Call for every remote candidate message. Queues it if the remote
      // description isn't set yet instead of calling addIceCandidate()
      // (which would throw and silently drop it in the existing catch-all).
      async add(candidate) {
        if (pc.remoteDescription) {
          try { await pc.addIceCandidate(candidate); } catch { /* benign if already closed */ }
        } else {
          pending.push(candidate);
        }
      },
      // Call right after setRemoteDescription() resolves.
      async flush() {
        const queued = pending.splice(0);
        for (const candidate of queued) {
          try { await pc.addIceCandidate(candidate); } catch { /* benign if already closed */ }
        }
      },
    };
  }

  // ---------------------------------------------------------------------
  // Small DOM helpers
  // ---------------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function showStep(panelEl, stepName) {
    $$('.panel-step', panelEl).forEach((el) => {
      el.hidden = el.dataset.step !== stepName;
    });
  }

  function formatBytes(bytes) {
    if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const value = bytes / 1024 ** i;
    return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    if (seconds < 1) return '<1s';
    if (seconds < 60) return `${Math.ceil(seconds)}s`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${s}s`;
  }

  function formatCountdown(msRemaining) {
    if (!Number.isFinite(msRemaining) || msRemaining <= 0) return 'expired';
    const totalSec = Math.round(msRemaining / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}m ${s.toString().padStart(2, '0')}s`;
  }

  function extOf(name) {
    const i = (name || '').lastIndexOf('.');
    return i > 0 ? name.slice(i + 1).toUpperCase().slice(0, 4) : 'FILE';
  }

  let toastTimer = null;
  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600);
  }

  // ---------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------
  function initTheme() {
    const stored = localStorage.getItem('dropcode-theme');
    const preferred =
      stored || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    document.documentElement.setAttribute('data-theme', preferred);
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('dropcode-theme', next);
  }

  // ---------------------------------------------------------------------
  // View routing (home / send / receive)
  // ---------------------------------------------------------------------
  function goToView(name) {
    $$('.view').forEach((el) => {
      const active = el.dataset.view === name;
      el.classList.toggle('is-active', active);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // =======================================================================
  // Signaling (WebSocket) — one socket per active flow. Only ever carries
  // JSON control messages (offer/answer/ICE/room state). File bytes never
  // touch this connection or the server.
  // =======================================================================
  function openSignaling() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(wsUrl());
      ws.addEventListener('open', () => {
        settled = true;
        resolve(ws);
      });
      ws.addEventListener('error', () => {
        if (!settled) reject(new Error('Could not reach the signaling server'));
      });
      ws.addEventListener('close', () => {
        if (!settled) reject(new Error('Could not reach the signaling server'));
      });
    });
  }

  function wsSend(ws, obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // =======================================================================
  // SEND FLOW
  // =======================================================================
  const sendPanel = $('#view-send');
  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');
  const filePreview = $('#file-preview');
  const btnStartUpload = $('#btn-start-upload');
  let selectedFile = null;

  // Live state for the current outgoing transfer, so Cancel/New Transfer
  // can tear everything down cleanly.
  let sendState = null; // { ws, pc, channel, pendingCandidates: [] }

  function teardownSendState() {
    if (!sendState) return;
    try { sendState.channel && sendState.channel.close(); } catch {}
    try { sendState.pc && sendState.pc.close(); } catch {}
    try { sendState.ws && sendState.ws.close(); } catch {}
    sendState = null;
  }

  function resetSendFlow() {
    teardownSendState();
    selectedFile = null;
    fileInput.value = '';
    filePreview.hidden = true;
    btnStartUpload.disabled = false;
    showStep(sendPanel, 'dropzone');
  }

  function onFileSelected(file) {
    if (!file) return;
    if (file.size > MAX_FILE_SIZE_BYTES) {
      showSendError('File too large', `Files must be ${formatBytes(MAX_FILE_SIZE_BYTES)} or smaller.`);
      return;
    }
    if (file.size === 0) {
      showSendError('Empty file', 'That file appears to be empty.');
      return;
    }
    selectedFile = file;
    $('#file-preview-icon').textContent = extOf(file.name);
    $('#file-preview-name').textContent = file.name;
    $('#file-preview-details').textContent = `${formatBytes(file.size)} · ${file.type || 'unknown type'}`;
    filePreview.hidden = false;
    btnStartUpload.disabled = false;
  }

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  ['dragenter', 'dragover'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add('is-dragover');
    })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove('is-dragover');
    })
  );
  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files?.[0];
    onFileSelected(file);
  });
  fileInput.addEventListener('change', () => onFileSelected(fileInput.files?.[0]));

  $('#file-preview-remove').addEventListener('click', () => {
    selectedFile = null;
    fileInput.value = '';
    filePreview.hidden = true;
    btnStartUpload.disabled = true;
  });

  const RING_CIRCUMFERENCE = 2 * Math.PI * 52;

  function setProgress(loaded, total, startedAt) {
    const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    $('#progress-percent').textContent = `${pct}%`;
    $('#progress-ring-fill').style.strokeDasharray = String(RING_CIRCUMFERENCE);
    $('#progress-ring-fill').style.strokeDashoffset = String(
      RING_CIRCUMFERENCE - (pct / 100) * RING_CIRCUMFERENCE
    );

    const elapsedSec = (Date.now() - startedAt) / 1000;
    const speedBps = elapsedSec > 0 ? loaded / elapsedSec : 0;
    $('#upload-speed').textContent = speedBps > 0 ? `${formatBytes(speedBps)}/s` : '—';

    const remainingBytes = Math.max(0, total - loaded);
    const etaSec = speedBps > 0 ? remainingBytes / speedBps : Infinity;
    $('#upload-eta').textContent = total ? formatDuration(etaSec) : '—';
  }

  function showSendError(title, message) {
    teardownSendState();
    $('#send-error-title').textContent = title;
    $('#send-error-message').textContent = message;
    showStep(sendPanel, 'error');
  }

  // Sends file metadata, then raw chunks, respecting backpressure via
  // bufferedAmount / bufferedamountlow, then a final 'done' marker.
  async function sendFileOverChannel(channel, file, onProgress) {
    channel.bufferedAmountLowThreshold = BUFFERED_LOW_THRESHOLD;
    channel.send(JSON.stringify({
      type: 'meta',
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
    }));

    let offset = 0;
    while (offset < file.size) {
      if (channel.readyState !== 'open') throw new Error('Connection closed before the transfer finished.');
      if (channel.bufferedAmount > BUFFERED_HIGH_WATER) {
        await new Promise((resolve) => {
          const handler = () => {
            channel.removeEventListener('bufferedamountlow', handler);
            resolve();
          };
          channel.addEventListener('bufferedamountlow', handler);
        });
      }
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const buf = await slice.arrayBuffer();
      if (channel.readyState !== 'open') throw new Error('Connection closed before the transfer finished.');
      channel.send(buf);
      offset += buf.byteLength;
      onProgress(offset, file.size);
    }
    channel.send(JSON.stringify({ type: 'done' }));
  }

  async function startSendFlow() {
    if (!selectedFile) return;
    const file = selectedFile;
    teardownSendState();

    showStep(sendPanel, 'uploading');
    $('#uploading-title').textContent = 'Preparing…';
    $('#uploading-filename').textContent = file.name;
    setProgress(0, file.size, Date.now());

    let ws;
    try {
      ws = await openSignaling();
    } catch (err) {
      showSendError('Could not connect', err.message || 'The signaling server is unreachable.');
      return;
    }

    const pc = new RTCPeerConnection(await rtcConfig());
    const candidateQueue = makePendingCandidateQueue(pc);
    const state = { ws, pc, channel: null };
    sendState = state;

    attachPeerDiagnostics(pc, 'sender');
    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate) wsSend(ws, { type: 'ice-candidate', candidate: e.candidate });
    });
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') {
        showSendError('Connection failed', "Couldn't establish a direct connection. This network may require a TURN relay.");
      }
    });

    let startedAt = null;
    let transferStarted = false;

    ws.addEventListener('message', async (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }

      switch (msg.type) {
        case 'room-created': {
          $('#result-code').textContent = msg.code;
          $('#send-badge').textContent = 'WAITING FOR RECEIVER';
          $('#code-status-hint').textContent = `Share this code — expires ${formatCountdown(msg.expiresAt - Date.now())} from now.`;
          showStep(sendPanel, 'complete');
          break;
        }
        case 'receiver-joined': {
          $('#code-status-hint').textContent = 'Receiver connected — negotiating…';
          try {
            const channel = pc.createDataChannel('file');
            state.channel = channel;
            channel.binaryType = 'arraybuffer';
            channel.addEventListener('open', () => {
              $('#code-status-hint').textContent = 'Connected. Waiting for receiver to start the download…';
            });
            channel.addEventListener('message', async (e) => {
              if (typeof e.data !== 'string') return;
              let ctrl;
              try { ctrl = JSON.parse(e.data); } catch { return; }
              if (ctrl.type === 'start-transfer' && !transferStarted) {
                transferStarted = true;
                startedAt = Date.now();
                showStep(sendPanel, 'uploading');
                $('#uploading-title').textContent = 'Sending…';
                $('#uploading-filename').textContent = file.name;
                try {
                  await sendFileOverChannel(channel, file, (loaded, total) => setProgress(loaded, total, startedAt));
                } catch (err) {
                  showSendError('Transfer failed', err.message || 'Something went wrong during the transfer.');
                }
              } else if (ctrl.type === 'ack-complete') {
                wsSend(ws, { type: 'transfer-complete' });
                $('#send-badge').textContent = 'TRANSFER COMPLETE';
                $('#code-status-hint').textContent = 'Your file was delivered.';
                showStep(sendPanel, 'complete');
                teardownSendState();
              }
            });
            channel.addEventListener('close', () => {
              if (!transferStarted) return;
            });

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            wsSend(ws, { type: 'offer', sdp: pc.localDescription });
          } catch (err) {
            showSendError('Connection failed', err.message || 'Could not negotiate a connection.');
          }
          break;
        }
        case 'answer': {
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            await candidateQueue.flush();
          } catch (err) {
            showSendError('Connection failed', 'Could not complete the connection handshake.');
          }
          break;
        }
        case 'ice-candidate': {
          await candidateQueue.add(msg.candidate);
          break;
        }
        case 'receiver-disconnected': {
          if (!transferStarted) {
            showSendError('Receiver disconnected', 'The receiver left before the transfer could start.');
          }
          break;
        }
        case 'expired': {
          showSendError('Code expired', 'Nobody connected within 30 minutes, so this code was released.');
          break;
        }
        case 'cancelled': {
          showToast('Receiver cancelled the transfer');
          resetSendFlow();
          break;
        }
        case 'error': {
          showSendError('Something went wrong', msg.message || 'Please try again.');
          break;
        }
      }
    });

    ws.addEventListener('close', () => {
      if (!transferStarted && sendState) {
        // Unexpected drop while still waiting/negotiating.
      }
    });

    wsSend(ws, {
      type: 'create-room',
      fileMeta: { name: file.name, size: file.size, mime: file.type || 'application/octet-stream' },
    });
  }

  btnStartUpload.addEventListener('click', startSendFlow);

  $('#btn-cancel-upload').addEventListener('click', () => {
    if (sendState) wsSend(sendState.ws, { type: 'cancel' });
    resetSendFlow();
  });

  $('#btn-new-transfer').addEventListener('click', resetSendFlow);
  $('#btn-retry-send').addEventListener('click', () => showStep(sendPanel, 'dropzone'));

  $('#btn-copy-code').addEventListener('click', async () => {
    const code = $('#result-code').textContent;
    try {
      await navigator.clipboard.writeText(code);
      showToast('Code copied to clipboard');
    } catch {
      showToast('Could not copy — copy it manually');
    }
  });

  $('#btn-share-code').addEventListener('click', async () => {
    const code = $('#result-code').textContent;
    const text = `Download my file using DropCode code: ${code}`;
    if (navigator.share) {
      try {
        await navigator.share({ text, title: 'DropCode' });
      } catch {
        /* user cancelled share sheet - no-op */
      }
    } else {
      try {
        await navigator.clipboard.writeText(text);
        showToast('Share text copied to clipboard');
      } catch {
        showToast('Could not copy — copy it manually');
      }
    }
  });

  // =======================================================================
  // RECEIVE FLOW
  // =======================================================================
  const receivePanel = $('#view-receive');
  const digitInputs = $$('.code-digit', receivePanel);
  const btnFindFile = $('#btn-find-file');
  const btnDownloadFile = $('#btn-download-file');
  const btnCancelReceive = $('#btn-cancel-receive');

  let receiveState = null; // { ws, pc, channel, fileMeta, chunks, received, pendingStart }

  function currentCode() {
    return digitInputs.map((el) => el.value).join('');
  }

  function updateFindButtonState() {
    const code = currentCode();
    btnFindFile.disabled = !/^\d{5}$/.test(code);
    $('#receive-entry-error').hidden = true;
  }

  digitInputs.forEach((input, idx) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 1);
      if (input.value && idx < digitInputs.length - 1) {
        digitInputs[idx + 1].focus();
      }
      updateFindButtonState();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && idx > 0) {
        digitInputs[idx - 1].focus();
      }
      if (e.key === 'Enter' && !btnFindFile.disabled) {
        performLookup();
      }
    });

    input.addEventListener('paste', (e) => {
      e.preventDefault();
      const pasted = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, CODE_LENGTH);
      pasted.split('').forEach((digit, i) => {
        if (digitInputs[i]) digitInputs[i].value = digit;
      });
      const nextIdx = Math.min(pasted.length, digitInputs.length - 1);
      digitInputs[nextIdx].focus();
      updateFindButtonState();
    });
  });

  function teardownReceiveState() {
    if (!receiveState) return;
    try { receiveState.channel && receiveState.channel.close(); } catch {}
    try { receiveState.pc && receiveState.pc.close(); } catch {}
    try { receiveState.ws && receiveState.ws.close(); } catch {}
    receiveState = null;
  }

  function resetReceiveFlow() {
    teardownReceiveState();
    digitInputs.forEach((el) => (el.value = ''));
    updateFindButtonState();
    btnCancelReceive.hidden = true;
    showStep(receivePanel, 'entry');
    digitInputs[0].focus();
  }

  function showReceiveError(title, message) {
    teardownReceiveState();
    $('#receive-error-title').textContent = title;
    $('#receive-error-message').textContent = message;
    showStep(receivePanel, 'error');
  }

  function setReceiveStatus(text) {
    $('#receive-status-text').textContent = text;
  }

  function triggerBrowserDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function setupReceiverChannel(channel, state) {
    channel.binaryType = 'arraybuffer';
    let startedAt = null;

    channel.addEventListener('open', () => {
      if (state.pendingStart) {
        state.pendingStart = false;
        channel.send(JSON.stringify({ type: 'start-transfer' }));
        startedAt = Date.now();
      }
    });

    channel.addEventListener('message', (e) => {
      if (typeof e.data === 'string') {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'meta') {
          state.chunks = [];
          state.received = 0;
          state.meta = msg;
          if (!startedAt) startedAt = Date.now();
        } else if (msg.type === 'done') {
          const blob = new Blob(state.chunks, { type: state.meta?.mime || 'application/octet-stream' });
          state.chunks = [];
          triggerBrowserDownload(blob, state.meta?.name);
          channel.send(JSON.stringify({ type: 'ack-complete' }));
          showToast(`Received: ${state.meta?.name || 'file'}`);
          resetReceiveFlow();
        }
        return;
      }
      if (!state.chunks) return;
      state.chunks.push(e.data);
      state.received += e.data.byteLength;
      const total = state.meta?.size || 0;
      const pct = total ? Math.min(100, Math.round((state.received / total) * 100)) : 0;
      const elapsedSec = (Date.now() - startedAt) / 1000;
      const speedBps = elapsedSec > 0 ? state.received / elapsedSec : 0;
      const etaSec = speedBps > 0 ? Math.max(0, total - state.received) / speedBps : Infinity;
      setReceiveStatus(
        `Receiving… ${pct}% · ${formatBytes(state.received)} / ${formatBytes(total)} · ` +
        `${speedBps > 0 ? formatBytes(speedBps) + '/s' : '—'} · ETA ${total ? formatDuration(etaSec) : '—'}`
      );
    });
  }

  async function performLookup() {
    const code = currentCode();
    if (!/^\d{5}$/.test(code)) return;

    teardownReceiveState();
    showStep(receivePanel, 'looking-up');
    btnCancelReceive.hidden = true;
    setReceiveStatus('Connecting…');

    let ws;
    try {
      ws = await openSignaling();
    } catch (err) {
      showReceiveError('Could not connect', err.message || 'The signaling server is unreachable.');
      return;
    }

    const pc = new RTCPeerConnection(await rtcConfig());
    const candidateQueue = makePendingCandidateQueue(pc);
    const state = { ws, pc, channel: null, chunks: null, received: 0, meta: null, pendingStart: false };
    receiveState = state;

    attachPeerDiagnostics(pc, 'receiver');
    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate) wsSend(ws, { type: 'ice-candidate', candidate: e.candidate });
    });
    pc.addEventListener('datachannel', (e) => {
      state.channel = e.channel;
      setupReceiverChannel(e.channel, state);
    });
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') {
        showReceiveError('Connection failed', "Couldn't establish a direct connection. This network may require a TURN relay.");
      }
    });

    ws.addEventListener('message', async (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }

      switch (msg.type) {
        case 'room-joined': {
          state.meta = { name: msg.fileMeta.name, size: msg.fileMeta.size, mime: msg.fileMeta.mime };
          $('#found-file-icon').textContent = extOf(msg.fileMeta.name);
          $('#found-file-name').textContent = msg.fileMeta.name || 'Untitled file';
          $('#found-file-size').textContent = formatBytes(msg.fileMeta.size);
          $('#found-file-type').textContent = msg.fileMeta.mime || 'unknown';
          $('#found-file-created').textContent = 'Ready';
          $('#found-file-expires').textContent = formatCountdown(msg.expiresAt - Date.now());
          btnDownloadFile.disabled = false;
          btnDownloadFile.textContent = 'DOWNLOAD FILE';
          showStep(receivePanel, 'found');
          break;
        }
        case 'offer': {
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            await candidateQueue.flush();
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            wsSend(ws, { type: 'answer', sdp: pc.localDescription });
          } catch (err) {
            showReceiveError('Connection failed', 'Could not negotiate a connection.');
          }
          break;
        }
        case 'ice-candidate': {
          await candidateQueue.add(msg.candidate);
          break;
        }
        case 'sender-disconnected': {
          showReceiveError('Sender disconnected', 'The sender left before the transfer finished.');
          break;
        }
        case 'expired': {
          showReceiveError('Code expired', 'This code is no longer valid.');
          break;
        }
        case 'cancelled': {
          showReceiveError('Transfer cancelled', 'The sender cancelled this transfer.');
          break;
        }
        case 'error': {
          showReceiveError('Code not found', msg.message || "That code is invalid, expired, or doesn't exist.");
          break;
        }
      }
    });

    wsSend(ws, { type: 'join-room', code });
  }

  btnFindFile.addEventListener('click', performLookup);

  btnDownloadFile.addEventListener('click', () => {
    if (!receiveState) return;
    btnDownloadFile.disabled = true;
    btnDownloadFile.textContent = 'CONNECTING…';
    showStep(receivePanel, 'looking-up');
    btnCancelReceive.hidden = false;

    if (receiveState.channel && receiveState.channel.readyState === 'open') {
      receiveState.channel.send(JSON.stringify({ type: 'start-transfer' }));
      setReceiveStatus('Starting transfer…');
    } else {
      receiveState.pendingStart = true;
      setReceiveStatus('Connecting…');
    }
  });

  btnCancelReceive.addEventListener('click', () => {
    if (receiveState) wsSend(receiveState.ws, { type: 'cancel' });
    resetReceiveFlow();
  });

  $('#btn-receive-another').addEventListener('click', resetReceiveFlow);
  $('#btn-retry-receive').addEventListener('click', resetReceiveFlow);

  // =======================================================================
  // Global navigation wiring + init
  // =======================================================================
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-action]');
    if (!trigger) return;
    const action = trigger.dataset.action;

    if (action === 'go-home') {
      e.preventDefault();
      goToView('home');
    } else if (action === 'show-send') {
      resetSendFlow();
      goToView('send');
    } else if (action === 'show-receive') {
      resetReceiveFlow();
      goToView('receive');
    } else if (action === 'toggle-theme') {
      toggleTheme();
    }
  });

  initTheme();
  goToView('home');
})();
