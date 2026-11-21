(() => {
    'use strict';

    const canvas = document.getElementById('board');
    const ctx = canvas.getContext('2d', { alpha: false });

    const scoreEl = document.getElementById('score');
    const bestEl = document.getElementById('best');
    const levelEl = document.getElementById('level');
    const pauseButton = document.getElementById('pause');
    const soundButton = document.getElementById('sound');
    const overlay = document.getElementById('overlay');
    const overlayTitle = document.getElementById('overlay-title');
    const overlayText = document.getElementById('overlay-text');
    const primaryButton = document.getElementById('primary');
    const connectionEl = document.getElementById('connection');
    const dpad = document.getElementById('dpad');

    // Der Server schiebt Zustaende per SSE. Polling ist nur noch Fallback,
    // falls EventSource nicht zur Verfuegung steht oder die Verbindung haengt.
    const POLL_INTERVAL_MS = 400;
    const SSE_STALE_MS = 2000;
    const DIRECTIONS = {
        UP: { x: 0, y: -1 },
        DOWN: { x: 0, y: 1 },
        LEFT: { x: -1, y: 0 },
        RIGHT: { x: 1, y: 0 }
    };
    const KEY_DIRECTIONS = {
        arrowup: 'UP',
        w: 'UP',
        arrowdown: 'DOWN',
        s: 'DOWN',
        arrowleft: 'LEFT',
        a: 'LEFT',
        arrowright: 'RIGHT',
        d: 'RIGHT'
    };

    let state = null;
    let gameId = null;
    let pollTimer = null;
    let gameRequest = null;
    let eventSource = null;
    let lastPushAt = 0;
    let overlayKey = '';
    let rendered = [];
    let lastFrame = performance.now();
    let audioContext = null;
    let muted = localStorage.getItem('snake.muted') === '1';

    // ------------------------------------------------------------------
    // API
    // Lesen und Schreiben laufen in getrennten Queues: eine Richtungsaenderung
    // wartet nicht hinter einem gerade laufenden Poll-Request.
    // ------------------------------------------------------------------

    const apiQueues = { read: Promise.resolve(), write: Promise.resolve() };

    function api(path, method = 'GET') {
        const run = async () => {
            const response = await fetch(path, {
                method,
                cache: 'no-store',
                headers: { Accept: 'application/json' }
            });
            if (!response.ok) {
                const error = new Error('HTTP ' + response.status);
                error.status = response.status;
                throw error;
            }
            return response.json();
        };
        const lane = method === 'GET' ? 'read' : 'write';
        const result = apiQueues[lane].then(run, run);
        apiQueues[lane] = result.catch(() => undefined);
        return result;
    }

    function createGame() {
        if (gameRequest) {
            return gameRequest;
        }
        gameRequest = api('/api/games', 'POST')
            .then((nextState) => {
                gameId = nextState.id;
                applyState(nextState);
                startStream();
                return nextState;
            })
            .catch(() => {
                showConnection('Server nicht erreichbar – läuft die Java-App?');
                return null;
            })
            .finally(() => {
                gameRequest = null;
            });
        return gameRequest;
    }

    function startPolling() {
        clearTimeout(pollTimer);
        const loop = async () => {
            if (!gameId) {
                await createGame();
            }
            if (gameId && performance.now() - lastPushAt > SSE_STALE_MS) {
                try {
                    const nextState = await api('/api/games/' + gameId);
                    hideConnection();
                    applyState(nextState);
                } catch (error) {
                    if (error.status === 404) {
                        stopStream();
                        gameId = null;
                        await createGame();
                    } else {
                        showConnection('Verbindung unterbrochen – versuche erneut …');
                    }
                }
            }
            pollTimer = setTimeout(loop, POLL_INTERVAL_MS);
        };
        loop();
    }

    function stopStream() {
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }
    }

    function startStream() {
        if (!gameId || typeof EventSource === 'undefined') {
            return;
        }
        stopStream();
        const source = new EventSource('/api/games/' + gameId + '/events');
        eventSource = source;
        source.onmessage = (event) => {
            if (source !== eventSource) {
                return;
            }
            try {
                const nextState = JSON.parse(event.data);
                lastPushAt = performance.now();
                hideConnection();
                applyState(nextState);
            } catch (error) {
                // Beschaedigtes Paket – der naechste Push bringt den Zustand nach.
            }
        };
    }

    function performAction(action) {
        if (!gameId) {
            return Promise.resolve();
        }
        return api('/api/games/' + gameId + '/' + action, 'POST')
            .then((nextState) => {
                hideConnection();
                applyState(nextState);
            })
            .catch((error) => {
                showConnection('Aktion fehlgeschlagen (' + (error.status || 'Netzwerk') + ')');
            });
    }

    // ------------------------------------------------------------------
    // Zustand
    // ------------------------------------------------------------------

    function applyState(nextState) {
        if (!nextState) {
            return;
        }
        const previous = state;
        // Antworten von Polling, Push und Aktionen koennen sich ueberholen.
        // Immer die neueste Version des Servers gewinnen lassen.
        if (previous && typeof nextState.version === 'number'
            && typeof previous.version === 'number'
            && nextState.version < previous.version) {
            return;
        }

        let snap = !previous;
        state = nextState;

        if (previous) {
            const jump = Math.abs(previous.snake[0][0] - nextState.snake[0][0])
                + Math.abs(previous.snake[0][1] - nextState.snake[0][1]);
            const restarted = previous.status === 'GAME_OVER' && nextState.status === 'RUNNING';
            if (jump > 1 || restarted) {
                snap = true;
            }
            if (nextState.score > previous.score) {
                playEat();
            }
            if (previous.status !== 'GAME_OVER' && nextState.status === 'GAME_OVER') {
                playDeath();
            } else if (previous.status !== 'RUNNING' && nextState.status === 'RUNNING') {
                playStart();
            }
        }

        syncRendered(snap);
        syncHud();
        syncOverlay();
    }

    function syncRendered(snap) {
        if (!state || !Array.isArray(state.snake) || state.snake.length === 0) {
            return;
        }
        if (snap || rendered.length === 0) {
            rendered = state.snake.map(([x, y]) => ({ x, y }));
            return;
        }
        const targetLength = state.snake.length;
        if (targetLength > rendered.length) {
            const head = rendered[0] || { x: state.snake[0][0], y: state.snake[0][1] };
            for (let i = rendered.length; i < targetLength; i++) {
                rendered.unshift({ x: head.x, y: head.y });
            }
        } else if (targetLength < rendered.length) {
            rendered.length = targetLength;
        }
    }

    function syncHud() {
        if (!state) {
            return;
        }
        scoreEl.textContent = state.score;
        bestEl.textContent = Math.max(state.highScore, state.score);
        levelEl.textContent = state.level;
        pauseButton.disabled = state.status !== 'RUNNING' && state.status !== 'PAUSED';
        pauseButton.textContent = state.status === 'PAUSED' ? 'Weiter' : 'Pause';
    }

    function syncOverlay() {
        if (!state) {
            return;
        }
        let key;
        let title;
        let text;
        let label;

        switch (state.status) {
            case 'READY':
                key = 'ready';
                title = 'Snake';
                text = 'Sammle Äpfel, weiche dir selbst aus – und werd immer schneller.';
                label = 'Spiel starten';
                break;
            case 'PAUSED':
                key = 'paused';
                title = 'Pausiert';
                text = 'Das Spiel steht. Drück weiter, wenn du bereit bist.';
                label = 'Weiter';
                break;
            case 'GAME_OVER': {
                const record = state.score > 0 && state.score >= state.highScore;
                key = 'over-' + state.status + '-' + state.score + '-' + record;
                title = state.won ? 'Perfekt!' : 'Game Over';
                text = state.won
                    ? 'Das Feld ist voll – beeindruckend!\n' + state.score + ' Äpfel.'
                    : state.score + (state.score === 1 ? ' Apfel' : ' Äpfel') + ' gesammelt.\n'
                        + (record ? 'Neuer Rekord!' : 'Rekord: ' + state.highScore);
                label = 'Nochmal spielen';
                break;
            }
            default:
                key = 'running';
                title = 'Snake';
                text = '';
                label = 'Weiter';
                break;
        }

        if (key === overlayKey) {
            return;
        }
        overlayKey = key;
        overlayTitle.textContent = title;
        overlayText.textContent = text;
        primaryButton.textContent = label;
        overlay.classList.toggle('is-hidden', state.status === 'RUNNING');
    }

    // ------------------------------------------------------------------
    // Aktionen
    // ------------------------------------------------------------------

    function primaryAction() {
        if (!state) {
            return;
        }
        ensureAudio();
        if (state.status === 'READY') {
            performAction('start');
        } else if (state.status === 'PAUSED' || state.status === 'RUNNING') {
            performAction('pause');
        } else {
            restart();
        }
    }

    function restart() {
        ensureAudio();
        performAction('restart');
    }

    function sendDirection(direction) {
        if (!state || !gameId) {
            return;
        }
        ensureAudio();
        if (state.status === 'READY') {
            performAction('start');
        } else if (state.status === 'PAUSED') {
            performAction('pause');
        } else if (state.status === 'GAME_OVER') {
            return;
        }
        api('/api/games/' + gameId + '/direction?dir=' + encodeURIComponent(direction), 'POST')
            .then((nextState) => {
                hideConnection();
                applyState(nextState);
            })
            .catch(() => {
                // Nächster Push holt den Zustand nach.
            });
    }

    // ------------------------------------------------------------------
    // Eingabe
    // ------------------------------------------------------------------

    window.addEventListener('keydown', (event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) {
            return;
        }
        const direction = KEY_DIRECTIONS[event.key.toLowerCase()];
        if (direction) {
            event.preventDefault();
            sendDirection(direction);
            return;
        }
        if (event.code === 'Space') {
            event.preventDefault();
            if (!event.repeat) {
                primaryAction();
            }
            return;
        }
        if (event.code === 'KeyR') {
            event.preventDefault();
            if (!event.repeat) {
                restart();
            }
            return;
        }
        if (event.code === 'KeyP') {
            event.preventDefault();
            if (!event.repeat) {
                performAction('pause');
            }
            return;
        }
        if (event.code === 'Enter') {
            if (state && state.status !== 'RUNNING' && !event.repeat) {
                primaryButton.click();
            }
        }
    });

    primaryButton.addEventListener('click', primaryAction);
    pauseButton.addEventListener('click', () => {
        ensureAudio();
        performAction('pause');
    });

    dpad.addEventListener('click', (event) => {
        const button = event.target.closest('[data-dir]');
        if (button) {
            sendDirection(button.dataset.dir);
        }
    });

    let swipeStart = null;
    canvas.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse') {
            return;
        }
        swipeStart = { x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener('pointerup', (event) => {
        if (!swipeStart) {
            return;
        }
        const dx = event.clientX - swipeStart.x;
        const dy = event.clientY - swipeStart.y;
        swipeStart = null;
        if (Math.hypot(dx, dy) < 24) {
            return;
        }
        if (Math.abs(dx) > Math.abs(dy)) {
            sendDirection(dx > 0 ? 'RIGHT' : 'LEFT');
        } else {
            sendDirection(dy > 0 ? 'DOWN' : 'UP');
        }
    });
    canvas.addEventListener('pointercancel', () => {
        swipeStart = null;
    });

    // ------------------------------------------------------------------
    // Sound
    // ------------------------------------------------------------------

    function updateSoundButton() {
        soundButton.textContent = muted ? '🔇' : '🔊';
        const label = muted ? 'Ton einschalten' : 'Ton ausschalten';
        soundButton.setAttribute('aria-label', label);
        soundButton.title = label;
    }

    soundButton.addEventListener('click', () => {
        muted = !muted;
        localStorage.setItem('snake.muted', muted ? '1' : '0');
        updateSoundButton();
        if (!muted) {
            ensureAudio();
            tone(620, 0.07, 'sine', 0.05);
        }
    });

    function ensureAudio() {
        if (!audioContext) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass) {
                audioContext = new AudioContextClass();
            }
        }
        if (audioContext && audioContext.state === 'suspended') {
            audioContext.resume().catch(() => undefined);
        }
    }

    function tone(frequency, duration, type = 'sine', volume = 0.05, delay = 0) {
        if (muted || !audioContext) {
            return;
        }
        const start = audioContext.currentTime + delay;
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.type = type;
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start(start);
        oscillator.stop(start + duration + 0.03);
    }

    function playEat() {
        tone(700, 0.07, 'triangle', 0.05);
        tone(1040, 0.09, 'triangle', 0.045, 0.06);
    }

    function playDeath() {
        tone(220, 0.28, 'sawtooth', 0.045);
        tone(110, 0.5, 'sawtooth', 0.04, 0.14);
    }

    function playStart() {
        tone(460, 0.07, 'sine', 0.04);
        tone(690, 0.1, 'sine', 0.04, 0.08);
    }

    // ------------------------------------------------------------------
    // Verbindungshinweis
    // ------------------------------------------------------------------

    let connectionTimer = null;

    function showConnection(message) {
        connectionEl.textContent = message;
        connectionEl.classList.add('is-visible');
        clearTimeout(connectionTimer);
        connectionTimer = setTimeout(hideConnection, 5000);
    }

    function hideConnection() {
        connectionEl.classList.remove('is-visible');
    }

    // ------------------------------------------------------------------
    // Rendering
    // Alles Statische (Hintergrund, Gitter, Apfel, Glow, Farben) wird einmal
    // pro Groesse gecacht. Pro Frame bleiben nur noch drawImage + einfache
    // Pfade – das war vorher der Hauptgrund fuer Ruckler im Canvas.
    // ------------------------------------------------------------------

    let dpr = 1;
    const background = document.createElement('canvas');
    const backgroundCtx = background.getContext('2d');
    let backgroundKey = '';
    let foodSprite = null;
    let foodKey = '';
    let headGlow = null;
    let headGlowKey = '';
    let palette = [];
    let paletteKey = '';

    function resizeCanvas() {
        const rect = canvas.getBoundingClientRect();
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(rect.width * dpr));
        const height = Math.max(1, Math.round(rect.height * dpr));
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
            backgroundKey = '';
        }
    }

    if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(resizeCanvas).observe(canvas);
    }
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    function mix(from, to, t) {
        return 'rgb('
            + Math.round(from[0] + (to[0] - from[0]) * t) + ','
            + Math.round(from[1] + (to[1] - from[1]) * t) + ','
            + Math.round(from[2] + (to[2] - from[2]) * t) + ')';
    }

    function ensureBackground(width, height, columns, rows, cell, offsetX, offsetY) {
        const key = [width, height, columns, rows, cell.toFixed(2), offsetX.toFixed(2), offsetY.toFixed(2)].join(':');
        if (key === backgroundKey) {
            return;
        }
        backgroundKey = key;
        background.width = width;
        background.height = height;

        backgroundCtx.fillStyle = '#060c10';
        backgroundCtx.fillRect(0, 0, width, height);

        const glow = backgroundCtx.createRadialGradient(
            offsetX + cell * columns * 0.5,
            offsetY + cell * rows * 0.45,
            0,
            offsetX + cell * columns * 0.5,
            offsetY + cell * rows * 0.45,
            cell * columns * 0.75
        );
        glow.addColorStop(0, 'rgba(23, 224, 139, 0.075)');
        glow.addColorStop(1, 'rgba(6, 12, 16, 0)');
        backgroundCtx.fillStyle = glow;
        backgroundCtx.fillRect(0, 0, width, height);

        backgroundCtx.strokeStyle = 'rgba(140, 255, 205, 0.055)';
        backgroundCtx.lineWidth = Math.max(1, dpr * 0.6);
        backgroundCtx.beginPath();
        for (let x = 0; x <= columns; x++) {
            const px = Math.round(offsetX + x * cell) + 0.5;
            backgroundCtx.moveTo(px, offsetY);
            backgroundCtx.lineTo(px, offsetY + rows * cell);
        }
        for (let y = 0; y <= rows; y++) {
            const py = Math.round(offsetY + y * cell) + 0.5;
            backgroundCtx.moveTo(offsetX, py);
            backgroundCtx.lineTo(offsetX + columns * cell, py);
        }
        backgroundCtx.stroke();
    }

    function ensureFoodSprite(cell) {
        const key = cell.toFixed(2);
        if (key === foodKey && foodSprite) {
            return;
        }
        foodKey = key;
        const size = Math.max(8, Math.ceil(cell * 3.2));
        const sprite = document.createElement('canvas');
        sprite.width = size;
        sprite.height = size;
        const fctx = sprite.getContext('2d');
        const center = size / 2;
        const radius = cell * 0.29;

        const halo = fctx.createRadialGradient(
            center, center, radius * 0.35,
            center, center, radius * 1.9
        );
        halo.addColorStop(0, 'rgba(255, 80, 100, 0.55)');
        halo.addColorStop(1, 'rgba(255, 80, 100, 0)');
        fctx.fillStyle = halo;
        fctx.fillRect(0, 0, size, size);

        const gradient = fctx.createRadialGradient(
            center - radius * 0.35,
            center - radius * 0.4,
            radius * 0.12,
            center,
            center,
            radius
        );
        gradient.addColorStop(0, '#ffc2c7');
        gradient.addColorStop(0.45, '#ff6170');
        gradient.addColorStop(1, '#c81f3c');
        fctx.fillStyle = gradient;
        fctx.beginPath();
        fctx.arc(center, center, radius, 0, Math.PI * 2);
        fctx.fill();

        fctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
        fctx.beginPath();
        fctx.arc(center - radius * 0.32, center - radius * 0.38, radius * 0.2, 0, Math.PI * 2);
        fctx.fill();

        fctx.save();
        fctx.translate(center + radius * 0.35, center - radius * 0.95);
        fctx.rotate(-0.7);
        fctx.fillStyle = '#58ffa6';
        fctx.beginPath();
        fctx.ellipse(0, 0, radius * 0.55, radius * 0.24, 0, 0, Math.PI * 2);
        fctx.fill();
        fctx.restore();

        foodSprite = sprite;
    }

    function ensureHeadGlow(cell) {
        const key = cell.toFixed(2);
        if (key === headGlowKey && headGlow) {
            return;
        }
        headGlowKey = key;
        const size = Math.max(8, Math.ceil(cell * 3));
        const sprite = document.createElement('canvas');
        sprite.width = size;
        sprite.height = size;
        const gctx = sprite.getContext('2d');
        const center = size / 2;
        const gradient = gctx.createRadialGradient(center, center, 0, center, center, center);
        gradient.addColorStop(0, 'rgba(93, 255, 168, 0.42)');
        gradient.addColorStop(1, 'rgba(93, 255, 168, 0)');
        gctx.fillStyle = gradient;
        gctx.fillRect(0, 0, size, size);
        headGlow = sprite;
    }

    function ensurePalette(length, dead) {
        const key = length + ':' + (dead ? 'd' : 'a');
        if (key === paletteKey) {
            return;
        }
        paletteKey = key;
        const headColor = dead ? [255, 118, 130] : [126, 255, 191];
        const tailColor = dead ? [128, 32, 48] : [20, 128, 90];
        palette = new Array(length);
        for (let i = 0; i < length; i++) {
            palette[i] = mix(headColor, tailColor, length > 1 ? i / (length - 1) : 0);
        }
    }

    function draw(now, dt) {
        const width = canvas.width;
        const height = canvas.height;
        const columns = state ? state.width : 23;
        const rows = state ? state.height : 23;
        const cell = Math.min(width / columns, height / rows);
        const offsetX = (width - cell * columns) / 2;
        const offsetY = (height - cell * rows) / 2;

        ensureBackground(width, height, columns, rows, cell, offsetX, offsetY);
        ctx.drawImage(background, 0, 0);

        if (!state) {
            return;
        }

        if (state.food) {
            ensureFoodSprite(cell);
            const [fx, fy] = state.food;
            const cx = offsetX + (fx + 0.5) * cell;
            const cy = offsetY + (fy + 0.5) * cell;
            const pulse = 0.5 + 0.5 * Math.sin(now / 300);
            const size = foodSprite.width * (1 + pulse * 0.06);
            ctx.drawImage(foodSprite, cx - size / 2, cy - size / 2, size, size);
        }

        // Zeitkonstante an die Schrittgeschwindigkeit koppeln: bei hohem Level
        // muss die Interpolation schneller sein, sonst hinkt der Kopf ständig
        // hinter dem echten Spielzustand her.
        const stepSeconds = Math.max(0.04, Math.min(0.3, (state.stepMs || 145) / 1000));
        const ease = 1 - Math.exp(-Math.min(dt, 0.08) * (5 / stepSeconds));
        for (let i = 0; i < rendered.length; i++) {
            const target = state.snake[i];
            if (!target) {
                continue;
            }
            rendered[i].x += (target[0] - rendered[i].x) * ease;
            rendered[i].y += (target[1] - rendered[i].y) * ease;
        }

        drawSnake(cell, offsetX, offsetY, now);

        if (state.status === 'GAME_OVER') {
            const fade = 0.10 + 0.05 * Math.sin(now / 200);
            ctx.fillStyle = 'rgba(255, 70, 90, ' + fade.toFixed(3) + ')';
            ctx.fillRect(0, 0, width, height);
        }
    }

    function drawSnake(cell, offsetX, offsetY, now) {
        const dead = state.status === 'GAME_OVER';
        const inset = cell * 0.075;
        const size = cell - inset * 2;
        const radius = Math.min(cell * 0.3, size * 0.36);
        const pulse = 0.5 + 0.5 * Math.sin(now / 420);

        if (rendered.length === 0) {
            return;
        }

        ensurePalette(rendered.length, dead);

        const head = rendered[0];
        const headX = offsetX + (head.x + 0.5) * cell;
        const headY = offsetY + (head.y + 0.5) * cell;

        if (!dead) {
            ensureHeadGlow(cell);
            const glowSize = headGlow.width * (1 + pulse * 0.08);
            ctx.drawImage(headGlow, headX - glowSize / 2, headY - glowSize / 2, glowSize, glowSize);
        }

        for (let i = rendered.length - 1; i >= 0; i--) {
            const segment = rendered[i];
            const x = offsetX + segment.x * cell + inset;
            const y = offsetY + segment.y * cell + inset;
            ctx.fillStyle = palette[i];
            ctx.beginPath();
            ctx.roundRect(x, y, size, size, radius);
            ctx.fill();
        }

        const direction = DIRECTIONS[state.direction] || DIRECTIONS.RIGHT;
        const perpendicular = { x: -direction.y, y: direction.x };
        const forward = cell * 0.16;
        const side = cell * 0.19;
        const eyeRadius = Math.max(1.2 * dpr, cell * 0.078);

        ctx.fillStyle = dead ? 'rgba(60, 6, 14, 0.9)' : 'rgba(3, 20, 13, 0.92)';
        for (const sign of [-1, 1]) {
            const eyeX = headX + direction.x * forward + perpendicular.x * side * sign;
            const eyeY = headY + direction.y * forward + perpendicular.y * side * sign;
            ctx.beginPath();
            ctx.arc(eyeX, eyeY, eyeRadius, 0, Math.PI * 2);
            ctx.fill();
        }

        if (!dead) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
            const sparkleX = headX + direction.x * forward + perpendicular.x * side;
            const sparkleY = headY + direction.y * forward + perpendicular.y * side;
            ctx.beginPath();
            ctx.arc(sparkleX - eyeRadius * 0.25, sparkleY - eyeRadius * 0.3, eyeRadius * 0.3, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.strokeStyle = dead
            ? 'rgba(255, 100, 115, ' + (0.10 + pulse * 0.06) + ')'
            : 'rgba(150, 255, 205, ' + (0.12 + pulse * 0.08) + ')';
        ctx.lineWidth = Math.max(1, cell * 0.035);
        ctx.beginPath();
        ctx.arc(headX, headY, cell * (0.44 + pulse * 0.04), 0, Math.PI * 2);
        ctx.stroke();
    }

    function frame(now) {
        const dt = Math.min(0.06, (now - lastFrame) / 1000);
        lastFrame = now;
        draw(now, dt);
        requestAnimationFrame(frame);
    }

    updateSoundButton();
    requestAnimationFrame(frame);
    startPolling();
})();
