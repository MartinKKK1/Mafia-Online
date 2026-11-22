// ============================================================================
//  МАФИЯ: мультиплеер для Telegram Mini App на Cloudflare Workers
//
//  Всё в одном файле:
//    1. Настройки игры
//    2. Проверка подписи Telegram (initData)
//    3. Комната (Room): правила игры, боты, фазы, таймеры. Без зависимостей от Cloudflare
//    4. Durable Object GameRoom: WebSocket-подключения игроков к комнате
//    5. Telegram-бот: webhook, команды, /setup
//    6. Worker: маршруты и отдача страницы игры
//    7. Клиент (HTML, CSS, JS): интерфейс Mini App
//
//  Нужны: секреты BOT_TOKEN и WEBHOOK_SECRET, переменные из wrangler.toml.
// ============================================================================

// ---------------------------------------------------------------------------
// 1. Настройки
// ---------------------------------------------------------------------------
const MAX_PLAYERS = 8;            // мест за столом; свободные займут боты
const NIGHT_MS = 45000;           // длительность ночи, если есть живые люди с ночной ролью
const DAY_MS = 90000;             // длительность дня (обсуждение и голосование)
const QUIET_MS = 5000;            // фаза без людей-действующих: проходит быстро
const EARLY_MS = 700;             // пауза перед подсчётом, когда все уже выбрали
const BOT_INSIGHT = 0.35;         // шанс, что бот-мирный днём голосует против мафии
const INITDATA_MAX_AGE_S = 86400; // подпись Telegram действует сутки
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const ROLE_NAME = { mafia: 'Мафия', doctor: 'Доктор', sheriff: 'Шериф', civilian: 'Мирный' };
const ROLE_SET = ['mafia', 'mafia', 'doctor', 'sheriff', 'civilian', 'civilian', 'civilian', 'civilian'];
const BOT_NAMES = [
  'Алексей', 'Дмитрий', 'Олег', 'Сергей', 'Иван', 'Андрей', 'Николай',
  'Михаил', 'Павел', 'Юрий', 'Елена', 'Мария', 'Анна', 'Ольга', 'Татьяна'
];

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
function topOf(votes) {
  let max = 0, top = [];
  for (const k in votes) {
    if (votes[k] > max) { max = votes[k]; top = [k]; }
    else if (votes[k] === max) top.push(k);
  }
  return top.length ? pick(top) : null;
}
function randomCode() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  let s = '';
  for (let i = 0; i < b.length; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}
function cleanName(s) {
  const t = String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
  return t || 'Игрок';
}

