/* Shaky Bets Poker Room — web client.
   Talks to the table server over one WebSocket (protocol: server/src/room.ts)
   and draws the table the way the PokerStars Replayer does.  Everything shown
   comes from the per-viewer view the server sends; the client holds no secrets. */

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = text; return d; };
const fmt = n => Number(n || 0).toLocaleString('en-US');
const SUIT = { h: '♥', d: '♦', c: '♣', s: '♠' };
const RANKS = '23456789TJQKA', SUITS = 'cdhs';
const cardId = code => RANKS.indexOf(code[0]) * 4 + SUITS.indexOf(code[1]);

const S = {
  ws: null, token: localStorage.getItem('pr.token') || '', user: null, balance: 0,
  screen: 'login', tables: [], tableId: sessionStorage.getItem('pr.table') || null,
  view: null, lastEnd: null, offset: 0, sel: new Set(), raiseTo: null, retry: 0, refN: 0,
  histText: '', histId: 0,
};

/* ===================== connection ===================== */

function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  S.ws = ws;
  setConn('connecting…');
  ws.onopen = () => {
    S.retry = 0; setConn('');
    if (S.token) send({ t: 'hello', token: S.token, clientSeed: freshSeed() });
  };
  ws.onmessage = e => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    if (S.ws !== ws) return;
    setConn('reconnecting…');
    setTimeout(connect, Math.min(8000, 500 * 2 ** S.retry++));
  };
}
function send(m) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ ...m, ref: ++S.refN })); }
function setConn(t) { $('#conn').textContent = t; }

/** fresh entropy for the deck, every hand (see the Fairness tab) */
function freshSeed() {
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function onMessage(m) {
  switch (m.t) {
    case 'welcome':
      S.user = m.user; S.balance = m.user.balance;
      localStorage.setItem('pr.token', S.token);
      paintMe();
      if (S.tableId) openTable(S.tableId); else showLobby();
      break;
    case 'lobby': S.tables = m.tables; paintLobby(); break;
    case 'table':
      if (m.view.id !== S.tableId) return;
      S.offset = m.view.now - Date.now();
      if (!S.view || !m.view.hand || !S.view.hand || S.view.hand.id !== m.view.hand.id || !m.view.hand.legal) S.sel.clear();
      if (!m.view.hand?.legal) S.raiseTo = null;
      S.view = m.view;
      paintTable();
      break;
    case 'handEnd':
      if (m.tableId !== S.tableId) return;
      S.lastEnd = m;
      send({ t: 'seed', clientSeed: freshSeed() });
      paintFair();
      break;
    case 'balance': S.balance = m.balance; paintMe(); break;
    case 'history': showHistory(m); break;
    case 'error':
      if (m.code === 'auth') { S.token = ''; localStorage.removeItem('pr.token'); showLogin(m.message); return; }
      toast(m.message);
      break;
  }
}

/* ===================== screens ===================== */

function setScreen(s) {
  S.screen = s;
  document.body.className = 'screen-' + s;
  $('#toLobby').hidden = s !== 'table';
  $('#logout').hidden = s === 'login';
  if (s !== 'table') $('#tableTitle').textContent = '';
}
function showLogin(err) { setScreen('login'); $('#loginErr').textContent = err || ''; $('#token').value = S.token; }
function showLobby() {
  if (S.tableId) send({ t: 'unwatch', tableId: S.tableId });
  S.tableId = null; S.view = null; sessionStorage.removeItem('pr.table');
  setScreen('lobby'); send({ t: 'lobby' });
}
function openTable(id) {
  S.tableId = id; S.view = null; S.lastEnd = null; sessionStorage.setItem('pr.table', id);
  setScreen('table');
  send({ t: 'watch', tableId: id });
}
function paintMe() {
  const me = $('#me'); me.innerHTML = '';
  if (!S.user) return;
  me.append(S.user.name + ' · ', el('b', null, fmt(S.balance)), ' chips');
}

function paintLobby() {
  const list = $('#tableList'); list.innerHTML = '';
  if (!S.tables.length) list.append(el('p', 'dim', 'No tables yet.'));
  for (const t of S.tables) {
    const c = el('div', 'tcard');
    c.append(el('b', null, t.name));
    const meta = el('div', 'meta');
    meta.append(el('span', null, t.game + (t.structure !== 'mixed' ? ' ' + t.structure : '') + ' · ' + t.stakes), el('span', 'seats', t.seated + '/' + t.maxSeats));
    c.append(meta);
    c.onclick = () => openTable(t.id);
    list.append(c);
  }
}

/* ===================== the table ===================== */

const STREET = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River', '3rd': '3rd Street', '4th': '4th Street', '5th': '5th Street',
  '6th': '6th Street', '7th': '7th Street', predraw: 'Before the draw', draw1: 'After the 1st draw', draw2: 'After the 2nd draw', draw3: 'After the 3rd draw', draw: 'Draw' };
