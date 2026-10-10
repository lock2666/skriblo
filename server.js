/*
 * سكربلو (Skriblo) - لعبة جماعية للرسم والتخمين
 * سيرفر اللعبة: غرف + Socket.IO + نظام نقاط وتخمين ودردشة
 */
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const WORDS = require('./words');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7, // 10MB (صور التعبئة)
  // اسمح للواجهة المنشورة على GitHub Pages (أو أي نطاق) بالاتصال
  cors: {
    origin: true,
    methods: ['GET', 'POST'],
    credentials: false,
  },
});

app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/* ثوابت                                                              */
/* ------------------------------------------------------------------ */
const AVATARS = ['🐱','🐶','🦊','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🦄','🐙','🦖','🐳','🦉','🌟','🔥','⚡','🍕'];
const CHOOSE_TIME = 12;          // ثانية لاختيار الكلمة
const REVEAL_DELAY = 4;          // ثانية بين الجولات
const GRACE_MS = 5 * 60 * 1000;  // مهلة إعادة الاتصال قبل حذف الغرفة
const MAX_PLAYERS = 12;
const MAX_MSG = 300;

/* ------------------------------------------------------------------ */
/* أدوات مساعدة                                                       */
/* ------------------------------------------------------------------ */
const rand = (a) => a[Math.floor(Math.random() * a.length)];
const code = () => Math.random().toString(36).slice(2, 6).toUpperCase();
// هوية لاعب ثابتة (لا تتغير عند إعادة الاتصال) منفصلة عن هوية السوكِت
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));