// ---------------------------------------------------------------------------
// 2. Проверка подписи Telegram (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
// ---------------------------------------------------------------------------
async function hmac(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}
function sameString(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
// Возвращает { uid, name, avatar } или null при неверной или устаревшей подписи.
async function validateInitData(initData, botToken) {
  try {
    if (!initData || !botToken) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    const pairs = [];
    params.forEach((v, k) => { if (k !== 'hash') pairs.push([k, v]); });
    pairs.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    const check = pairs.map((p) => p[0] + '=' + p[1]).join('\n');
    const enc = new TextEncoder();
    const secret = await hmac(enc.encode('WebAppData'), enc.encode(botToken));
    const sig = await hmac(secret, enc.encode(check));
    let hex = '';
    for (let i = 0; i < sig.length; i++) hex += sig[i].toString(16).padStart(2, '0');
    if (!sameString(hex, hash.toLowerCase())) return null;
    const age = Date.now() / 1000 - Number(params.get('auth_date'));
    if (!(age > -300 && age < INITDATA_MAX_AGE_S)) return null;
    const user = JSON.parse(params.get('user'));
    if (!user || typeof user.id !== 'number') return null;
    const avatar = typeof user.photo_url === 'string' && user.photo_url.startsWith('https://') && user.photo_url.length < 500 ? user.photo_url : null;
    return { uid: 'tg' + user.id, name: cleanName(user.first_name || user.username), avatar: avatar };
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 3. Комната: правила игры
//    Игрок: { uid (секретный id), id (публичный номер места), name, avatar, role, alive, bot, conn }
//    conn = { send(string), close() } или null, если человек не в сети
// ---------------------------------------------------------------------------
class Room {
  constructor(code, opts) {
    this.code = code;
    this.o = Object.assign({ nightMs: NIGHT_MS, dayMs: DAY_MS, quietMs: QUIET_MS, earlyMs: EARLY_MS }, opts || {});
    this.timer = null; this.fn = null; this.ms = 0; this.deadline = 0;
    this.players = [];
    this.hostId = null;
    this.seq = 0;
    this.chatLog = [];
    this.chatAt = {};
    this.reset();
  }

  // Возврат в лобби: остаются только люди, которые сейчас в сети
  reset() {
    this.clear();
    this.phase = 'lobby'; this.round = 0; this.acts = {}; this.known = {}; this.log = []; this.winner = null;
    this.players = this.players.filter((p) => !p.bot && p.conn);
    this.players.forEach((p) => { p.role = null; p.alive = true; });
    if (!this.players.some((p) => p.id === this.hostId)) this.hostId = this.players.length ? this.players[0].id : null;
  }

  humans() { return this.players.filter((p) => !p.bot); }
  online() { return this.humans().some((p) => p.conn); }
  alive() { return this.players.filter((p) => p.alive); }
  byId(id) { return this.players.find((p) => p.id === id); }
  byUid(uid) { return this.players.find((p) => !p.bot && p.uid === uid); }
  addLog(text, to) { this.log.push({ text: text, to: to || null }); if (this.log.length > 200) this.log.shift(); }

  // --- таймеры (ставятся на паузу, когда в комнате нет людей в сети) ---
  arm(fn, ms) { this.clear(); this.fn = fn; this.ms = ms; this.run(ms); }
  run(ms) {
    this.deadline = Date.now() + ms;
    const fn = this.fn;
    this.timer = this.online()
      ? setTimeout(() => { try { fn(); } catch (e) { console.error('room error', e && e.stack || e); } }, ms)
      : null;
  }
  clear() { if (this.timer) clearTimeout(this.timer); this.timer = null; this.fn = null; }
  pause() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  resume() { if (this.fn && !this.timer && this.online()) this.run(this.ms); }
  early() {
    if (!this.timer) return;
    if (this.deadline - Date.now() > this.o.earlyMs) { clearTimeout(this.timer); this.run(this.o.earlyMs); }
  }

  // --- подключение ---
  join(uid, name, conn, avatar) {
    let p = this.byUid(uid);
    if (p) {
      if (p.conn && p.conn !== conn) p.conn.close();
      p.conn = conn;
      p.name = name;
      p.avatar = avatar || null;
    } else {
      if (this.phase !== 'lobby') return { ok: false, error: 'Игра уже идёт. Присоединиться можно только в лобби.' };
      if (this.humans().length >= MAX_PLAYERS) return { ok: false, error: 'Комната заполнена.' };
      p = { uid: uid, id: 'p' + (++this.seq), name: name, avatar: avatar || null, role: null, alive: true, bot: false, conn: conn };
      this.players.push(p);
      if (!this.hostId) this.hostId = p.id;
    }
    conn.send(JSON.stringify({ t: 'chathist', items: this.chatLog }));
    this.resume();
    this.broadcast();
    return { ok: true };
  }

  leave(uid, conn) {
    const p = this.byUid(uid);
    if (!p || p.conn !== conn) return;
    p.conn = null;
    if (this.phase === 'lobby') this.players = this.players.filter((q) => q !== p);
    if (this.hostId === p.id) {
      const n = this.humans().find((q) => q.conn);
      if (n) this.hostId = n.id;
      else if (this.phase === 'lobby') this.hostId = null;
    }
    if (!this.online()) this.pause();
    this.broadcast();
  }

  // --- входящие сообщения ---
  onMessage(uid, m) {
    const p = this.byUid(uid);
    if (!p || !m || typeof m.t !== 'string') return;
    if (m.t === 'start') return this.start(p);
    if (m.t === 'again') return this.again(p);
    if (m.t === 'act') return this.act(p, m.target);
    if (m.t === 'chat') return this.chat(p, m.text);
  }
  err(p, msg) { if (p.conn) p.conn.send(JSON.stringify({ t: 'error', msg: msg })); }

  start(p) {
    if (p.id !== this.hostId) return this.err(p, 'Начать игру может только хозяин комнаты.');
    if (this.phase !== 'lobby') return;
    const humans = this.humans().length;
    const names = shuffle(BOT_NAMES);
    let n = 0;
    while (this.players.length < MAX_PLAYERS) {
      this.players.push({ uid: null, id: 'b' + (++n), name: names[n - 1], avatar: null, role: null, alive: true, bot: true, conn: null });
    }
    const roles = shuffle(ROLE_SET);
    this.players = shuffle(this.players);
    this.players.forEach((q, i) => { q.role = roles[i]; q.alive = true; });
    this.round = 1; this.acts = {}; this.known = {}; this.log = []; this.winner = null;
    this.addLog('Игра началась. За столом ' + MAX_PLAYERS + ' игроков, живых людей: ' + humans + '.');
    this.players.filter((q) => q.role === 'mafia' && !q.bot).forEach((q) => {
      const mate = this.players.find((x) => x.role === 'mafia' && x !== q);
      if (mate) this.addLog('Ваш напарник по мафии: ' + mate.name + '.', q.id);
    });
    this.beginNight();
  }

  again(p) {
    if (p.id !== this.hostId) return this.err(p, 'Новую игру начинает хозяин комнаты.');
    if (this.phase !== 'over') return;
    this.reset();
    this.broadcast();
  }

  act(p, target) {
    if (!p.alive || (this.phase !== 'night' && this.phase !== 'day')) return;
    if (target === null || target === undefined) { delete this.acts[p.id]; return this.broadcast(); }
    const t = this.byId(target);
    if (!t || !t.alive) return this.err(p, 'Этого игрока выбрать нельзя.');
    if (this.phase === 'night') {
      if (p.role === 'civilian') return;
      if (p.role === 'mafia' && t.role === 'mafia') return this.err(p, 'Своих убивать нельзя.');
      if (p.role === 'sheriff' && t.id === p.id) return this.err(p, 'Себя проверять не нужно.');
    } else if (t.id === p.id) {
      return this.err(p, 'За себя голосовать нельзя.');
    }
    this.acts[p.id] = t.id;
    this.broadcast();
    this.checkEarly();
  }

  chat(p, text) {
    if (typeof text !== 'string') return;
    text = text.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
    if (!text) return;
    const ok = this.phase === 'lobby' || this.phase === 'over' || (this.phase === 'day' && p.alive);
    if (!ok) return this.err(p, 'Сейчас писать нельзя.');
    const now = Date.now();
    if (now - (this.chatAt[p.uid] || 0) < 600) return;
    this.chatAt[p.uid] = now;
    const item = { from: p.name, id: p.id, text: text };
    this.chatLog.push(item);
    if (this.chatLog.length > 40) this.chatLog.shift();
    const s = JSON.stringify({ t: 'chat', item: item });
    this.players.forEach((q) => { if (q.conn) q.conn.send(s); });
  }

  // --- ночь ---
  nightActors() {
    return this.alive().filter((p) => !p.bot && p.conn && (p.role === 'mafia' || p.role === 'doctor' || p.role === 'sheriff'));
  }
  beginNight() {
    this.phase = 'night'; this.acts = {};
    this.addLog('Наступила ночь №' + this.round + '.');
    this.arm(() => this.resolveNight(), this.nightActors().length ? this.o.nightMs : this.o.quietMs);
    this.broadcast();
  }
  checkEarly() {
    let need = [];
    if (this.phase === 'night') need = this.nightActors();
    else if (this.phase === 'day') need = this.alive().filter((p) => !p.bot && p.conn);
    if (need.length && need.every((p) => this.acts[p.id])) this.early();
  }
  resolveNight() {
    this.clear();
    const alive = this.alive();
    const mafia = alive.filter((p) => p.role === 'mafia');

    let killId = null;
    if (mafia.length) {
      const votes = {};
      mafia.forEach((p) => { const a = this.acts[p.id]; if (!p.bot && a) votes[a] = (votes[a] || 0) + 1; });
      killId = topOf(votes);
      if (!killId) {
        const pool = alive.filter((p) => p.role !== 'mafia');
        killId = pool.length ? pick(pool).id : null;
      }
    }
    const doc = alive.find((p) => p.role === 'doctor');
    let saveId = null;
    if (doc) saveId = doc.bot ? pick(alive).id : (this.acts[doc.id] || null);

    const sh = alive.find((p) => p.role === 'sheriff');
    if (sh && !sh.bot && this.acts[sh.id]) {
      const t = this.byId(this.acts[sh.id]);
      if (t) {
        const isM = t.role === 'mafia';
        (this.known[sh.id] = this.known[sh.id] || {})[t.id] = isM;
        this.addLog('Проверка шерифа: ' + t.name + (isM ? ': МАФИЯ.' : ': не мафия.'), sh.id);
      }
    }

    if (killId && killId === saveId) {
      this.addLog('Утро. Ночью на игрока напали, но доктор его спас.');
    } else if (killId) {
      const v = this.byId(killId);
      v.alive = false;
      this.addLog('Утро. Этой ночью убит(а) ' + v.name + ' (' + ROLE_NAME[v.role] + ').');
    } else {
      this.addLog('Утро. Ночь прошла спокойно.');
    }

    if (this.checkWin()) return this.broadcast();
    this.beginDay();
  }

  // --- день ---
  beginDay() {
    this.phase = 'day'; this.acts = {};
    this.addLog('Наступил день №' + this.round + '. Обсуждайте и голосуйте.');
    const voters = this.alive().filter((p) => !p.bot && p.conn);
    this.arm(() => this.resolveDay(), voters.length ? this.o.dayMs : this.o.quietMs);
    this.broadcast();
  }
  resolveDay() {
    this.clear();
    const voters = this.alive();
    const votes = {};
    voters.forEach((v) => {
      let tid = null;
      if (!v.bot) {
        const t = this.byId(this.acts[v.id]);
        tid = t && t.alive && t.id !== v.id ? t.id : null;
      } else if (v.role === 'mafia') {
        const pool = voters.filter((p) => p.role !== 'mafia');
        tid = pool.length ? pick(pool).id : null;
      } else {
        const others = voters.filter((p) => p.id !== v.id);
        const sus = others.filter((p) => p.role === 'mafia');
        tid = others.length ? ((sus.length && Math.random() < BOT_INSIGHT) ? pick(sus).id : pick(others).id) : null;
      }
      if (!tid) return;
      votes[tid] = (votes[tid] || 0) + 1;
      this.addLog(v.name + ' → ' + this.byId(tid).name);
    });

    let max = 0, leaders = [];
    for (const id in votes) {
      if (votes[id] > max) { max = votes[id]; leaders = [id]; }
      else if (votes[id] === max) leaders.push(id);
    }
    if (leaders.length === 1) {
      const out = this.byId(leaders[0]);
      out.alive = false;
      this.addLog('Город изгнал: ' + out.name + ' (' + ROLE_NAME[out.role] + '), голосов: ' + max + '.');
    } else {
      this.addLog('Голоса разделились. Никто не изгнан.');
    }

    if (this.checkWin()) return this.broadcast();
    this.round++;
    this.beginNight();
  }

  checkWin() {
    const alive = this.alive();
    const mafia = alive.filter((p) => p.role === 'mafia').length;
    const others = alive.length - mafia;
    let w = null;
    if (mafia === 0) w = 'civil';
    else if (mafia >= others) w = 'mafia';
    if (!w) return false;
    this.phase = 'over'; this.winner = w; this.clear();
    this.addLog(w === 'civil' ? 'Мафия уничтожена. Мирные победили!' : 'Мафия захватила город. Мафия победила!');
    this.humans().forEach((p) => this.addLog((w === 'mafia') === (p.role === 'mafia') ? 'Вы победили!' : 'Вы проиграли.', p.id));
    return true;
  }

  // --- что видит конкретный игрок ---
  canAct(p) {
    if (!p.alive) return false;
    if (this.phase === 'night') return p.role === 'mafia' || p.role === 'doctor' || p.role === 'sheriff';
    return this.phase === 'day';
  }
  view(p) {
    const over = this.phase === 'over';
    const known = this.known[p.id] || {};
    return {
      t: 'state',
      code: this.code,
      phase: this.phase,
      round: this.round,
      host: this.hostId,
      me: p.id,
      myRole: p.role,
      myAlive: p.alive,
      myAct: this.acts[p.id] || null,
      canAct: this.canAct(p),
      winner: this.winner,
      remain: this.timer ? Math.max(0, this.deadline - Date.now()) : null,
      players: this.players.map((q) => ({
        id: q.id,
        name: q.name,
        avatar: q.bot ? null : (q.avatar || null),
        alive: q.alive,
        bot: q.bot,
        online: q.bot || !!q.conn,
        role: q.role && (over || !q.alive || q.id === p.id || (p.role === 'mafia' && q.role === 'mafia')) ? q.role : null,
        mark: Object.prototype.hasOwnProperty.call(known, q.id) ? (known[q.id] ? 'mafia' : 'clean') : null
      })),
      log: this.log.filter((e) => !e.to || e.to === p.id).slice(-80).map((e) => e.text)
    };
  }
  broadcast() {
    this.players.forEach((p) => { if (p.conn) p.conn.send(JSON.stringify(this.view(p))); });
  }
}

// ---------------------------------------------------------------------------
// 4. Durable Object: одна комната = один экземпляр. Состояние хранится в памяти,
//    пока в комнате есть подключённые игроки.
// ---------------------------------------------------------------------------
export class GameRoom {
  constructor(state, env) {
    this.env = env;
    this.room = null;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const code = (new URL(request.url).searchParams.get('code') || '').toUpperCase();
    if (!this.room) this.room = new Room(code);
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();
    this.attach(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  attach(ws) {
    const env = this.env;
    const room = this.room;
    let uid = null, conn = null, authing = false;
    const say = (obj) => { try { ws.send(JSON.stringify(obj)); } catch (e) {} };
    const authTimer = setTimeout(() => { if (!uid) { try { ws.close(1008, 'auth timeout'); } catch (e) {} } }, 10000);

    ws.addEventListener('message', async (ev) => {
      if (typeof ev.data !== 'string' || ev.data.length > 2000) return;
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || typeof m.t !== 'string') return;
      if (uid) { room.onMessage(uid, m); return; }
      if (m.t !== 'join' || authing) return;
      authing = true;

      let user = await validateInitData(m.initData, env.BOT_TOKEN);
      if (!user && env.ALLOW_GUESTS === '1' && /^[a-z0-9]{8,32}$/.test(String(m.guestId || ''))) {
        user = { uid: 'g' + m.guestId, name: cleanName(m.name), avatar: null };
      }
      if (!user) {
        say({ t: 'error', fatal: true, msg: env.BOT_TOKEN ? 'Не удалось проверить данные Telegram. Откройте игру через бота.' : 'Сервер не настроен: нет BOT_TOKEN.' });
        try { ws.close(1008, 'auth'); } catch (e) {}
        return;
      }
      const c = {
        send: (s) => { try { ws.send(s); } catch (e) {} },
        close: () => { try { ws.close(1000, 'replaced'); } catch (e) {} }
      };
      const r = room.join(user.uid, user.name, c, user.avatar);
      if (!r.ok) {
        say({ t: 'error', fatal: true, msg: r.error });
        try { ws.close(1000, 'refused'); } catch (e) {}
        return;
      }
      uid = user.uid; conn = c;
    });

    const bye = () => { clearTimeout(authTimer); if (uid) room.leave(uid, conn); };
    ws.addEventListener('close', bye);
    ws.addEventListener('error', bye);
  }
}

// ---------------------------------------------------------------------------
// 5. Telegram-бот
// ---------------------------------------------------------------------------
async function tgApi(env, method, body) {
  const apiUrl = env.TELEGRAM_TEST === '1'
    ? 'https://api.telegram.org/bot' + env.BOT_TOKEN + '/test/' + method
    : 'https://api.telegram.org/bot' + env.BOT_TOKEN + '/' + method;
  const r = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json();
}
function roomLink(env, code) {
  if (!env.BOT_USERNAME || !env.APP_SHORT_NAME) return '';
  return 'https://t.me/' + env.BOT_USERNAME + '/' + env.APP_SHORT_NAME + '?startapp=' + code;
}

async function handleWebhook(request, env) {
  if (!env.WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }
  let update;
  try { update = await request.json(); } catch (e) { return new Response('ok'); }
  if (update && update.pre_checkout_query) {
    const query = update.pre_checkout_query;
    const valid = query.invoice_payload === 'donate' && query.currency === 'XTR' && [50, 100, 250].includes(query.total_amount);
    try {
      await tgApi(env, 'answerPreCheckoutQuery', valid
        ? { pre_checkout_query_id: query.id, ok: true }
        : { pre_checkout_query_id: query.id, ok: false, error_message: 'Этот счёт недействителен.' });
    } catch (e) { console.error('pre-checkout error', e && e.stack || e); }
    return new Response('ok');
  }
  const msg = update && update.message;
  if (!msg || !msg.chat) return new Response('ok');
  if (msg.successful_payment && msg.successful_payment.currency === 'XTR' && msg.successful_payment.invoice_payload === 'donate') {
    try { await tgApi(env, 'sendMessage', { chat_id: msg.chat.id, text: '💛 Спасибо за поддержку игры «Мафия»!' }); }
    catch (e) { console.error('payment receipt error', e && e.stack || e); }
    return new Response('ok');
  }
  if (typeof msg.text !== 'string') return new Response('ok');

  const origin = env.PUBLIC_URL || new URL(request.url).origin;
  const cmd = msg.text.trim().split(/[\s@]/)[0].toLowerCase();
  const isPrivate = msg.chat.type === 'private';
  try {
    if ((cmd === '/start' || cmd === '/play') && isPrivate) {
      await tgApi(env, 'sendMessage', {
        chat_id: msg.chat.id,
        text: '🎭 Мафия. Играйте с друзьями: 2 мафии, доктор, шериф и мирные. Свободные места займут боты.\n\nНажмите кнопку, создайте комнату и отправьте друзьям приглашение.',
        reply_markup: { inline_keyboard: [[{ text: '🎮 Играть', web_app: { url: origin } }]] }
      });
    } else if (cmd === '/newgame' || cmd === '/start' || cmd === '/play') {
      const code = randomCode();
      const link = roomLink(env, code);
      if (!link) {
        await tgApi(env, 'sendMessage', { chat_id: msg.chat.id, text: 'Бот ещё не настроен: задайте BOT_USERNAME и APP_SHORT_NAME в wrangler.toml и выполните деплой.' });
      } else {
        await tgApi(env, 'sendMessage', {
          chat_id: msg.chat.id,
          text: '🎭 Комната ' + code + ' создана. Заходите!',
          reply_markup: { inline_keyboard: [
            [{ text: '🎮 Войти в комнату', url: link }],
            [{ text: '📨 Позвать друзей', url: 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent('Заходи играть в Мафию!') }]
          ] }
        });
      }
    }
  } catch (e) {
    console.error('webhook error', e && e.stack || e);
  }
  return new Response('ok');
}

// Одноразовая настройка: открыть в браузере https://ВАШ-АДРЕС/setup?secret=ВАШ_WEBHOOK_SECRET
async function handleSetup(env, url) {
  if (!env.WEBHOOK_SECRET || url.searchParams.get('secret') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  if (!env.BOT_TOKEN) return new Response('Нет секрета BOT_TOKEN. Выполните: npx wrangler secret put BOT_TOKEN', { status: 500 });
  const origin = env.PUBLIC_URL || url.origin;
  const out = {};
  out.webhook = await tgApi(env, 'setWebhook', { url: origin + '/telegram/webhook', secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'pre_checkout_query'] });
  out.commands = await tgApi(env, 'setMyCommands', { commands: [
    { command: 'play', description: 'Открыть игру' },
    { command: 'newgame', description: 'Создать комнату и позвать друзей' }
  ] });
  out.menuButton = await tgApi(env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'Играть', web_app: { url: origin } } });
  return new Response(JSON.stringify(out, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8' } });
}

// ---------------------------------------------------------------------------
// Создание ссылки на добровольный донат через Telegram Stars
// ---------------------------------------------------------------------------
async function handleDonate(request, env) {
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Метод не поддерживается.' }), { status: 405, headers: { 'content-type': 'application/json; charset=utf-8' } });
  if (!env.BOT_TOKEN) return new Response(JSON.stringify({ error: 'Сервер не настроен.' }), { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } });
  let body;
  try { body = await request.json(); } catch (e) { return new Response(JSON.stringify({ error: 'Некорректный запрос.' }), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } }); }
  const user = await validateInitData(body && body.initData, env.BOT_TOKEN);
  if (!user) return new Response(JSON.stringify({ error: 'Не удалось подтвердить Telegram-аккаунт. Открой игру через бота.' }), { status: 401, headers: { 'content-type': 'application/json; charset=utf-8' } });
  const amount = [50, 100, 250].includes(Number(body.amount)) ? Number(body.amount) : 100;
  try {
    const invoice = await tgApi(env, 'createInvoiceLink', {
      title: 'Поддержать игру',
      description: 'Добровольная поддержка разработки игры «Мафия». Донат не даёт игровых преимуществ.',
      payload: 'donate',
      currency: 'XTR',
      provider_token: '',
      prices: [{ label: 'Поддержать игру', amount: amount }]
    });
    if (!invoice || !invoice.ok || typeof invoice.result !== 'string') {
      console.error('createInvoiceLink error', invoice && invoice.description || 'unknown');
      return new Response(JSON.stringify({ error: 'Telegram не смог создать счёт. Попробуй позже.' }), { status: 502, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
    return new Response(JSON.stringify({ url: invoice.result, amount: amount }), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  } catch (e) {
    console.error('donate error', e && e.stack || e);
    return new Response(JSON.stringify({ error: 'Не удалось создать счёт.' }), { status: 502, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
}

// ---------------------------------------------------------------------------
// 6. Worker
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      const code = (url.searchParams.get('code') || '').toUpperCase();
      if (!/^[A-Z0-9]{4,12}$/.test(code)) return new Response('Bad room code', { status: 400 });
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
    }
    if (url.pathname === '/telegram/webhook' && request.method === 'POST') return handleWebhook(request, env);
    if (url.pathname === '/api/donate') return handleDonate(request, env);
    if (url.pathname === '/setup') return handleSetup(env, url);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const cfg = JSON.stringify({ bot: env.BOT_USERNAME || '', app: env.APP_SHORT_NAME || '' }).replace(/</g, '\\u003c');
      return new Response(HTML.replace('/*CFG*/{}', () => cfg), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }
      });
    }
    return new Response('Not found', { status: 404 });
  }
};

// ---------------------------------------------------------------------------
// 7. Клиент. Внутри нет обратных кавычек и ${...}: страница лежит в String.raw.
// ---------------------------------------------------------------------------
const HTML = String.raw`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<title>Мафия</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { width: 100%; min-height: 100%; overflow-x: hidden; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: linear-gradient(160deg, #1a1a2e 0%, #16213e 100%);
    color: #fff; transition: background 0.6s;
  }
  body.night { background: linear-gradient(160deg, #0b0b17 0%, #101a33 100%); }
  body.day   { background: linear-gradient(160deg, #2b3a67 0%, #4a6fa5 100%); }

  .header {
    text-align: center; padding: 12px 12px 10px;
    padding-top: calc(12px + env(safe-area-inset-top, 0px));
    background: rgba(0,0,0,0.35); border-bottom: 2px solid #ffd700;
  }
  .title { font-size: 22px; font-weight: 800; color: #ffd700; letter-spacing: 1px; }
  .phase { display: inline-block; margin-top: 6px; padding: 4px 14px; border-radius: 16px; background: rgba(255,255,255,0.12); font-size: 14px; }

  .content { padding: 14px 12px 230px; max-width: 900px; margin: 0 auto; }
  .box {
    background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.15);
    border-radius: 14px; padding: 16px; line-height: 1.5; font-size: 15px; margin-bottom: 12px;
  }
  .box h2 { color: #ffd700; margin-bottom: 8px; font-size: 18px; }
  .box ul { margin: 8px 0 0 18px; }
  .row { display: flex; gap: 8px; margin-top: 10px; }

  .input {
    flex: 1; min-width: 0; min-height: 44px; padding: 0 12px; border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.3); background: rgba(255,255,255,0.1); color: #fff; font-size: 16px;
  }
  .input::placeholder { color: rgba(255,255,255,0.5); }

  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .card {
    position: relative; background: rgba(0,0,0,0.4); border: 2px solid transparent; border-radius: 14px;
    padding: 8px 4px; text-align: center; transition: transform .15s, border-color .15s, box-shadow .15s; user-select: none;
  }
  .card.selectable { cursor: pointer; border-color: rgba(255,255,255,0.25); }
  .card.selected { border-color: #ffd700; transform: scale(1.04); box-shadow: 0 0 18px rgba(255,215,0,0.5); }
  .card.dead { opacity: .45; filter: grayscale(100%); }
  .card.offline { opacity: .6; }
  .card.me { border-color: #667eea; }
  .avatar {
    width: 40px; height: 40px; margin: 0 auto 6px; border-radius: 50%;
    background: linear-gradient(135deg, #667eea, #764ba2);
    display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 700;
  }
  .name { font-size: 12px; font-weight: 700; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tag { display: inline-block; font-size: 10px; padding: 2px 6px; border-radius: 10px; background: rgba(255,215,0,0.2); color: #ffd700; min-height: 20px; }
  .tag.bad { background: rgba(231,76,60,0.3); color: #ff8a7d; }
  .tag.good { background: rgba(46,204,113,0.25); color: #7dffb0; }
  .badge { position: absolute; top: 3px; right: 3px; font-size: 9px; padding: 1px 5px; border-radius: 8px; background: #667eea; }
  .badge.bot { background: #555; }

  .chat { margin-top: 12px; }
  .chatlog { max-height: 150px; overflow-y: auto; font-size: 14px; line-height: 1.4; }
  .chatlog div { padding: 2px 0; word-wrap: break-word; }
  .chatlog b { color: #ffd700; }

  .panel {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 100; background: rgba(0,0,0,0.92);
    border-top: 2px solid #667eea; padding: 10px 12px;
    padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
  }
  .conn { display: none; text-align: center; font-size: 13px; color: #ffb4a8; margin-bottom: 6px; }
  .status { text-align: center; font-size: 14px; color: #ccc; margin-bottom: 4px; min-height: 20px; }
  .last { text-align: center; font-size: 12px; color: #8fa; margin-bottom: 8px; min-height: 16px; }
  .buttons { display: flex; gap: 8px; }
  .btn {
    flex: 1; min-height: 44px; border: none; border-radius: 10px; color: #fff; font-size: 15px; font-weight: 700;
    background: linear-gradient(135deg, #667eea, #764ba2); cursor: pointer; padding: 0 10px;
  }
  .btn.primary { background: linear-gradient(135deg, #27ae60, #2ecc71); }
  .btn.danger { background: linear-gradient(135deg, #e74c3c, #c0392b); }
  .btn:active { transform: scale(0.97); }
  .btn:disabled { opacity: .5; }

  .overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.8); z-index: 200; align-items: center; justify-content: center; }
  .overlay.active { display: flex; }
  .modal { width: 92%; max-width: 480px; max-height: 80vh; display: flex; flex-direction: column; background: #1e272e; border: 2px solid #667eea; border-radius: 16px; padding: 16px; }
  .modal h2 { color: #ffd700; text-align: center; margin-bottom: 10px; }
  .log { overflow-y: auto; flex: 1; }
  .log-entry { padding: 7px 10px; margin: 4px 0; background: rgba(102,126,234,0.12); border-left: 3px solid #667eea; border-radius: 4px; font-size: 13px; }

  .toast {
    position: fixed; left: 50%; top: 84px; transform: translateX(-50%); background: rgba(0,0,0,0.92);
    border: 1px solid #ffd700; padding: 10px 16px; border-radius: 10px; font-size: 14px; z-index: 300;
    opacity: 0; pointer-events: none; transition: opacity .25s; max-width: 90%; text-align: center; white-space: pre-line;
  }
  .toast.show { opacity: 1; }
  .big { font-size: 28px; font-weight: 800; letter-spacing: 4px; color: #ffd700; text-align: center; margin: 4px 0 8px; }

  /* Премиальная стеклянная тема и мягкие интерактивные состояния */
  body { background: radial-gradient(ellipse at 15% 0%, #28345a 0%, #111827 48%, #090d18 100%); transition: background 0.7s ease; }
  body.night { background: radial-gradient(ellipse at 15% 0%, #20294b 0%, #101525 48%, #070a12 100%); }
  body.day { background: radial-gradient(ellipse at 85% 0%, #536d9b 0%, #263a5d 48%, #142139 100%); }
  .header { background: rgba(9,13,25,.68); border-bottom: 1px solid rgba(244,198,91,.55); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); box-shadow: 0 8px 30px rgba(0,0,0,.22); }
  .title { color: #f6d889; text-shadow: 0 0 24px rgba(246,216,137,.22); letter-spacing: 2px; }
  .phase { background: rgba(255,255,255,.09); border: 1px solid rgba(255,255,255,.12); box-shadow: inset 0 1px rgba(255,255,255,.08); }
  .box { background: rgba(17,24,39,.58); border: 1px solid rgba(255,255,255,.11); border-radius: 18px; box-shadow: 0 14px 36px rgba(0,0,0,.19), inset 0 1px rgba(255,255,255,.045); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); }
  .box h2 { color: #f4d58b; }
  .input { background: rgba(255,255,255,.075); border-color: rgba(255,255,255,.16); border-radius: 12px; }
  .input:focus { outline: none; border-color: rgba(244,213,139,.75); box-shadow: 0 0 0 3px rgba(244,213,139,.12); }
  .card { min-width: 0; background: linear-gradient(155deg, rgba(31,41,62,.86), rgba(12,18,31,.8)); border: 1px solid rgba(255,255,255,.1); border-radius: 17px; padding: 12px 5px 10px; box-shadow: 0 8px 20px rgba(0,0,0,.16), inset 0 1px rgba(255,255,255,.045); transition: transform .2s ease, border-color .2s ease, box-shadow .2s ease, opacity .2s ease; }
  .card.selectable { border-color: rgba(255,255,255,.2); }
  .card.selectable:active { transform: scale(.96); }
  .card.selected { border-color: #f3d17d; transform: translateY(-2px); box-shadow: 0 0 0 1px rgba(243,209,125,.24), 0 0 25px rgba(243,209,125,.22); }
  .card.me { border-color: rgba(132,158,255,.65); }
  .avatar { width: 48px; height: 48px; margin-bottom: 8px; border: 2px solid rgba(255,255,255,.24); box-shadow: 0 4px 14px rgba(0,0,0,.3), 0 0 0 3px rgba(255,255,255,.035); overflow: hidden; }
  .avatar img { display: block; width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
  .avatar.photo { border-color: rgba(246,216,137,.75); box-shadow: 0 0 0 3px rgba(246,216,137,.1), 0 5px 18px rgba(0,0,0,.35); }
  .name { font-size: 12px; letter-spacing: .1px; }
  .tag { background: rgba(246,216,137,.13); color: #f6d889; border: 1px solid rgba(246,216,137,.12); }
  .badge { top: 5px; right: 5px; background: rgba(99,126,226,.9); border: 1px solid rgba(255,255,255,.14); }
  .badge.bot { background: rgba(110,120,140,.75); }
  .online-dot { position: absolute; width: 9px; height: 9px; top: 7px; left: 7px; border-radius: 50%; background: #52d69a; border: 2px solid #172033; box-shadow: 0 0 9px rgba(82,214,154,.65); }
  .card.offline .online-dot { background: #f07878; box-shadow: 0 0 8px rgba(240,120,120,.45); }
  .panel { background: rgba(8,12,23,.86); border-top: 1px solid rgba(151,169,255,.35); box-shadow: 0 -12px 36px rgba(0,0,0,.25); backdrop-filter: blur(22px); -webkit-backdrop-filter: blur(22px); }
  .status { color: #e2e7f4; }
  .last { color: #a9d9c0; }
  .btn { min-height: 48px; border-radius: 13px; background: linear-gradient(135deg, #647be0, #7654a8); box-shadow: 0 6px 16px rgba(57,66,133,.22), inset 0 1px rgba(255,255,255,.18); transition: transform .16s ease, filter .16s ease, box-shadow .16s ease; }
  .btn.primary { background: linear-gradient(135deg, #279b76, #37b987); }
  .btn.danger { background: linear-gradient(135deg, #c95b60, #a83d4a); }
  .btn:active { transform: scale(.97); filter: brightness(1.12); }
  .modal { background: rgba(19,27,44,.96); border: 1px solid rgba(151,169,255,.45); box-shadow: 0 24px 70px rgba(0,0,0,.48); }
  .toast { background: rgba(13,19,32,.94); border-color: rgba(246,216,137,.65); box-shadow: 0 12px 34px rgba(0,0,0,.35); backdrop-filter: blur(16px); }
  .big { color: #f6d889; text-shadow: 0 0 24px rgba(246,216,137,.2); }
  @media (max-width: 520px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; } .card { padding: 13px 5px 11px; } .buttons { gap: 6px; flex-wrap: wrap; } .buttons .btn { flex: 1 1 28%; font-size: 12px; padding: 0 6px; } }
  @media (min-width: 521px) { .grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; } }
</style>
</head>
<body>

<header class="header">
  <div class="title">🎭 МАФИЯ</div>
  <div class="phase"><span id="phase">Мультиплеер</span> <span id="timer"></span></div>
</header>

<main class="content">
  <section id="menu">
    <div class="box">
      <h2>Играйте с друзьями</h2>
      За столом 8 игроков. Роли раздаются случайно: 2 мафии, доктор, шериф и 4 мирных. Свободные места займут боты.
      <div class="row"><button class="btn primary" id="btn-create">Создать комнату</button></div>
      <div class="row"><button class="btn" id="btn-donate-menu">💛 Поддержать игру</button></div>
      <div class="row">
        <input class="input" id="code-input" maxlength="12" placeholder="Код комнаты" autocomplete="off" autocapitalize="characters">
        <button class="btn" id="btn-join">Войти</button>
      </div>
      <div class="row" id="resume-row" style="display:none"><button class="btn" id="btn-resume">Вернуться в комнату</button></div>
      <div class="status" id="menu-status" style="margin-top:10px"></div>
    </div>
    <div class="box">
      <h2>Правила</h2>
      <ul>
        <li>Мафия ночью выбирает жертву, днём прикидывается мирной.</li>
        <li>Доктор ночью лечит одного игрока, шериф проверяет, мафия ли он.</li>
        <li>Днём все обсуждают в чате и голосуют, кого изгнать.</li>
        <li>Мирные побеждают, когда мафии не осталось. Мафия побеждает, когда её не меньше, чем остальных.</li>
      </ul>
    </div>
  </section>

  <section id="room" style="display:none">
    <div class="box" id="lobby-box" style="display:none">
      <div style="text-align:center">Код комнаты</div>
      <div class="big" id="room-code"></div>
    </div>
    <div class="grid" id="grid"></div>
    <div class="box chat" id="chat-box">
      <div class="chatlog" id="chatlog"></div>
      <form class="row" id="chat-form" autocomplete="off">
        <input class="input" id="chat-input" maxlength="200" placeholder="Сообщение">
        <button class="btn" type="submit" style="flex:none; min-width:80px">Отпр.</button>
      </form>
    </div>
  </section>
</main>

<footer class="panel" id="panel" style="display:none">
  <div class="conn" id="conn">Нет связи, переподключаемся…</div>
  <div class="status" id="status"></div>
  <div class="last" id="last"></div>
  <div class="buttons">
    <button class="btn primary" id="btn-main" style="display:none"></button>
    <button class="btn" id="btn-invite" style="display:none">Пригласить</button>
    <button class="btn" id="btn-donate-room">💛 Донат</button>
    <button class="btn" id="btn-log">Журнал</button>
    <button class="btn danger" id="btn-leave">Выйти</button>
  </div>
</footer>

<div class="overlay" id="overlay">
  <div class="modal">
    <h2>Журнал игры</h2>
    <div class="log" id="log"></div>
    <button class="btn" id="btn-close" style="margin-top:10px; flex:none">Закрыть</button>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
(function () {
  var tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    try { tg.ready(); tg.expand(); tg.setHeaderColor('#1a1a2e'); tg.setBackgroundColor('#1a1a2e'); } catch (e) {}
  }
  var CFG = /*CFG*/{};
  var ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var ROLE_NAME = { mafia: 'Мафия', doctor: 'Доктор', sheriff: 'Шериф', civilian: 'Мирный' };

  var S = null, ws = null, code = null, leaving = false, retry = 0, retryTimer = null;
  var lastLogLen = -1, endAt = 0, connected = true;

  function $(id) { return document.getElementById(id); }
  function haptic(k) { try { if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred(k || 'light'); } catch (e) {} }
  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, val);
    } catch (e) {}
    return null;
  }
  var toastTimer = null;
  function toast(text) {
    var el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2800);
  }

  // --- идентификатор для проверки в браузере вне Telegram ---
  function guestId() {
    var id = null;
    try { id = sessionStorage.getItem('guestId'); } catch (e) {}
    if (!id) {
      id = '';
      var b = new Uint8Array(12);
      crypto.getRandomValues(b);
      for (var i = 0; i < b.length; i++) id += 'abcdefghijklmnopqrstuvwxyz0123456789'[b[i] % 36];
      try { sessionStorage.setItem('guestId', id); } catch (e) {}
    }
    return id;
  }
  function guestName() {
    var u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
    if (u && u.first_name) return u.first_name;
    return 'Гость' + (guestId().charCodeAt(0) * 7 % 90 + 10);
  }
  function randomCode() {
    var b = new Uint8Array(6), s = '';
    crypto.getRandomValues(b);
    for (var i = 0; i < b.length; i++) s += ALPHABET[b[i] % ALPHABET.length];
    return s;
  }
  function normCode(s) {
    s = String(s || '').trim().toUpperCase();
    return /^[A-Z0-9]{4,12}$/.test(s) ? s : '';
  }

  // --- соединение ---
  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  function connect(c) {
    code = c; leaving = false;
    clearTimeout(retryTimer);
    if (ws) { ws.onclose = null; try { ws.close(); } catch (e) {} }
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var mine = new WebSocket(proto + '//' + location.host + '/ws?code=' + encodeURIComponent(c));
    ws = mine;
    $('menu-status').textContent = 'Подключаемся…';
    mine.onopen = function () {
      retry = 0;
      send({ t: 'join', initData: tg ? tg.initData : '', guestId: guestId(), name: guestName() });
    };
    mine.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      onServer(m);
    };
    mine.onclose = function () {
      if (mine !== ws || leaving) return;
      setConn(false);
      retryTimer = setTimeout(function () { connect(code); }, Math.min(1000 * Math.pow(2, retry++), 8000));
    };
  }
  function setConn(ok) { connected = ok; $('conn').style.display = ok ? 'none' : 'block'; }

  function leaveRoom() {
    leaving = true;
    clearTimeout(retryTimer);
    if (ws) { ws.onclose = null; try { ws.close(); } catch (e) {} }
    ws = null; S = null; code = null; lastLogLen = -1;
    store('lastRoom', null);
    $('chatlog').innerHTML = '';
    setConn(true);
    render();
  }

  function onServer(m) {
    if (m.t === 'state') {
      setConn(true);
      var first = S === null;
      S = m;
      endAt = m.remain === null ? 0 : Date.now() + m.remain;
      store('lastRoom', code);
      var n = S.log.length;
      if (lastLogLen >= 0 && n > lastLogLen) {
        var fresh = S.log.slice(lastLogLen).filter(function (x) { return x.indexOf(' → ') < 0 && x.indexOf('Наступил') !== 0; });
        if (fresh.length) { toast(fresh.join('\n')); haptic('medium'); }
      }
      lastLogLen = n;
      if (first) $('menu-status').textContent = '';
      render();
    } else if (m.t === 'chathist') {
      $('chatlog').innerHTML = '';
      for (var i = 0; i < m.items.length; i++) addChat(m.items[i]);
    } else if (m.t === 'chat') {
      addChat(m.item);
    } else if (m.t === 'error') {
      toast(m.msg);
      if (m.fatal) {
        leaving = true;
        store('lastRoom', null);
        if (ws) { ws.onclose = null; try { ws.close(); } catch (e) {} }
        ws = null; S = null; code = null;
        $('menu-status').textContent = m.msg;
        render();
      }
    }
  }

  function addChat(it) {
    var box = $('chatlog');
    var d = document.createElement('div');
    var b = document.createElement('b');
    b.textContent = it.from + ': ';
    d.appendChild(b);
    d.appendChild(document.createTextNode(it.text));
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }

  // --- отрисовка ---
  function canPick(q) {
    if (!S.canAct || !q.alive) return false;
    if (S.phase === 'night') {
      if (S.myRole === 'doctor') return true;
      if (S.myRole === 'mafia') return q.role !== 'mafia';
      return q.id !== S.me;
    }
    return q.id !== S.me;
  }

  function tagFor(q) {
    if (q.role) return { text: ROLE_NAME[q.role], cls: q.role === 'mafia' ? 'bad' : '' };
    if (q.mark) return q.mark === 'mafia' ? { text: 'мафия', cls: 'bad' } : { text: 'не мафия', cls: 'good' };
    if (S.phase === 'lobby') return { text: q.id === S.host ? '👑 хозяин' : 'в комнате', cls: '' };
    return { text: q.alive ? '?' : '', cls: '' };
  }

  function statusText() {
    var host = S.host === S.me;
    if (S.phase === 'lobby') {
      return host ? 'Вы хозяин. Когда все соберутся, нажмите «Начать». Свободные места займут боты.' : 'Ждём, пока хозяин начнёт игру.';
    }
    if (S.phase === 'over') {
      return (S.winner === 'civil' ? 'Победили мирные. ' : 'Победила мафия. ') + (host ? '' : 'Ждём хозяина для новой игры.');
    }
    if (!S.myAlive) return 'Вы выбыли. Наблюдайте за игрой.';
    var tail = S.myAct ? ' Выбор принят, его можно изменить до конца таймера.' : '';
    if (S.phase === 'night') {
      if (S.myRole === 'mafia') return 'Ночь. Выберите жертву. Если вас двое, решает большинство.' + tail;
      if (S.myRole === 'doctor') return 'Ночь. Выберите, кого лечить.' + tail;
      if (S.myRole === 'sheriff') return 'Ночь. Выберите, кого проверить.' + tail;
      return 'Ночь. Вы мирный и спите. Ждите утра.';
    }
    return 'День. Обсуждайте в чате и выберите, кого изгнать.' + tail;
  }

  function phaseText() {
    if (S.phase === 'lobby') return '🚪 Лобби';
    if (S.phase === 'over') return 'Игра окончена';
    return (S.phase === 'night' ? '🌙 Ночь №' : '☀️ День №') + S.round;
  }

  // Подбирает стабильный оттенок буквенной аватарки по имени игрока
  function botColor(name) {
    var hash = 0;
    for (var i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    var hue = Math.abs(hash) % 360;
    return 'linear-gradient(135deg, hsl(' + hue + ', 62%, 54%), hsl(' + ((hue + 42) % 360) + ', 58%, 36%))';
  }

  function render() {
    var inRoom = !!S;
    $('menu').style.display = inRoom ? 'none' : 'block';
    $('room').style.display = inRoom ? 'block' : 'none';
    $('panel').style.display = inRoom ? 'block' : 'none';
    document.body.className = inRoom && (S.phase === 'night' || S.phase === 'day') ? S.phase : '';
    if (!inRoom) {
      $('phase').textContent = 'Мультиплеер';
      $('timer').textContent = '';
      var saved = store('lastRoom');
      $('resume-row').style.display = saved ? 'flex' : 'none';
      if (saved) $('btn-resume').textContent = 'Вернуться в комнату ' + saved;
      return;
    }

    $('phase').textContent = phaseText();
    $('lobby-box').style.display = S.phase === 'lobby' ? 'block' : 'none';
    $('room-code').textContent = S.code;
    $('status').textContent = statusText();
    $('last').textContent = S.log.length ? S.log[S.log.length - 1] : '';

    var host = S.host === S.me;
    var main = $('btn-main');
    if (host && S.phase === 'lobby') { main.style.display = ''; main.textContent = 'Начать игру'; }
    else if (host && S.phase === 'over') { main.style.display = ''; main.textContent = 'Новая игра'; }
    else main.style.display = 'none';
    $('btn-invite').style.display = S.phase === 'lobby' ? '' : 'none';

    var chatOn = S.phase === 'lobby' || S.phase === 'over' || (S.phase === 'day' && S.myAlive);
    $('chat-box').style.display = chatOn ? 'block' : 'none';

    var grid = $('grid');
    grid.innerHTML = '';
    S.players.forEach(function (q) {
      var card = document.createElement('div');
      card.className = 'card' + (q.alive ? '' : ' dead') + (q.id === S.me ? ' me' : '') + (q.online ? '' : ' offline');
      var pick = canPick(q);
      if (pick) card.className += ' selectable';
      if (S.myAct === q.id) card.className += ' selected';
      card.addEventListener('click', function () {
        if (!canPick(q)) return;
        haptic('light');
        send({ t: 'act', target: S.myAct === q.id ? null : q.id });
      });
      if (q.id === S.me || q.bot || !q.online) {
        var badge = document.createElement('span');
        badge.className = 'badge' + (q.bot ? ' bot' : '');
        badge.textContent = q.id === S.me ? 'вы' : (q.bot ? 'бот' : 'нет связи');
        card.appendChild(badge);
      }
      var dot = document.createElement('span');
      dot.className = 'online-dot';
      card.appendChild(dot);
      var av = document.createElement('div');
      av.className = 'avatar';
      if (q.avatar && !q.bot) {
        av.className += ' photo';
        var photo = document.createElement('img');
        photo.src = q.avatar;
        photo.alt = '';
        photo.referrerPolicy = 'no-referrer';
        photo.onerror = function () { av.className = 'avatar'; av.textContent = q.name.charAt(0).toUpperCase(); };
        av.appendChild(photo);
      } else {
        av.style.background = botColor(q.name);
        av.textContent = q.name.charAt(0).toUpperCase();
      }
      card.appendChild(av);
      var nm = document.createElement('div');
      nm.className = 'name';
      nm.textContent = q.name;
      card.appendChild(nm);
      var t = tagFor(q);
      var tag = document.createElement('span');
      tag.className = 'tag ' + t.cls;
      tag.textContent = t.text;
      card.appendChild(tag);
      grid.appendChild(card);
    });
    tick();
  }

  function tick() {
    var el = $('timer');
    if (!S || !(S.phase === 'night' || S.phase === 'day')) { el.textContent = ''; return; }
    if (!endAt) { el.textContent = '⏸'; return; }
    el.textContent = '⏱ ' + Math.max(0, Math.ceil((endAt - Date.now()) / 1000)) + ' с';
  }
  setInterval(tick, 500);
  setInterval(function () { if (S) send({ t: 'ping' }); }, 25000);

  // Создаёт защищённый счёт Stars и открывает его штатным окном Telegram
  function donate() {
    if (!tg || !tg.initData || !tg.openInvoice) { toast('Донаты доступны при открытии игры через Telegram.'); return; }
    var amount = 100;
    if (tg.showPopup) {
      tg.showPopup({ title: 'Поддержать игру', message: 'Выбери сумму добровольного доната в Telegram Stars.', buttons: [
        { id: '50', text: '⭐ 50' }, { id: '100', text: '⭐ 100' }, { id: '250', text: '⭐ 250' }
      ] }, function (id) { if (id && id !== 'cancel') createDonateInvoice(Number(id)); });
    } else createDonateInvoice(amount);
  }
  function createDonateInvoice(amount) {
    fetch('/api/donate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData: tg.initData, amount: amount }) })
      .then(function (r) { return r.json().then(function (data) { if (!r.ok) throw new Error(data.error || 'Не удалось создать счёт.'); return data; }); })
      .then(function (data) {
        tg.openInvoice(data.url, function (status) {
          if (status === 'paid') { toast('💛 Спасибо за поддержку игры!'); haptic('medium'); }
          else if (status === 'failed') toast('Платёж не прошёл. Попробуй ещё раз.');
        });
      })
      .catch(function (e) { toast(e.message || 'Ошибка при создании счёта.'); });
  }

  // --- действия ---
  function invite() {
    var link = (CFG.bot && CFG.app) ? 'https://t.me/' + CFG.bot + '/' + CFG.app + '?startapp=' + code : '';
    if (link && tg && tg.openTelegramLink) {
      tg.openTelegramLink('https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent('Заходи играть в Мафию!'));
      return;
    }
    var text = link || code;
    try {
      navigator.clipboard.writeText(text).then(function () { toast('Скопировано: ' + text); }, function () { toast('Код комнаты: ' + code); });
    } catch (e) { toast('Код комнаты: ' + code); }
  }

  $('btn-create').addEventListener('click', function () { haptic('medium'); connect(randomCode()); });
  $('btn-join').addEventListener('click', function () {
    var c = normCode($('code-input').value);
    if (!c) { toast('Введите код комнаты (латиницей и цифрами)'); return; }
    haptic('medium'); connect(c);
  });
  $('btn-resume').addEventListener('click', function () { var c = normCode(store('lastRoom')); if (c) connect(c); });
  $('btn-main').addEventListener('click', function () {
    haptic('medium');
    send({ t: S.phase === 'over' ? 'again' : 'start' });
  });
  $('btn-invite').addEventListener('click', invite);
  $('btn-donate-menu').addEventListener('click', function () { haptic('light'); donate(); });
  $('btn-donate-room').addEventListener('click', function () { haptic('light'); donate(); });
  $('btn-leave').addEventListener('click', function () { haptic('light'); leaveRoom(); });
  $('btn-log').addEventListener('click', function () {
    var box = $('log');
    box.innerHTML = '';
    (S ? S.log : []).forEach(function (t) {
      var d = document.createElement('div');
      d.className = 'log-entry';
      d.textContent = t;
      box.appendChild(d);
    });
    $('overlay').classList.add('active');
    box.scrollTop = box.scrollHeight;
  });
  $('btn-close').addEventListener('click', function () { $('overlay').classList.remove('active'); });
  $('chat-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var inp = $('chat-input');
    var text = inp.value.trim();
    if (!text) return;
    send({ t: 'chat', text: text });
    inp.value = '';
  });

  // --- старт: приглашение по ссылке, параметр ?room= или меню ---
  var start = '';
  try { start = tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param; } catch (e) {}
  if (!start) { try { start = new URLSearchParams(location.search).get('room'); } catch (e) {} }
  start = normCode(start);
  render();
  if (start) connect(start);
})();
</script>
</body>
</html>
`;