const STRUCT = { NL: 'No Limit', PL: 'Pot Limit', FL: 'Limit' };

function polar(deg, rx, ry) { const t = deg * Math.PI / 180; return { x: 50 + rx * Math.cos(t), y: 50 + ry * Math.sin(t) }; }

function faceCard(code, extra) {
  const d = el('div', 'card ' + (extra || '') + ' ' + (code[1] === 's' ? 's2' : code[1]) + (code[0] === 'T' ? ' ten' : ''));
  d.append(el('div', 'r', code[0] === 'T' ? '10' : code[0]), el('div', 's', SUIT[code[1]]));
  return d;
}

/** what each player did last this street, read from the viewer's own history */
function lastActions(log, names) {
  const out = {}, won = {};
  for (const line of log) {
    if (line.startsWith('***')) { if (!/SHOW DOWN|SUMMARY/.test(line)) for (const k in out) delete out[k]; continue; }
    for (const n of names) {
      if (line.startsWith(n + ': ')) {
        const a = line.slice(n.length + 2).trim();
        if (/^(posts|brings|folds|checks|calls|bets|raises|discards|stands)/.test(a)) out[n] = a.replace(/ and is all-in/, ' (all-in)');
      }
      const m = line.match(new RegExp('^' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' collected (\\d+)'));
      if (m) won[n] = (won[n] || 0) + +m[1];
    }
  }
  return { last: out, won };
}