// تطبيع النص العربي لمقارنة التخمينات (إزالة التشكيل وتوحيد الألف والتاء المربوطة...)
function normalize(str) {
  return String(str || '')
    .replace(/[\u064B-\u0652\u0640]/g, '')   // تشكيل + تطويل
    .replace(/[إأآٱ]/g, 'ا')                  // أ إ آ ٱ -> ا
    .replace(/[ىئ]/g, 'ي')                    // ى ئ -> ي
    .replace(/ة/g, 'ه')                       // ة -> ه
    .replace(/[ؤ]/g, 'و')                     // ؤ -> و
    .replace(/['’`´"]/g, '')                  // زخرفة
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// مسافة ليفنشتاين: لمعرفة إن كان التخمين قريباً من الكلمة
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/* ------------------------------------------------------------------ */
/* حالة الغرف                                                         */
/* ------------------------------------------------------------------ */
/** @type {Map<string, any>} */
const rooms = new Map();

function publicRoom(room) {
  return {
    id: room.id,
    hostId: room.hostId,
    state: room.state,
    round: room.round,
    totalRounds: room.settings.rounds,
    settings: room.settings,
    customWords: room.customWords,
    drawerId: room.drawerId,
    players: room.players.map((p) => ({
      id: p.id, name: p.name, avatar: p.avatar, score: p.score,
      connected: p.connected, guessed: p.guessed, isDrawer: p.id === room.drawerId,
    })),
    wordHint: room.wordHint,
    timeLeft: room.timeLeft,
    totalTime: room.settings.drawTime,
  };
}

function emitRoom(room, event, payload) {
  io.to(room.id).emit(event, payload);
}

function chat(room, msg) {
  room.chatLog.push(msg);
  if (room.chatLog.length > 100) room.chatLog.shift();
  emitRoom(room, 'chat:message', msg);
}

function systemChat(room, text) {
  chat(room, { id: Math.random().toString(36).slice(2), type: 'system', text, ts: Date.now() });
}

function connectedPlayers(room) {
  return room.players.filter((p) => p.connected);
}

function nextDrawerIndex(room) {
  const n = room.order.length;
  if (!n) return -1;
  for (let step = 1; step <= n; step++) {
    const idx = (room.turnIndex + step) % n;
    const p = room.players.find((q) => q.id === room.order[idx] && q.connected);
    if (p) return idx;
  }
  return -1;
}
/* ------------------------------------------------------------------ */
/* دورة اللعبة                                                        */
/* ------------------------------------------------------------------ */
function pickWord(room) {
  const s = room.settings;
  const dict = WORDS[s.language] || WORDS.ar;
  let levels;

  if (s.language === 'en') {
    levels = [dict.easy, dict.medium, dict.hard];
  } else {
    // العربية: فصحى أو عامية أو الاثنان
    const style = ['fusha', 'dialect', 'mix'].includes(s.arabicStyle) ? s.arabicStyle : 'dialect';
    if (style === 'fusha') {
      levels = [dict.fusha.easy, dict.fusha.medium, dict.fusha.hard];
    } else if (style === 'dialect') {
      levels = [dict.dialect.easy, dict.dialect.medium, dict.dialect.hard];
    } else {
      levels = [
        [...dict.fusha.easy, ...dict.dialect.easy],
        [...dict.fusha.medium, ...dict.dialect.medium],
        [...dict.fusha.hard, ...dict.dialect.hard],
      ];
    }
  }

  const idx = { easy: 0, medium: 1, hard: 2 }[s.difficulty];
  const pool = s.difficulty === 'mix' || idx === undefined
    ? levels.flat()
    : (levels[idx] || levels[0]);
  return rand(pool.length ? pool : levels[0]).toUpperCase();
}

function pickChoices(room) {
  const set = new Set();
  let guard = 0;
  while (set.size < 3 && guard++ < 50) set.add(pickWord(room));
  return [...set];
}

function startGame(room) {
  room.state = 'playing';
  room.round = 1;
  room.turnIndex = -1;
  room.order = room.players.map((p) => p.id).sort(() => Math.random() - 0.5);
  room.players.forEach((p) => { p.score = 0; p.guessed = false; });
  systemChat(room, '🎮 بدأت اللعبة! حظاً سعيداً للجميع');
  emitRoom(room, 'room:update', publicRoom(room));
  startTurn(room);
}

function startTurn(room) {
  // التأكد من وجود رسام متصل (وإلا ننهي اللعبة)
  let drawer = room.players.find((p) => p.id === room.order[room.turnIndex] && p.connected);
  if (!drawer) {
    room.turnIndex = nextDrawerIndex(room);
    if (room.turnIndex < 0) return endGame(room);
    drawer = room.players.find((p) => p.id === room.order[room.turnIndex]);
  }
  room.drawerId = drawer.id;
  room.guessed = new Set();
  room.strokes = [];
  room.revealedCount = 0;
  room.players.forEach((p) => { p.guessed = false; p.roundGain = 0; });
  room.state = 'choose';
  room.wordChoices = [];

  // إعلان الدور للجميع (قبل اختيار الكلمة أو البدء المباشر)
  emitRoom(room, 'game:turnStart', { drawerId: drawer.id, round: room.round });
  emitRoom(room, 'room:update', publicRoom(room));
  systemChat(room, `✏️ الدور على ${drawer.name} لرسم الكلمة`);

  // كلمات مخصصة حصرية: نتخطى مرحلة الاختيار ونبدأ الرسم مباشرة
  if (room.customWords.length > 0 && room.settings.customOnly) {
    return startDrawing(room, rand(room.customWords));
  }

  room.wordChoices = pickChoices(room);
  io.to(drawer.socketId).emit('game:wordChoices', { words: room.wordChoices });

  room.chooseTimer = setTimeout(() => {
    if (room.state === 'choose') startDrawing(room, rand(room.wordChoices));
  }, CHOOSE_TIME * 1000);
}

function startDrawing(room, word) {
  clearTimeout(room.chooseTimer);
  room.currentWord = word;
  room.state = 'draw';
  // عدد الهنتات: n hints => يكشف أول حرف ثم n-1 حروف إضافية على مدى الوقت
  room.revealTotal = clamp(room.settings.hints, 0, 8, 4);
  room.hintsUsed = 0;
  room.revealedCount = room.revealTotal > 0 ? 1 : 0;
  room.wordHint = maskWord(word, room.revealedCount);
  room.timeLeft = room.settings.drawTime;
  room.totalTime = room.settings.drawTime;

  const drawer = room.players.find((p) => p.id === room.drawerId);
  const payload = {
    drawerId: room.drawerId, wordHint: room.wordHint,
    endsAt: Date.now() + room.timeLeft * 1000, youAreDrawer: false,
  };
  if (drawer) {
    io.to(drawer.socketId).emit('game:drawStart', { ...payload, word, youAreDrawer: true });
    io.to(room.id).except(drawer.socketId).emit('game:drawStart', payload);
  } else {
    emitRoom(room, 'game:drawStart', payload);
  }
  systemChat(room, `⏱️ الوقت بدأ! ${room.settings.drawTime} ثانية`);

  room.timer = setInterval(() => {
    room.timeLeft--;
    if (room.timeLeft <= 0) return endTurn(room, 'timeout');
    emitRoom(room, 'game:time', { timeLeft: room.timeLeft });
    // كشف تدريجي للحروف حسب عدد الهنتات المختار
    const total = room.revealTotal || 0;
    if (total > 0 && room.hintsUsed < total - 1) {
      const threshold = 1 - (room.hintsUsed + 1) / total;
      if (room.timeLeft / room.totalTime <= threshold) {
        room.hintsUsed++;
        room.revealedCount = Math.max(1, room.hintsUsed + 1);
        const newHint = maskWord(room.currentWord, room.revealedCount);
        if (newHint !== room.wordHint) {
          room.wordHint = newHint;
          emitRoom(room, 'game:hint', { wordHint: newHint });
        }
      }
    }
  }, 1000);
  emitRoom(room, 'room:update', publicRoom(room));
}

function maskWord(word, revealed) {
  return [...word].map((c, i) => (c === ' ' ? ' ' : i < revealed ? c : '_')).join(' ');
}

function handleGuess(room, player, text) {
  const guess = normalize(text);
  const answer = normalize(room.currentWord);
  if (guess === answer) return true;

  // هل التخمين قريب؟ (فرق حرف أو حرفين للكلمات الطويلة)
  const maxDist = answer.length >= 8 ? 2 : 1;
  if (guess.length >= 3 && levenshtein(guess, answer) <= maxDist) {
    io.to(player.socketId).emit('game:close', { text: 'اقتربت كثيراً! 🔥' });
  }
  return false;
}

function registerCorrect(room, player) {
  if (!room.guessed) room.guessed = new Set();
  room.guessed.add(player.id);
  player.guessed = true;
  // النقاط بحسب الوقت المتبقي + مكافأة الأول
  const base = Math.max(15, Math.round((room.timeLeft / room.totalTime) * 100));
  const bonus = room.guessed.size === 1 ? 10 : 0;
  player.score += base + bonus;
  player.roundGain += base + bonus;
  emitRoom(room, 'game:correct', { playerId: player.id, name: player.name, points: base + bonus, position: room.guessed.size });
  systemChat(room, `${player.avatar} ${player.name} خمّن الكلمة! (+${base + bonus})`);

  const remaining = connectedPlayers(room).filter((p) => p.id !== room.drawerId && !p.guessed);
  if (remaining.length === 0) endTurn(room, 'all-guessed');
}

function endTurn(room, reason) {
  if (room.state === 'reveal' || room.state === 'end') return;
  clearInterval(room.timer);
  clearTimeout(room.chooseTimer);
  room.state = 'reveal';

  // نقاط الرسام: 25 لكل من خمّن
  if (reason !== 'no-guessers' && room.guessed) {
    const drawer = room.players.find((p) => p.id === room.drawerId);
    const pts = room.guessed.size * 25;
    if (drawer) { drawer.score += pts; drawer.roundGain += pts; }
  }

  emitRoom(room, 'game:drawEnd', {
    word: room.currentWord,
    reason,
    scores: room.players.map((p) => ({
      id: p.id, name: p.name, avatar: p.avatar, score: p.score, gain: p.roundGain || 0,
    })),
  });
  systemChat(room, `🏁 الكلمة كانت: ${room.currentWord}`);

  room.revealTimer = setTimeout(() => nextTurn(room), REVEAL_DELAY * 1000);
  emitRoom(room, 'room:update', publicRoom(room));
}

function nextTurn(room) {
  if (room.state === 'end') return;
  const before = room.turnIndex;
  room.turnIndex = nextDrawerIndex(room); // خطوة واحدة + تخطي غير المتصلين
  if (room.turnIndex < 0) return endGame(room);
  // إذا عدنا إلى الوراء (الالتفاف) ننتقل للجولة التالية
  if (room.turnIndex <= before) {
    room.round++;
    if (room.round > room.settings.rounds) return endGame(room);
  }
  startTurn(room);
}

function endGame(room) {
  clearInterval(room.timer);
  clearTimeout(room.chooseTimer);
  clearTimeout(room.revealTimer);
  room.state = 'end';
  const podium = [...room.players].sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, avatar: p.avatar, score: p.score }));
  emitRoom(room, 'game:over', { podium });
  systemChat(room, '🏆 انتهت اللعبة! شكراً لمشاركتكم');
  emitRoom(room, 'room:update', publicRoom(room));
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (connectedPlayers(room).length > 0) return;
  // فترة سماح 5 دقائق قبل حذف الغرفة (تسمح بإعادة الاتصال)
  const oldest = room.players.reduce((m, p) => Math.min(m, p.disconnectedAt || Infinity), Infinity);
  if (Date.now() - oldest < GRACE_MS || !Number.isFinite(oldest)) return;
  clearInterval(room.timer);
  clearTimeout(room.chooseTimer);
  clearTimeout(room.revealTimer);
  rooms.delete(roomId);
}

