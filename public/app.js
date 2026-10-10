/* ===== سكربلو | منطق العميل ===== */
(() => {
  'use strict';

  /* ---------------- حالة محلية ---------------- */
  const $ = (id) => document.getElementById(id);
  // الاتصال بسيرفر اللعبة: نفس النطاق، أو سيرفر خارجي من config.js
  const SERVER_URL = (window.SKRIBLO_SERVER || '').trim();
  const socket = SERVER_URL ? io(SERVER_URL, { transports: ['websocket', 'polling'] }) : io();
  const AVATARS = ['🐱','🐶','🦊','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🦄','🐙','🦖','🐳','🦉','🌟','🔥','⚡','🍕'];
  const COLORS = ['#000000','#7f8c8d','#c0392b','#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c','#3498db','#2980b9','#9b59b6','#fd79a8','#6d4c41','#ffffff'];

  let me = null;             // {id, name, avatar, score...}
  let room = null;           // آخر حالة غرفة من السيرفر
  let myWord = null;         // كلمة الرسام (تظهر له كاملة)
  let myId = sessionStorage.getItem('skriblo.playerId') || null;

  // لوحة الرسم: نقاط بالإحداثيات النسبية (0..1) حتى تتزامن بين كل الشاشات
  const canvas = $('board');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const BW = canvas.width, BH = canvas.height;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  let tool = 'pen';
  let color = '#000000';
  let size = 10;
  let drawing = false;
  let currentStroke = null;

  /* ---------------- أدوات واجهة ---------------- */
  function showToast(text, ms = 2200) {
    const t = $('toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add('hidden'), ms);
  }

  /* --------------- حالة الاتصال بالسيرفر --------------- */
  const NO_SERVER_MSG = '⚠️ لا يوجد سيرفر متصل!\n\n' +
    '• إذا كنت تلعب محلياً: شغّل السيرفر بملف «ابدأ.bat» ثم افتح http://localhost:3000\n' +
    '• إذا فتحت الموقع المنشور: انشر السيرفر على Render وضع رابطه في public/config.js';

  function ensureServer() {
    if (socket.connected) return true;
    $('loginError').textContent = NO_SERVER_MSG.replace(/\n\n/g, '\n');
    $('serverBanner').classList.remove('hidden');
    $('serverBanner').textContent = '🔴 غير متصل بسيرفر اللعبة — لن تتمكن من إنشاء غرفة أو الانضمام';
    return false;
  }

  socket.on('connect_error', () => {
    $('serverBanner').classList.remove('hidden');
    $('serverBanner').textContent = '🔴 فشل الاتصال بسيرفر اللعبة';
  });
  socket.on('connect', () => $('serverBanner').classList.add('hidden'));
  socket.on('connect_failed', () => $('serverBanner').classList.remove('hidden'));

  // نقاط تطفو في وسط الشاشة عند التخمين الصحيح
  function showFloatPoints(text) {
    const el = document.createElement('div');
    el.className = 'float-points';
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1400);
  }

  function screen(name) {
    $('screen-login').classList.toggle('active', name === 'login');
    $('screen-game').classList.toggle('active', name === 'game');
  }

  /* ---------------- شاشة الدخول ---------------- */
  function buildAvatarPicker() {
    const wrap = $('avatarPicker');
    wrap.innerHTML = '';
    AVATARS.forEach((a, i) => {
      const b = document.createElement('button');
      b.textContent = a;
      b.className = i === 0 ? 'selected' : '';
      b.dataset.avatar = a;
      b.addEventListener('click', () => {
        wrap.querySelectorAll('button').forEach((x) => x.classList.remove('selected'));
        b.classList.add('selected');
      });
      wrap.appendChild(b);
    });
  }

  function chosenAvatar() {
    const sel = $('avatarPicker').querySelector('button.selected');
    return sel ? sel.dataset.avatar : AVATARS[0];
  }

  $('btnCreate').addEventListener('click', () => {
    const name = $('nameInput').value.trim();
    if (!name) return $('loginError').textContent = 'اكتب اسمك أولاً 🙂';
    localStorage.setItem('skriblo.name', name);
    if (!ensureServer()) return;
    $('loginError').textContent = '';
    socket.emit('room:create', { name, avatar: chosenAvatar() }, (res) => {
      if (!res.ok) return $('loginError').textContent = res.error;
      onJoined(res);
    });
  });

  $('btnJoin').addEventListener('click', () => {
    const name = $('nameInput').value.trim();
    const roomId = $('roomCodeInput').value.trim().toUpperCase();
    if (!name) return $('loginError').textContent = 'اكتب اسمك أولاً 🙂';
    if (roomId.length !== 4) return $('loginError').textContent = 'رمز الغرفة يجب أن يكون 4 أحرف.';
    localStorage.setItem('skriblo.name', name);
    if (!ensureServer()) return;
    $('loginError').textContent = '';
    socket.emit('room:join', { roomId, name, avatar: chosenAvatar(), playerId: myId }, (res) => {
      if (!res.ok) return $('loginError').textContent = res.error;
      onJoined(res);
    });
  });

  $('roomCodeInput').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  $('btnLeave').addEventListener('click', () => {
    socket.emit('room:leave');
  });

  function onJoined(res) {
    me = res.you;
    sessionStorage.setItem('skriblo.playerId', me.id);
    localStorage.setItem('skriblo.avatar', me.avatar);
    room = res.room;
    screen('game');
    renderRoom();
    renderChatLog(res.chatLog || []);
    $('roomCodeDisplay').textContent = room.id;
    const link = `${location.origin}/?room=${room.id}`;
    history.replaceState(null, '', link);
  }

  // انضمام تلقائي من رابط ?room=CODE
  window.addEventListener('DOMContentLoaded', () => {
    buildAvatarPicker();
    const params = new URLSearchParams(location.search);
    const r = params.get('room');
    if (r) $('roomCodeInput').value = r.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    const savedName = localStorage.getItem('skriblo.name');
    if (savedName) $('nameInput').value = savedName;
    const savedAvatar = localStorage.getItem('skriblo.avatar');
    if (savedAvatar) {
      const btn = [...$('avatarPicker').querySelectorAll('button')].find((b) => b.dataset.avatar === savedAvatar);
      if (btn) { $('avatarPicker').querySelectorAll('button').forEach((x) => x.classList.remove('selected')); btn.classList.add('selected'); }
    }
  });

  $('nameInput').addEventListener('change', (e) => localStorage.setItem('skriblo.name', e.target.value.trim()));

  $('btnCopyLink').addEventListener('click', async () => {
    const link = `${location.origin}/?room=${room?.id || ''}`;
    try {
      await navigator.clipboard.writeText(link);
      showToast('✅ تم نسخ رابط الدعوة!');
    } catch {
      prompt('انسخ الرابط:', link);
    }
  });

  /* ---------------- رسم الغرفة ---------------- */
  socket.on('room:update', (r) => {
    room = r;
    renderRoom();
  });

  function renderRoom() {
    if (!room) return;
    const players = room.players || [];
    const list = $('playersList');
    list.innerHTML = '';
    players
      .slice()
      .sort((a, b) => b.score - a.score)
      .forEach((p) => {
        const li = document.createElement('li');
        li.className = 'player-row' + (p.isDrawer ? ' drawing' : '') + (p.guessed ? ' guessed' : '') + (p.connected ? '' : ' offline');
        li.innerHTML = `
          <span class="player-avatar">${escapeHtml(p.avatar)}</span>
          <span class="player-name">${escapeHtml(p.name)}${p.id === me?.id ? ' (أنت)' : ''}</span>
          ${p.isDrawer ? '<span class="player-badge" title="يرسم الآن">✏️</span>' : ''}
          ${p.guessed ? '<span class="player-badge" title="خمّن الكلمة">✅</span>' : ''}
          ${!p.connected ? '<span class="player-badge" title="غير متصل">📴</span>' : ''}
          <span class="player-score">${p.score}</span>
          ${me && room.hostId === me.id && p.id !== me.id ? '<button class="kick-btn" title="طرد">✕</button>' : ''}`;
        const kick = li.querySelector('.kick-btn');
        if (kick) kick.addEventListener('click', () => socket.emit('room:kick', p.id));
        list.appendChild(li);
      });

    // حالة الجولة
    $('roundInfo').textContent = room.state === 'lobby'
      ? `${players.length} لاعب في الغرفة`
      : (room.state === 'end'
        ? '🏁 انتهت اللعبة'
        : `الجولة ${Math.min(room.round, room.totalRounds)} من ${room.totalRounds}`);

    // كلمة العرض (تظهر فقط أثناء الرسم)
    const bar = $('wordBar');
    const imDrawer = room.drawerId === me?.id && room.state === 'draw';
    if (room.state === 'draw') {
      bar.classList.remove('hidden');
      // الرسام يرى كلمته كاملة (myWord) والبقية يرون الهنت
      bar.textContent = (imDrawer && myWord) ? myWord : (room.wordHint || '');
      bar.classList.toggle('drawer-view', imDrawer);
      bar.title = imDrawer ? 'أنت ترسم هذه الكلمة' : '';
    } else {
      bar.classList.add('hidden');
    }

    // المؤقت
    $('timerWrap').classList.toggle('hidden', !(room.state === 'draw'));
    if (room.state === 'draw') updateTimer(room.timeLeft, room.totalTime);

    // لوحة الإعدادات تظهر للمضيف في الغرفة فقط
    const isHost = room.hostId === me?.id;
    $('lobbyPanel').classList.toggle('hidden', !(isHost && room.state === 'lobby'));
    $('btnStart').classList.toggle('hidden', !(isHost && room.state === 'lobby'));
    $('btnStart').disabled = false;
    const connectedCount = players.filter((p) => p.connected).length;
    $('hostHint').classList.toggle('hidden', isHost && room.state === 'lobby');
    $('hostHint').textContent = room.state === 'end'
      ? 'انتهت اللعبة!'
      : (room.state === 'lobby' && connectedCount < 2
        ? 'يمكنك البدء وحدك للتجربة، أو شارك رمز الغرفة مع أصدقائك!'
        : 'بانتظار المضيف ليبدأ اللعبة…');

    // شريط الأدوات ظاهر للرسام فقط أثناء الرسم
    $('toolbar').classList.toggle('hidden', !(room.drawerId === me?.id && room.state === 'draw'));
    canvas.classList.toggle('locked', !(room.drawerId === me?.id && room.state === 'draw'));

    // الحالات الانتقالية
    if (room.state === 'choose') {
      showOverlay('choose', room.drawerId === me?.id ? 'اختر كلمة لرسمها' : `بانتظار ${playerName(room, room.drawerId)} يختار الكلمة…`);
    } else if (room.state === 'draw') {
      showOverlay(null);
    } else if (room.state === 'reveal') {
      // العرض يتم من حدث drawEnd (لا نلمس الطبقات)
    } else if (room.state === 'end') {
      // النتائج النهائية يديرها حدث game:over (لا نخفيها!)
    } else {
      // الغرفة/ lobby
      hideOverlays();
    }
  }

  function playerName(r, id) {
    const p = (r.players || []).find((x) => x.id === id);
    return p ? p.name : 'اللاعب';
  }

  function updateTimer(left, total) {
    $('timerText').textContent = Math.max(0, left || 0);
    const pct = total ? Math.max(0, (left / total) * 100) : 0;
    $('timerFill').style.width = pct + '%';
    $('timerFill').style.background = pct < 25 ? 'linear-gradient(90deg,#ff5b5b,#ff9f1c)' : 'linear-gradient(90deg,#2ecc71,#ffc93c)';
  }

  /* ---------------- الطبقات ---------------- */
  function showOverlay(which, text) {
    // لا نخفي طبقات النتائج (reveal/end) لأنها تُدار بأحداثها الخاصة
    $('revealOverlay').classList.add('hidden');
    $('endOverlay').classList.add('hidden');
    $('chooseOverlay').classList.add('hidden');
    $('waitOverlay').classList.add('hidden');
    if (which === 'choose') {
      $('waitOverlay').classList.remove('hidden');
      $('waitText').textContent = text;
    }
  }

  function hideOverlays() {
    $('waitOverlay').classList.add('hidden');
    $('revealOverlay').classList.add('hidden');
    $('endOverlay').classList.add('hidden');
    $('chooseOverlay').classList.add('hidden');
  }

  /* ---------------- أحداث اللعبة ---------------- */
  socket.on('room:error', (d) => showToast(d.message));
  socket.on('room:kicked', (d) => {
    showToast(d.message || 'تم طردك');
    setTimeout(() => location.reload(), 800);
  });
  socket.on('room:left', () => {
    sessionStorage.removeItem('skriblo.playerId');
    location.reload();
  });

  socket.on('game:turnStart', (d) => {
    myWord = null;
    clearBoard();
    $('guessStatus').classList.add('hidden');
    $('revealWord');
    $('revealScores').innerHTML = '';
    if (room) {
      room.state = 'choose';
      room.drawerId = d.drawerId;
      if (d.round) room.round = d.round;
      renderRoom();
    }
    showToast(d.drawerId === me?.id ? 'اختر كلمة لرسمها!' : 'دور جديد بدأ!');
  });

  socket.on('game:wordChoices', (d) => {
    clearBoard();
    $('guessStatus').classList.add('hidden');
    const box = $('wordChoices');
    box.innerHTML = '';
    hideOverlays();
    $('chooseOverlay').classList.remove('hidden');
    d.words.forEach((w) => {
      const b = document.createElement('button');
      b.textContent = w;
      b.addEventListener('click', () => {
        socket.emit('game:chooseWord', { index: d.words.indexOf(w) });
        $('chooseOverlay').classList.add('hidden');
      });
      box.appendChild(b);
    });
    playSound('choose');
  });

  socket.on('game:drawStart', (d) => {
    clearBoard();
    $('guessStatus').classList.add('hidden');
    if (room) {
      room.drawerId = d.drawerId;
      room.state = 'draw';
      room.wordHint = d.wordHint || room.wordHint;
      room.totalTime = room.settings?.drawTime || 80;
      room.timeLeft = Math.max(0, Math.round(((d.endsAt || 0) - Date.now()) / 1000)) || room.totalTime;
      renderRoom();
    }
    hideOverlays();
    if (d.youAreDrawer) {
      // الرسام يرى الكلمة كاملة في شريط الكلمة (تُثبّت في myWord حتى لا يمسحها تحديث الغرفة)
      myWord = d.word;
      renderRoom();
      showToast('🎨 أنت ترسم: ' + d.word);
      playSound('start');
    }
  });

  socket.on('game:time', (d) => {
    if (room) room.timeLeft = d.timeLeft;
    updateTimer(d.timeLeft, room?.totalTime);
  });

  socket.on('game:hint', (d) => {
    if (!room) return;
    // الرسام يرى الكلمة كاملة فلا نستبدلها بالهنت
    if (room.drawerId === me?.id) return;
    room.wordHint = d.wordHint;
    renderRoom();
  });

  socket.on('game:correct', (d) => {
    if (d.playerId === me?.id) {
      $('guessStatus').classList.remove('hidden');
      showFloatPoints(`+${d.points}`);
      playSound('correct');
    }
    // ملاحظة: رسالة الدردشة تأتي من السيرفر (system) فلا نكررها هنا
  });

  socket.on('game:close', (d) => {
    showToast(d.text);
    playSound('close');
  });

  socket.on('game:drawEnd', (d) => {
    myWord = null;
    if (room) room.state = 'reveal';
    hideOverlays();
    $('revealWord').textContent = d.word;
    const box = $('revealScores');
    box.innerHTML = '';
    d.scores.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'rs-row';
      row.innerHTML = `<span>${escapeHtml(s.avatar)} ${escapeHtml(s.name)}</span>
        <span><span class="gain">${s.score}</span>${s.gain ? ` <small>+${s.gain}</small>` : ''}</span>`;
      box.appendChild(row);
    });
    $('revealOverlay').classList.remove('hidden');
    $('timerWrap').classList.add('hidden');
    $('toolbar').classList.add('hidden');
    playSound(d.reason === 'timeout' ? 'fail' : 'round');
  });

  socket.on('game:over', (d) => {
    if (room) room.state = 'end';
    hideOverlays();
    const ol = $('podium');
    ol.innerHTML = '';
    const medals = ['🥇','🥈','🥉'];
    d.podium.forEach((p) => {
      const li = document.createElement('li');
      if (p.rank === 1) li.className = 'first';
      li.innerHTML = `<span class="medal">${medals[p.rank - 1] || p.rank}</span>
        <span>${escapeHtml(p.avatar)} ${escapeHtml(p.name)}</span>
        <span class="p-score">${p.score} نقطة</span>`;
      ol.appendChild(li);
    });
    $('btnRematch').classList.toggle('hidden', !(room && room.hostId === me?.id));
    $('endOverlay').classList.remove('hidden');
    playSound('win');
  });

  socket.on('disconnect', () => showToast('⚠️ انقطع الاتصال… جارٍ إعادة المحاولة'));
  socket.on('connect', () => {
    if (me && room) socket.emit('room:join', { roomId: room.id, name: me.name, avatar: me.avatar, playerId: me.id }, (res) => {
      if (res.ok) onJoined(res);
      else showToast('انتهت الجلسة، أعد تحميل الصفحة');
    });
  });

  $('btnRematch').addEventListener('click', () => socket.emit('game:rematch'));
  $('btnBackLobby').addEventListener('click', () => socket.emit('room:leave'));

  /* ---------------- لوحة المضيف ---------------- */
  function syncSettings() {
    socket.emit('room:settings', {
      rounds: parseInt($('setRounds').value, 10) || 3,
      drawTime: parseInt($('setTime').value, 10) || 80,
      language: $('setLang').value,
      arabicStyle: $('setStyle').value,
      difficulty: $('setDifficulty').value,
      customOnly: $('setCustomOnly').checked,
      hints: parseInt($('setHints').value, 10) || 0,
    });
    socket.emit('room:customWords', $('setCustom').value);
  }
  ['setRounds','setTime','setLang','setStyle','setDifficulty','setCustomOnly','setHints'].forEach((id) =>
    $(id).addEventListener('change', syncSettings));
  // خيار نوع الكلمات العربية يظهر مع العربية فقط
  $('setLang').addEventListener('change', () => {
    $('styleLabel').classList.toggle('hidden', $('setLang').value !== 'ar');
  });
  $('setCustom').addEventListener('change', syncSettings);
  $('btnStart').addEventListener('click', () => socket.emit('game:start'));

  /* ---------------- الدردشة ---------------- */
  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chat:message', { text });
    input.value = '';
  });

  function renderChatLog(log) {
    $('chatLog').innerHTML = '';
    log.forEach(addChat);
  }

  function addChat(msg) {
    const log = $('chatLog');
    const div = document.createElement('div');
    div.className = 'chat-msg ' + (msg.type || '');
    if (msg.type === 'system') {
      div.textContent = msg.text;
    } else if (msg.type === 'correct') {
      div.textContent = msg.text;
    } else {
      div.innerHTML = `<span class="who"><span class="av">${escapeHtml(msg.avatar || '')}</span>${escapeHtml(msg.name || '')}:</span> ${escapeHtml(msg.text || '')}`;
    }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    while (log.children.length > 200) log.removeChild(log.firstChild);
  }
  socket.on('chat:message', addChat);

  /* ---------------- الرسم على اللوحة ---------------- */
  function canvasPos(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (BW / r.width),
      y: (e.clientY - r.top) * (BH / r.height),
    };
  }

  function isDrawer() {
    return room && room.drawerId === me?.id && room.state === 'draw';
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!isDrawer()) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    if (tool === 'fill') return floodFillAt(e);
    drawing = true;
    const p = canvasPos(e);
    currentStroke = {
      color: tool === 'eraser' ? '#ffffff' : color,
      width: tool === 'eraser' ? Math.max(size, 16) : size,
      // إحداثيات نسبية (0..1) لتعمل مع أي حجم شاشة
      points: [{ x: p.x / BW, y: p.y / BH }],
    };
    ctx.strokeStyle = currentStroke.color;
    ctx.lineWidth = currentStroke.width;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.01, p.y + 0.01);
    ctx.stroke();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drawing || !isDrawer()) return;
    const p = canvasPos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    currentStroke.points.push({ x: p.x / BW, y: p.y / BH });
  });

  function endStroke() {
    if (!drawing) return;
    drawing = false;
    if (currentStroke && currentStroke.points.length) {
      socket.emit('draw:stroke', currentStroke);
      currentStroke = null;
    }
  }
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', endStroke);

  // أدوات الرسم
  const palette = $('colorPalette');
  COLORS.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'color-btn';
    b.style.background = c;
    if (c === color) b.classList.add('selected');
    b.addEventListener('click', () => {
      color = c;
      tool = 'pen';
      $('btnEraser').classList.remove('active');
      palette.querySelectorAll('.color-btn').forEach((x) => x.classList.remove('selected'));
      b.classList.add('selected');
    });
    palette.appendChild(b);
  });

  document.querySelectorAll('.size-btn').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.size-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      size = parseInt(b.dataset.size, 10);
    });
  });

  $('btnEraser').addEventListener('click', () => {
    tool = tool === 'eraser' ? 'pen' : 'eraser';
    $('btnEraser').classList.toggle('active', tool === 'eraser');
  });

  $('btnFill').addEventListener('click', () => {
    tool = 'fill';
    showToast('🪣 اضغط على أي مكان في اللوحة لتعبئته باللون المختار');
  });

  $('btnUndo').addEventListener('click', () => socket.emit('draw:undo'));
  $('btnClear').addEventListener('click', () => {
    if (confirm('مسح اللوحة بالكامل؟')) socket.emit('draw:clear');
  });

  // تعبئة لونية (Flood fill)
  function floodFillAt(e) {
    const p = canvasPos(e);
    const x = Math.floor(p.x), y = Math.floor(p.y);
    const { width: w, height: h } = canvas;
    const img = ctx.getImageData(0, 0, w, h);
    const data = img.data;
    const target = getPixel(data, x, y, w, h);
    const fill = hexToRgb(color);
    if (colorMatch(target, fill)) return;

    const stack = [[x, y]];
    const tol = 24 << 24; // تسامح بسيط
    while (stack.length) {
      const [cx, cy] = stack.pop();
      if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
      const idx = (cy * w + cx) * 4;
      const pr = data[idx], pg = data[idx + 1], pb = data[idx + 2];
      if (
        Math.abs(pr - target[0]) > 24 || Math.abs(pg - target[1]) > 24 ||
        Math.abs(pb - target[2]) > 24
      ) continue;
      data[idx] = fill.r; data[idx + 1] = fill.g; data[idx + 2] = fill.b; data[idx + 3] = 255;
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
    ctx.putImageData(img, 0, 0);
    tool = 'pen';
    $('btnEraser').classList.remove('active');
    // مزامنة الصورة مع بقية اللاعبين
    socket.emit('draw:fill', canvas.toDataURL('image/jpeg', 0.75));
  }

  function getPixel(data, x, y, w, h) {
    const idx = (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4;
    return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
  }
  function colorMatch(a, b) { return a[0] === b.r && a[1] === b.g && a[2] === b.b; }
  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  // استقبال الرسم من الرسام
  socket.on('draw:stroke', (s) => {
    if (isDrawer()) return; // المصدر يرى رسمه الحقيقي
    if (!s || !Array.isArray(s.points) || !s.points.length) return;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.beginPath();
    ctx.moveTo(s.points[0].x * BW, s.points[0].y * BH);
    if (s.points.length === 1) {
      // نقطة واحدة: نرسم دائرة صغيرة
      ctx.lineTo(s.points[0].x * BW + 0.5, s.points[0].y * BH + 0.5);
    } else {
      for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x * BW, s.points[i].y * BH);
    }
    ctx.stroke();
  });

  socket.on('draw:snapshot', (image) => {
    if (isDrawer()) return;
    drawImageToCtx(image);
  });

  socket.on('draw:history', (strokes) => {
    clearBoard();
    (strokes || []).forEach((s) => {
      if (s.type === 'snapshot') drawImageToCtx(s.image);
      else if (Array.isArray(s.points) && s.points.length) {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.width;
        ctx.beginPath();
        ctx.moveTo(s.points[0].x * BW, s.points[0].y * BH);
        if (s.points.length === 1) {
          ctx.lineTo(s.points[0].x * BW + 0.5, s.points[0].y * BH + 0.5);
        } else {
          for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x * BW, s.points[i].y * BH);
        }
        ctx.stroke();
      }
    });
  });

  socket.on('draw:clear', clearBoard);

  const drawImageCache = {};
  function drawImageToCtx(dataUrl) {
    if (!dataUrl) return;
    const key = dataUrl.slice(-32);
    const render = () => {
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(drawImageCache[key], 0, 0, canvas.width, canvas.height);
    };
    if (drawImageCache[key]) return render();
    const img = new Image();
    img.onload = () => { drawImageCache[key] = img; render(); };
    img.src = dataUrl;
  }

  function clearBoard() {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  // اختصارات لوحة المفاتيح: Ctrl+Z تراجع
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && isDrawer()) {
      e.preventDefault();
      socket.emit('draw:undo');
    }
  });

  /* ---------------- أصوات خفيفة (WebAudio) ---------------- */
  let audioCtx = null;
  function playSound(kind) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.connect(g); g.connect(audioCtx.destination);
      const now = audioCtx.currentTime;
      const tones = {
        choose: [520, 0.08], correct: [660, 0.12], close: [440, 0.08],
        start: [720, 0.1], round: [560, 0.1], fail: [220, 0.2], win: [880, 0.25],
      };
      const [freq, dur] = tones[kind] || [500, 0.08];
      o.frequency.value = freq;
      o.type = kind === 'fail' ? 'sawtooth' : 'sine';
      g.gain.setValueAtTime(0.08, now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      o.start(now); o.stop(now + dur);
    } catch { /* الصوت غير مدعوم */ }
  }

  /* ---------------- أدوات صغيرة ---------------- */
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  clearBoard();
})();