function paintTable() {
  const v = S.view;
  if (!v) return;
  const h = v.hand;
  $('#tableTitle').textContent = v.name + ' · ' + v.stakes.smallBet + '/' + v.stakes.bigBet;
  const gl = $('#gameLine'); gl.innerHTML = '';
  gl.append(el('b', null, v.game.name + ' ' + STRUCT[v.game.structure]), '  ·  ' + v.stakes.smallBet + '/' + v.stakes.bigBet);
  if (v.next && v.next.id !== v.game.id) gl.append('  ·  next: ' + v.next.name);
  if (h) gl.append('  ·  hand #' + h.id);

  const seats = $('#seats'); seats.innerHTML = '';
  const felt = $('#felt');
  const n = v.maxSeats;
  const bottom = v.mySeat || 1;
  const narrow = felt.clientWidth < 420;
  const RX = narrow ? 40 : n <= 4 ? 46 : 44, RY = narrow ? 44 : n <= 2 ? 52 : n <= 4 ? 48 : 43;
  const names = v.seats.filter(Boolean).map(s => s.name);
  const { last, won } = h ? lastActions(h.log, names) : { last: {}, won: {} };
  const stud = h && /stud|razz/i.test(v.game.id);
  const myTurn = h && h.legal;
  const maxC = Math.max(2, ...v.seats.map(s => (s ? s.cards.length : 0)));

  for (let k = 0; k < n; k++) {
    const seatNo = k + 1, s = v.seats[k];
    const idx = (k - (bottom - 1) + n) % n;
    const ang = 90 + idx * (360 / n);
    const c = polar(ang, RX, RY);
    let d;
    if (!s) {
      d = el('div', 'seat empty' + (!v.mySeat ? ' open' : ''), !v.mySeat ? 'Seat ' + seatNo + ' — sit' : 'Seat ' + seatNo);
      if (!v.mySeat) d.onclick = () => askBuyIn(seatNo);
    } else {
      const acting = h && !h.done && h.toAct === seatNo;
      d = el('div', 'seat' + (seatNo === v.mySeat ? ' hero' : '') + (acting ? ' acting' : '') + (s.folded ? ' folded' : '') + (!s.inHand ? ' out' : ''));
      const nm = el('div', 'nm');
      nm.append(el('b', null, s.name), el('span', 'st', s.allIn ? 'all-in' : fmt(s.stack)));
      const sub = el('div', 'sub');
      sub.append(el('span', null, 'Seat ' + seatNo), s.connected ? el('span', null, s.sittingOut ? 'sitting out' : '') : el('span', 'away', 'disconnected'));
      d.append(nm, sub);
      const cw = el('div', 'cards');
      const mine = seatNo === v.mySeat;
      if (stud && mine) d.classList.add('lifted');
      s.cards.forEach((code, j) => {
        let cd;
        if (!code) cd = el('div', 'card sm down');
        else cd = faceCard(code, 'sm' + (mine && stud && s.up[j] ? ' lift' : mine && !s.up[j] ? ' hole' : ''));
        if (mine && myTurn && h.legal.draw && code) {
          const id = cardId(code);
          cd.classList.add('pick');
          if (S.sel.has(id)) cd.classList.add('sel');
          cd.onclick = () => { S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); paintTable(); };
        }
        cw.append(cd);
      });
      d.append(cw);
      d.append(el('div', 'last', last[s.name] || ''));
      if (won[s.name]) d.append(el('div', 'winTag', '+' + fmt(won[s.name])));
      if (acting) { const ck = el('div', 'clock'); ck.append(el('i')); d.append(ck); }
      if (s.bet > 0) {
        const b = polar(ang, RX * 0.58, RY * 0.56);
        const chip = el('div', 'betChip', fmt(s.bet));
        chip.style.left = b.x + '%'; chip.style.top = b.y + '%';
        seats.append(chip);
      }
    }
    d.style.left = c.x + '%'; d.style.top = c.y + '%';
    d.dataset.seat = seatNo;
    seats.append(d);
    if (v.button === seatNo && s) {
      const b = polar(ang + 180 / n, RX * 0.74, RY * 0.72);
      const bt = el('div', 'dealerBtn', 'D');
      bt.style.left = b.x + '%'; bt.style.top = b.y + '%';
      seats.append(bt);
    }
  }

  // card + seat size: as large as the table holds without seat boxes overlapping
  const wantScw = maxC >= 7 ? 28 : maxC >= 6 ? 31 : maxC >= 5 ? 34 : maxC >= 4 ? 38 : 42;
  const wantW = maxC >= 7 ? 228 : maxC >= 6 ? 212 : maxC >= 5 ? 196 : maxC >= 4 ? 178 : 170;
  const fw = felt.clientWidth || 760, fh = felt.clientHeight || 370;
  const estH = wantScw * 1.45 + 64;
  const pts = [];
  for (let k = 0; k < n; k++) { const p = polar(90 + k * (360 / n), RX, RY); pts.push({ x: p.x / 100 * fw, y: p.y / 100 * fh }); }
  let capW = Infinity, capScw = Infinity;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const dx = Math.abs(pts[i].x - pts[j].x), dy = Math.abs(pts[i].y - pts[j].y);
    if (dy < estH) capW = Math.min(capW, dx - 10);
    // stacked seats (one above the other): shrink the cards until the boxes clear
    if (dx < 92 && dy > 0) capScw = Math.min(capScw, Math.floor((dy - 8 - 62) / 1.4));
  }
  const seatw = Math.max(92, Math.min(wantW, capW));
  const scw = Math.max(13, Math.min(wantScw, capScw, Math.floor((seatw - 16 - (maxC - 1) * 2) / maxC)));
  felt.style.setProperty('--scw', scw + 'px');
  felt.style.setProperty('--seatw', seatw + 'px');
  // your own seat sits alone at the bottom: give your cards room to be read
  const hero = seats.querySelector('.seat.hero');
  if (hero) {
    const heroScw = Math.max(scw, Math.min(42, Math.floor((Math.min(fw * 0.62, 300) - 16 - (maxC - 1) * 2) / maxC)));
    hero.style.setProperty('--scw', heroScw + 'px');
    hero.style.width = Math.max(seatw, heroScw * maxC + (maxC - 1) * 2 + 16) + 'px';
  }

  // centre
  $('#streetTag').textContent = h ? (h.done ? 'Hand over' : STREET[h.street] || '') : (v.seats.filter(Boolean).length < 2 ? 'Waiting for players' : '');
  const bd = $('#board'); bd.innerHTML = '';
  if (h) h.board.forEach(code => bd.append(faceCard(code)));
  // like the Replayer: the pot counts the bets in front too
  $('#potVal').textContent = fmt(h ? h.pot + v.seats.reduce((a, s) => a + (s ? s.bet : 0), 0) : 0);

  paintActions();
  paintSeatBar();
  paintLog();
  paintFair();
  tickClock();
}