/* ------------------------------------------------------------------ */
/* الأحداث                                                            */
/* ------------------------------------------------------------------ */
io.on('connection', (socket) => {
  let room = null;
  let me = null;

  // ---------- إنشاء غرفة ----------
  socket.on('room:create', ({ name, avatar, settings }, ack) => {
    const id = code();
    while (rooms.has(id)) id = code();
    room = {
      id,
      hostId: null,
      players: [],
      settings: Object.assign({
        rounds: 3, drawTime: 80, language: 'ar', arabicStyle: 'dialect', difficulty: 'mix', customOnly: false, hints: 4,
      }, settings || {}),
      customWords: [],
      state: 'lobby',
      chatLog: [],
      playersById: new Map(),
      order: [], turnIndex: -1, round: 0, drawerId: null,
      currentWord: '', strokes: [], timer: null, chooseTimer: null, revealTimer: null,
      timeLeft: 0, totalTime: 0, wordHint: '', revealedCount: 0, guessed: new Set(),
    };
    rooms.set(id, room);

    me = {
      id: uid(),
      socketId: socket.id,
      name: String(name || 'لاعب').slice(0, 14),
      avatar: avatar || rand(AVATARS),
      score: 0, connected: true, guessed: false,
    };
    room.players.push(me);
    room.hostId = me.id;
    socket.join(id);

    systemChat(room, `👋 أهلاً ${me.name}! أنت مضيف الغرفة ${id}`);
    ack && ack({ ok: true, room: publicRoom(room), you: me });
    emitRoom(room, 'room:update', publicRoom(room));
  });

  // ---------- الانضمام لغرفة ----------
  socket.on('room:join', ({ roomId, name, avatar, playerId }, ack) => {
    room = rooms.get(String(roomId || '').toUpperCase());
    if (!room) return ack && ack({ ok: false, error: 'الغرفة غير موجودة. تأكد من الرمز.' });

    // إعادة اتصال: نفس اللاعب يعود
    let existing = playerId ? room.players.find((p) => p.id === playerId) : null;
    if (existing) {
      existing.socketId = socket.id;
      existing.connected = true;
      me = existing;
      socket.join(room.id);
      systemChat(room, `🔌 عاد ${me.name} إلى اللعبة`);
      ack && ack({ ok: true, room: publicRoom(room), you: me, chatLog: room.chatLog });
      emitRoom(room, 'room:update', publicRoom(room));
      if (room.state === 'draw' || room.state === 'choose') {
        socket.emit('draw:history', room.strokes);
      }
      return;
    }

    if (room.players.length >= MAX_PLAYERS) return ack && ack({ ok: false, error: 'الغرفة ممتلئة (12 لاعباً كحد أقصى).' });

    me = {
      id: uid(), socketId: socket.id,
      name: String(name || 'لاعب').slice(0, 14),
      avatar: avatar || rand(AVATARS),
      score: 0, connected: true, guessed: false,
    };
    room.players.push(me);
    socket.join(room.id);
    systemChat(room, `👋 انضم ${me.name} إلى الغرفة`);
    ack && ack({ ok: true, room: publicRoom(room), you: me, chatLog: room.chatLog });
    emitRoom(room, 'room:update', publicRoom(room));
    if (room.state === 'draw') socket.emit('draw:history', room.strokes);
  });

  // ---------- إعدادات الغرفة ----------
  socket.on('room:settings', (settings) => {
    if (!room || !me || room.hostId !== me.id || room.state !== 'lobby') return;
    Object.assign(room.settings, {
      rounds: clamp(settings.rounds, 1, 10, 3),
      drawTime: clamp(settings.drawTime, 30, 240, 80),
      language: ['ar', 'en'].includes(settings.language) ? settings.language : 'ar',
      arabicStyle: ['fusha', 'dialect', 'mix'].includes(settings.arabicStyle) ? settings.arabicStyle : 'dialect',
      difficulty: ['easy', 'medium', 'hard', 'mix'].includes(settings.difficulty) ? settings.difficulty : 'mix',
      customOnly: !!settings.customOnly,
      hints: clamp(settings.hints, 0, 8, 4),
    });
    emitRoom(room, 'room:update', publicRoom(room));
  });

  socket.on('room:customWords', (text) => {
    if (!room || !me || room.hostId !== me.id) return;
    room.customWords = String(text || '').split(/[,،\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 100).map((s) => s.toUpperCase());
    emitRoom(room, 'room:update', publicRoom(room));
  });

  // ---------- طرد لاعب ----------
  socket.on('room:kick', (playerId) => {
    if (!room || !me || room.hostId !== me.id) return;
    if (playerId === me.id) return;
    const victim = room.players.find((p) => p.id === playerId);
    if (!victim) return;
    io.to(victim.socketId).emit('room:kicked', { message: 'تم طردك من الغرفة' });
    systemChat(room, `🚫 تم طرد ${victim.name}`);
    leaveRoom(room, victim);
  });

  function leaveRoom(r, player) {
    r.players = r.players.filter((p) => p.id !== player.id);
    r.order = r.order.filter((id) => id !== player.id);
    if (r.players.length === 0) return cleanupRoom(r.id);
    if (r.hostId === player.id) r.hostId = r.players[0].id;
    if (r.drawerId === player.id && (r.state === 'draw' || r.state === 'choose')) endTurn(r, 'drawer-left');
    if (r.state === 'draw' || r.state === 'choose') emitRoom(r, 'room:update', publicRoom(r));
    else emitRoom(r, 'room:update', publicRoom(r));
  }

  socket.on('room:leave', () => {
    if (!room || !me) return;
    io.to(me.socketId).emit('room:left', {});
    systemChat(room, `👋 خرج ${me.name} من الغرفة`);
    const r = room, p = me;
    room = null; me = null;
    leaveRoom(r, p);
  });

  // ---------- بدء اللعبة ----------
  socket.on('game:start', () => {
    if (!room || !me || room.hostId !== me.id || room.state !== 'lobby') return;
    if (room.players.length < 1) {
      return socket.emit('room:error', { message: 'لا يوجد لاعبون في الغرفة.' });
    }
    room.startedAt = Date.now();
    startGame(room);
  });

  socket.on('game:rematch', () => {
    if (!room || !me || room.hostId !== me.id || room.state !== 'end') return;
    room.players.forEach((p) => { p.score = 0; p.guessed = false; });
    startGame(room);
  });

  // ---------- اختيار الكلمة ----------
  socket.on('game:chooseWord', ({ index }) => {
    if (!room || !me || room.state !== 'choose' || room.drawerId !== me.id) return;
    const word = room.wordChoices[index];
    if (!word) return;
    startDrawing(room, word);
  });

  // ---------- الرسم ----------
  socket.on('draw:stroke', (stroke) => {
    if (!room || !me || room.drawerId !== me.id || room.state !== 'draw') return;
    if (!stroke || !Array.isArray(stroke.points) || stroke.points.length < 1) return;
    const s = {
      color: sanitizeColor(stroke.color),
      width: clamp(stroke.width, 1, 60, 8),
      // إحداثيات نسبية 0..1
      points: stroke.points.slice(0, 5000)
        .map((p) => ({ x: Number(p.x), y: Number(p.y) }))
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
        .map((p) => ({ x: Math.min(1.2, Math.max(-0.2, p.x)), y: Math.min(1.2, Math.max(-0.2, p.y)) })),
    };
    if (!s.points.length) return;
    room.strokes.push(s);
    socket.to(room.id).emit('draw:stroke', s);
  });

  socket.on('draw:fill', (image) => {
    if (!room || !me || room.drawerId !== me.id) return;
    if (typeof image !== 'string' || image.length > 3e6) return;
    room.strokes.push({ type: 'snapshot', image });
    emitRoom(room, 'draw:snapshot', image);
  });

  socket.on('draw:undo', () => {
    if (!room || !me || room.drawerId !== me.id) return;
    if (room.strokes.length === 0) return;
    room.strokes.pop();
    emitRoom(room, 'draw:history', room.strokes);
  });

  socket.on('draw:clear', () => {
    if (!room || !me || room.drawerId !== me.id) return;
    room.strokes = [];
    emitRoom(room, 'draw:clear');
  });

  // ---------- الدردشة والتخمين ----------
  socket.on('chat:message', (payload) => {
    if (!room || !me) return;
    const text = String(payload?.text || payload || '').trim().slice(0, MAX_MSG);
    if (!text) return;

    if (room.state === 'draw' && room.drawerId !== me.id && !me.guessed) {
      if (handleGuess(room, me, text)) return registerCorrect(room, me);
    }
    if (room.drawerId === me.id && room.state === 'draw' && normalize(text) === normalize(room.currentWord)) {
      return socket.emit('room:error', { message: '🤫 لا تكتب الكلمة! أنت ترسمها.' });
    }
    chat(room, { id: Math.random().toString(36).slice(2), type: 'user', name: me.name, avatar: me.avatar, text, ts: Date.now() });
  });

  // ---------- انقطاع الاتصال ----------
  socket.on('disconnect', () => {
    if (!room || !me) return;
    me.connected = false;
    me.disconnectedAt = Date.now();
    me.guessed = false;
    systemChat(room, `📴 ${me.name} غير متصل`);
    if (room.drawerId === me.id && (room.state === 'draw' || room.state === 'choose')) {
      endTurn(room, 'drawer-left');
    }
    emitRoom(room, 'room:update', publicRoom(room));
  });
});

function clamp(v, min, max, def) {
  v = Number(v);
  if (!Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, Math.round(v)));
}

function sanitizeColor(c) {
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#000000';
}

// تنظيف الغرف الفارغة كل دقيقتين
setInterval(() => {
  for (const [id, room] of rooms) if (connectedPlayers(room).length === 0) cleanupRoom(id);
}, 120000).unref();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🖌️  سكربلو يعمل على: http://localhost:${PORT}`);
});

// نقطة تشخيص (للتحليل فقط) - تعمل عند DEBUG=1
if (process.env.DEBUG === '1') {
  app.get('/__debug', (req, res) => {
    res.json([...rooms.values()].map((r) => ({
      id: r.id, state: r.state, round: r.round, rounds: r.settings.rounds,
      turnIndex: r.turnIndex,
      order: r.order.map((id) => (r.players.find((p) => p.id === id) || { name: '?' + id.slice(0, 4) }).name),
      timeLeft: r.timeLeft,
      drawerId: r.drawerId, wordLen: (r.currentWord || '').length,
      players: r.players.map((p) => ({ n: p.name, on: p.connected, s: p.score })),
    })));
  });
}