/* ---------- acting ---------- */

function act(action) {
  const h = S.view?.hand;
  if (!h) return;
  send({ t: 'act', tableId: S.view.id, handId: h.id, action });
}

function paintActions() {
  const bar = $('#actionBar'); bar.innerHTML = '';
  const v = S.view, h = v.hand, L = h && !h.done ? h.legal : null;
  if (!L) {
    let msg = '';
    if (!v.mySeat) msg = 'Watching — pick an empty seat to play.';
    else if (h && !h.done && h.toAct) msg = 'Waiting for ' + (v.seats[h.toAct - 1]?.name || '…');
    else if (v.seats[v.mySeat - 1]?.sittingOut) msg = 'You are sitting out.';
    else msg = 'Next hand coming up…';
    bar.append(el('span', 'msg', msg));
    return;
  }
  const btn = (label, cls, key, f) => { const b = el('button', 'act ' + cls); b.append(label); if (key) b.append(el('kbd', null, key)); b.onclick = f; bar.append(b); return b; };

  if (L.draw) {
    const k = S.sel.size;
    bar.append(el('span', 'msg', k ? '' : 'Click the cards you want to throw away.'));
    btn(k ? 'Discard ' + k : 'Stand pat', 'raise', 'D', () => { act({ type: 'draw', discard: [...S.sel] }); S.sel.clear(); });
    if (k) btn('Clear', '', null, () => { S.sel.clear(); paintTable(); });
    return;
  }
  if (L.bringIn != null) {
    btn('Bring in ' + fmt(L.bringIn), 'call', 'C', () => act({ type: 'bringin' }));
    if (L.raise) btn('Complete to ' + fmt(L.raise.min), 'raise', 'R', () => act({ type: 'raise', amount: L.raise.min }));
    return;
  }
  if (L.call) btn('Fold', 'fold', 'F', () => act({ type: 'fold' }));
  if (L.check) btn('Check', 'call', 'C', () => act({ type: 'check' }));
  else btn('Call ' + fmt(L.call), 'call', 'C', () => act({ type: 'call' }));

  const r = L.bet || L.raise, verb = L.bet ? 'Bet' : 'Raise to';
  if (!r) return;
  const type = L.bet ? 'bet' : 'raise';
  if (r.only) { for (const a of r.only) btn(verb + ' ' + fmt(a), 'raise', null, () => act({ type, amount: a })); return; }
  if (r.min === r.max) { btn(verb + ' ' + fmt(r.min) + (r.max === myAllIn() ? ' (all-in)' : ''), 'raise', 'R', () => act({ type, amount: r.min })); return; }

  // no limit / pot limit: slider + presets
  if (S.raiseTo == null || S.raiseTo < r.min || S.raiseTo > r.max) S.raiseTo = r.min;
  const sz = el('div', 'sizer');
  const range = el('input'); range.type = 'range'; range.min = r.min; range.max = r.max; range.step = 1; range.value = S.raiseTo;
  const num = el('input'); num.type = 'number'; num.min = r.min; num.max = r.max; num.value = S.raiseTo;
  const go = btn(verb + ' ' + fmt(S.raiseTo), 'raise', 'R', () => act({ type, amount: S.raiseTo }));
  const set = x => { S.raiseTo = Math.max(r.min, Math.min(r.max, Math.round(x))); range.value = num.value = S.raiseTo; go.firstChild.textContent = verb + ' ' + fmt(S.raiseTo); };
  range.oninput = () => set(+range.value);
  num.onchange = () => set(+num.value);
  const pot = potSized(L);
  for (const [lab, x] of [['Min', r.min], ['½ pot', pot.half], ['Pot', pot.full], ['All-in', r.max]]) {
    const p = el('button', 'pre', lab); p.type = 'button'; p.onclick = () => set(x); sz.append(p);
  }
  sz.append(range, num);
  bar.insertBefore(sz, go);
}

function myAllIn() { const v = S.view, s = v.seats[v.mySeat - 1]; return s ? s.stack + s.bet : 0; }

/** pot-sized bet / raise-to, from what is on the table */
function potSized(L) {
  const v = S.view, h = v.hand;
  const bets = v.seats.reduce((a, s) => a + (s ? s.bet : 0), 0);
  const top = Math.max(0, ...v.seats.map(s => (s ? s.bet : 0)));
  const toCall = L.call || 0;
  const pot = h.pot + bets;
  const full = L.bet ? pot : top + pot + toCall;
  const half = L.bet ? Math.round(pot / 2) : top + Math.round((pot + toCall) / 2);
  return { full, half };
}

document.addEventListener('keydown', e => {
  if (S.screen !== 'table' || e.target.matches('input')) return;
  const L = S.view?.hand?.legal;
  if (!L || S.view.hand.done) return;
  const k = e.key.toLowerCase();
  if (L.draw) { if (k === 'd') { e.preventDefault(); act({ type: 'draw', discard: [...S.sel] }); S.sel.clear(); } return; }
  if (k === 'f' && L.call) act({ type: 'fold' });
  else if (k === 'c') act(L.bringIn != null ? { type: 'bringin' } : L.check ? { type: 'check' } : { type: 'call' });
  else if (k === 'r') { const r = L.bet || L.raise; if (r) act({ type: L.bet ? 'bet' : 'raise', amount: r.only ? r.only[0] : (S.raiseTo ?? r.min) }); }
});

/* ---------- seat controls ---------- */

function paintSeatBar() {
  const bar = $('#seatBar'); bar.innerHTML = '';
  const v = S.view;
  if (!v.mySeat) return;
  const s = v.seats[v.mySeat - 1];
  const b = (t, f) => { const x = el('button', 'btn ghost', t); x.onclick = f; bar.append(x); };
  b(s.sittingOut ? 'Sit in' : 'Sit out next hand', () => send({ t: 'sitOut', tableId: v.id, on: !s.sittingOut }));
  if (!s.inHand || v.hand?.done) b('Add chips', () => {
    const room = v.buyIn.max - s.stack;
    const amt = prompt('Add how many chips? (up to ' + fmt(room) + ')', String(Math.min(room, v.buyIn.min)));
    if (amt) send({ t: 'addChips', tableId: v.id, amount: Number(amt) });
  });
  b('Leave table', () => { if (!s.inHand || v.hand?.done || confirm('Leave now? You fold this hand and cash out when it ends.')) send({ t: 'leave', tableId: v.id }); });
}

function askBuyIn(seat) {
  const v = S.view;
  const max = Math.min(v.buyIn.max, S.balance);
  if (max < v.buyIn.min) { toast('You need at least ' + fmt(v.buyIn.min) + ' chips to sit here.'); return; }
  const r = $('#buyinRange'), n = $('#buyinNum');
  r.min = n.min = v.buyIn.min; r.max = n.max = max; r.value = n.value = Math.min(max, Math.max(v.buyIn.min, Math.round(v.buyIn.max / 2)));
  r.oninput = () => { n.value = r.value; }; n.oninput = () => { r.value = n.value; };
  $('#buyinTitle').textContent = 'Seat ' + seat + ' — buy in';
  $('#buyinNote').textContent = fmt(v.buyIn.min) + ' to ' + fmt(v.buyIn.max) + ' · you have ' + fmt(S.balance);
  $('#buyinForm').onsubmit = e => { e.preventDefault(); send({ t: 'sit', tableId: v.id, seat, buyIn: Number(n.value) }); closeModals(); };
  $('#buyinModal').classList.add('open');
}

/* ---------- side panes ---------- */

function paintLog() {
  const pane = $('#pane-log'); pane.innerHTML = '';
  const h = S.view.hand;
  if (!h) { pane.append(el('p', 'dim', 'No hand yet.')); return; }
  const me = S.user?.name;
  const start = h.log.findIndex(l => l.startsWith('***'));
  for (const line of h.log.slice(Math.max(0, start))) {
    pane.append(el('div', 'logline' + (line.startsWith('***') ? ' street' : '') + (me && line.startsWith(me) ? ' me' : ''), line));
  }
  pane.scrollTop = pane.scrollHeight;
}

async function sha256hex(hex) {
  const bytes = new Uint8Array(hex.match(/../g).map(x => parseInt(x, 16)));
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('');
}

function paintFair() {
  const pane = $('#pane-fair'); pane.innerHTML = '';
  const h = S.view?.hand;
  pane.append(el('p', 'dim', 'Before every hand the server commits to a secret seed by publishing its SHA-256 hash. Your browser adds its own random seed. After the hand the secret is revealed, so anyone can check the deck was fixed before the first card.'));
  const block = (title, id, commitment, serverSeed, mine) => {
    pane.append(el('h4', 'sec', title));
    const kv = el('div', 'kv');
    kv.append(el('span', null, 'Hand'), el('span', null, '#' + id));
    const c = el('span'); c.append(el('code', null, commitment)); kv.append(el('span', null, 'Commitment'), c);
    if (serverSeed) { const x = el('span'); x.append(el('code', null, serverSeed)); kv.append(el('span', null, 'Revealed seed'), x); }
    const chk = el('span', null, serverSeed ? 'checking…' : 'revealed when the hand ends');
    kv.append(el('span', null, 'Check'), chk);
    pane.append(kv);
    if (serverSeed) sha256hex(serverSeed).then(x => {
      chk.textContent = x === commitment ? '✓ SHA-256(seed) matches the commitment' : '✗ does not match!';
      chk.className = x === commitment ? 'ok' : 'bad';
    });
    if (serverSeed && mine) {
      const b = el('button', 'btn', 'My history of hand #' + id);
      b.style.marginTop = '10px';
      b.onclick = () => send({ t: 'history', handId: id });
      pane.append(b);
    }
  };
  if (h) block(h.done ? 'This hand (over)' : 'This hand', h.id, h.commitment, h.serverSeed, h.done && S.view.mySeat && S.view.seats[S.view.mySeat - 1]?.inHand);
  const e = S.lastEnd;
  if (e && (!h || e.handId !== h.id)) block('Previous hand', e.handId, e.commitment, e.serverSeed, S.user && e.net[S.user.id] != null);
}

function showHistory(m) {
  S.histText = m.text; S.histId = m.handId;
  $('#histTitle').textContent = 'Hand #' + m.handId;
  $('#histText').textContent = m.text;
  $('#histProof').textContent = 'server seed ' + m.proof.serverSeed + ' · commitment ' + m.proof.commitment + ' · client seeds ' + m.proof.clientSeeds.join(', ');
  $('#histModal').classList.add('open');
}
$('#histCopy').onclick = () => navigator.clipboard.writeText(S.histText).then(() => toast('Copied — paste it into the Hand Replayer.'));
$('#histSave').onclick = () => {
  const a = el('a'); a.href = URL.createObjectURL(new Blob([S.histText], { type: 'text/plain' }));
  a.download = 'ShakyBets-hand-' + S.histId + '.txt'; a.click(); URL.revokeObjectURL(a.href);
};

/* ---------- action clock ---------- */

function tickClock() {
  const v = S.view, h = v?.hand;
  const bar = document.querySelector('.seat.acting .clock');
  if (!h || !bar || !h.deadline) return;
  const left = h.deadline - (Date.now() + S.offset);
  const normal = v.actionSeconds * 1000;
  const seat = v.seats[h.toAct - 1];
  const bank = (seat?.timeBank || 0) * 1000;
  // the normal clock first, then the time bank (shown in red)
  const inBank = left <= bank;
  bar.classList.toggle('bank', inBank);
  const frac = inBank ? (bank ? left / bank : 0) : (left - bank) / normal;
  bar.firstChild.style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
}
setInterval(tickClock, 200);

/* ===================== misc UI ===================== */

let toastT = 0;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 3500);
}
function closeModals() { document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open')); }
document.querySelectorAll('[data-close]').forEach(b => { b.onclick = closeModals; });
document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) closeModals(); }));
document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + t.dataset.pane));
});
$('#toLobby').onclick = showLobby;
$('#refresh').onclick = () => send({ t: 'lobby' });
$('#logout').onclick = () => { S.token = ''; S.user = null; localStorage.removeItem('pr.token'); S.ws.close(); showLogin(); paintMe(); setTimeout(connect, 50); };
$('#loginForm').onsubmit = e => {
  e.preventDefault();
  S.token = $('#token').value.trim();
  if (!S.token) return;
  send({ t: 'hello', token: S.token, clientSeed: freshSeed() });
};
window.addEventListener('resize', () => { if (S.screen === 'table') paintTable(); });

if (S.token) setScreen('lobby'); else showLogin();
connect();
