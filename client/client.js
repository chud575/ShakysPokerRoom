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
  ws: null, token: localStorage.getItem('pr.token') || '', user: null,
  screen: 'login', tableId: sessionStorage.getItem('pr.table') || null,
  clubId: sessionStorage.getItem('pr.club') || null, clubs: [], club: null, balances: {}, ctab: 'tables',
  ledgerUser: '',
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
      S.user = m.user;
      localStorage.setItem('pr.token', S.token);
      paintMe();
      if (S.tableId) openTable(S.tableId); else if (S.clubId) openClub(S.clubId); else showClubs();
      break;
    case 'clubs':
      S.clubs = m.clubs;
      for (const c of m.clubs) S.balances[c.id] = c.balance;
      if (S.screen === 'clubs') paintClubs();
      break;
    case 'club':
      S.club = m; S.clubId = m.club.id; S.balances[m.club.id] = m.me.balance;
      sessionStorage.setItem('pr.club', m.club.id);
      if (S.screen === 'club' || S.screen === 'clubs') { if (S.screen !== 'club') setScreen('club'); paintClub(); }
      paintMe();
      break;
    case 'lobby': if (S.club && m.clubId === S.clubId) { S.club.tables = m.tables; if (S.screen === 'club') paintClub(); } break;
    case 'clubChanged':
      if (S.screen === 'club' && m.clubId === S.clubId) send({ t: 'club', clubId: S.clubId });
      if (S.screen === 'clubs') send({ t: 'clubs' });
      break;
    case 'ledger': if (m.clubId === S.clubId) paintLedger(m.rows); break;
    case 'report': if (m.clubId === S.clubId) paintReport(m); break;
    case 'table':
      if (m.view.id !== S.tableId) return;
      if (S.clubId !== m.view.clubId || S.balances[m.view.clubId] == null) {
        S.clubId = m.view.clubId; sessionStorage.setItem('pr.club', S.clubId);
        send({ t: 'club', clubId: S.clubId });            // for the club balance in the top bar
      }
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
    case 'balance':
      S.balances[m.clubId] = m.balance; paintMe();
      if (S.screen === 'club' && S.club && m.clubId === S.clubId) { S.club.me.balance = m.balance; paintClubHead(); }
      break;
    case 'history': showHistory(m); break;
    case 'error':
      if (m.code === 'auth') { S.token = ''; localStorage.removeItem('pr.token'); showLogin(m.message); return; }
      if (m.code === 'club' && (S.screen === 'club' || S.screen === 'table') && /not a member|waiting for approval/.test(m.message)) { showClubs(); }
      if (S.tfPending) { $('#tfErr').textContent = m.message; S.tfPending = false; return; }
      toast(m.message);
      break;
  }
}

/* ===================== screens ===================== */

function setScreen(s) {
  S.screen = s;
  document.body.className = 'screen-' + s + (S.club && S.club.club.id === S.clubId && ['owner', 'admin'].includes(S.club.me.role) ? ' isAdmin' : '');
  $('#back').hidden = s === 'login' || s === 'clubs';
  $('#back').textContent = s === 'table' ? '◀ Club' : '◀ Clubs';
  $('#logout').hidden = s === 'login';
  if (s !== 'table') $('#tableTitle').textContent = '';
  paintMe();
}
function showLogin(err) { setScreen('login'); $('#loginErr').textContent = err || ''; $('#token').value = S.token; }
function leaveTableView() {
  if (S.tableId) send({ t: 'unwatch', tableId: S.tableId });
  S.tableId = null; S.view = null; sessionStorage.removeItem('pr.table');
}
function showClubs() {
  leaveTableView();
  S.clubId = null; sessionStorage.removeItem('pr.club');
  setScreen('clubs'); paintClubs(); send({ t: 'clubs' });
}
function openClub(id) {
  leaveTableView();
  S.clubId = id; sessionStorage.setItem('pr.club', id);
  if (!S.club || S.club.club.id !== id) S.club = null;
  setScreen('club'); paintClub();
  send({ t: 'club', clubId: id });
}
function openTable(id) {
  S.tableId = id; S.view = null; S.lastEnd = null; sessionStorage.setItem('pr.table', id);
  setScreen('table');
  send({ t: 'watch', tableId: id });
}
function paintMe() {
  const me = $('#me'); me.innerHTML = '';
  if (!S.user) return;
  me.append(S.user.name);
  if (S.clubId && S.screen !== 'clubs' && S.balances[S.clubId] != null) me.append(' · ', el('b', null, fmt(S.balances[S.clubId])), ' chips');
}

/* ===================== clubs ===================== */

const ROLE = { owner: 'owner', admin: 'admin', member: 'member' };
function pill(text, cls) { return el('span', 'pill ' + (cls || ''), text); }

function paintClubs() {
  const list = $('#clubList'); list.innerHTML = '';
  if (!S.clubs.length) list.append(el('p', 'dim', 'You are not in a club yet — join one with an invite code, or start your own.'));
  for (const c of S.clubs) {
    const d = el('div', 'tcard');
    const top = el('div', 'meta'); top.append(el('b', null, c.name), pill(c.status === 'pending' ? 'waiting for approval' : ROLE[c.role], c.status === 'pending' ? 'pending' : c.role));
    const meta = el('div', 'meta'); meta.append(el('span', null, c.status === 'pending' ? 'not approved yet' : fmt(c.balance) + ' chips'));
    d.append(top, meta);
    if (c.status === 'active') d.onclick = () => openClub(c.id);
    else d.style.cursor = 'default';
    list.append(d);
  }
}

function isAdmin() { return S.club && ['owner', 'admin'].includes(S.club.me.role); }

function paintClubHead() {
  const c = S.club;
  $('#clubTitle').textContent = c ? c.club.name : 'Loading…';
  const sub = $('#clubSub'); sub.innerHTML = '';
  if (!c) return;
  sub.append('You are ' + (c.me.role === 'owner' ? 'the owner' : c.me.role === 'admin' ? 'an admin' : 'a member'));
  if (c.club.inviteCode) {
    sub.append(' · invite code ', el('span', 'invite', c.club.inviteCode), ' ');
    const b = el('button', 'btn sm ghost', 'New code'); b.onclick = () => { if (confirm('Replace the invite code? The old one stops working.')) send({ t: 'newCode', clubId: c.club.id }); };
    sub.append(b);
  }
  const bal = $('#clubBal'); bal.innerHTML = '';
  bal.append('Your balance ', el('b', null, fmt(c.me.balance)));
}

function paintClub() {
  document.body.classList.toggle('isAdmin', !!isAdmin());
  paintClubHead();
  if (!S.club) return;
  if (!isAdmin() && (S.ctab === 'members' || S.ctab === 'report')) S.ctab = 'tables';
  document.querySelectorAll('.ctab').forEach(t => t.classList.toggle('active', t.dataset.ctab === S.ctab));
  document.querySelectorAll('.cpane').forEach(p => p.classList.toggle('active', p.id === 'cp-' + S.ctab));
  paintClubTables();
  if (isAdmin()) paintMembers();
}

function paintClubTables() {
  const pane = $('#cp-tables'); pane.innerHTML = '';
  const bar = el('div', 'paneBar');
  bar.append(el('span', 'dim', S.club.tables.length + ' table' + (S.club.tables.length === 1 ? '' : 's')));
  if (isAdmin()) { const b = el('button', 'btn primary', '+ New table'); b.onclick = openTableForm; bar.append(b); }
  pane.append(bar);
  const grid = el('div', 'tableGrid');
  if (!S.club.tables.length) grid.append(el('p', 'dim', isAdmin() ? 'No tables yet — open one.' : 'No tables open right now.'));
  for (const t of S.club.tables) {
    const c = el('div', 'tcard');
    c.append(el('b', null, t.name));
    const meta = el('div', 'meta');
    meta.append(el('span', null, t.game + (t.structure !== 'mixed' ? ' ' + t.structure : '') + ' · ' + t.stakes), el('span', 'seats', t.seated + '/' + t.maxSeats));
    c.append(meta);
    c.onclick = () => openTable(t.id);
    if (isAdmin()) {
      const x = el('button', 'btn sm ghost', 'Close table');
      x.onclick = e => { e.stopPropagation(); if (confirm('Close "' + t.name + '"? Players are cashed out (after the hand in progress).')) send({ t: 'closeTable', tableId: t.id }); };
      const row = el('div', 'meta'); row.append(el('span'), x); c.append(row);
    }
    grid.append(c);
  }
  pane.append(grid);
}

function paintMembers() {
  const pane = $('#cp-members'); pane.innerHTML = '';
  const club = S.club, owner = club.me.role === 'owner';
  const bar = el('div', 'paneBar');
  bar.append(el('span', 'dim', 'Chips in play: ' + fmt(club.outstanding) + ' (issued − redeemed). Issue chips when a player pays you; redeem when you pay them.'));
  pane.append(bar);
  const wrap = el('div', 'scrollX'), tbl = el('table', 'grid');
  const hr = el('tr'); for (const h of ['Member', 'Role', 'Balance', 'Chips', '']) hr.append(el('th', h === 'Balance' ? 'num' : null, h));
  const thead = el('thead'); thead.append(hr); tbl.append(thead);
  const body = el('tbody');
  for (const m of club.members) {
    if (m.status === 'removed') continue;
    const tr = el('tr');
    tr.append(el('td', null, m.name));
    const rc = el('td'); rc.append(pill(m.status === 'pending' ? 'wants to join' : m.role, m.status === 'pending' ? 'pending' : m.role)); tr.append(rc);
    tr.append(el('td', 'num', m.status === 'pending' ? '' : fmt(m.balance)));
    const chips = el('td');
    if (m.status === 'active') {
      const f = el('div', 'mrow');
      const amt = el('input'); amt.type = 'number'; amt.min = 1; amt.placeholder = 'amount';
      const note = el('input', 'note'); note.placeholder = 'note (optional)';
      const go = (sign) => {
        const a = Math.round(Number(amt.value));
        if (!(a > 0)) { toast('Enter an amount'); return; }
        send({ t: 'chips', clubId: club.club.id, userId: m.userId, amount: sign * a, note: note.value });
      };
      const iss = el('button', 'btn sm', 'Issue'); iss.onclick = () => go(1);
      const red = el('button', 'btn sm ghost', 'Redeem'); red.onclick = () => go(-1);
      f.append(amt, iss, red, note);
      chips.append(f);
    }
    tr.append(chips);
    const act = el('td'); const row = el('div', 'mrow');
    const btn = (label, msg, cls = 'btn sm ghost', ask) => { const b = el('button', cls, label); b.onclick = () => { if (!ask || confirm(ask)) send({ t: 'member', clubId: club.club.id, userId: m.userId, ...msg }); }; row.append(b); };
    if (m.status === 'pending') { btn('Approve', { status: 'active' }, 'btn sm primary'); btn('Decline', { status: 'removed' }); }
    else if (m.role !== 'owner') {
      if (owner) btn(m.role === 'admin' ? 'Make member' : 'Make admin', { role: m.role === 'admin' ? 'member' : 'admin' });
      if (owner || m.role === 'member') btn('Remove', { status: 'removed' }, 'btn sm ghost', 'Remove ' + m.name + '? They leave every table (cashed out); their balance stays for you to redeem.');
    }
    act.append(row); tr.append(act);
    body.append(tr);
  }
  tbl.append(body); wrap.append(tbl); pane.append(wrap);
}

/* ---------- ledger & report ---------- */

const KIND = { issue: 'Chips issued', redeem: 'Chips redeemed', buyin: 'Buy-in', rebuy: 'Rebuy', cashout: 'Cash-out' };
const when = iso => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function requestLedger() { send({ t: 'ledger', clubId: S.clubId, userId: S.ledgerUser || undefined, limit: 1000 }); }

function paintLedger(rows) {
  const pane = $('#cp-ledger'); pane.innerHTML = '';
  const bar = el('div', 'paneBar'), left = el('div', 'ledgerBar');
  if (isAdmin()) {
    const sel = el('select');
    sel.append(new Option('Everyone', ''));
    for (const m of S.club.members) if (m.status !== 'pending') sel.append(new Option(m.name, m.userId));
    sel.value = S.ledgerUser;
    sel.onchange = () => { S.ledgerUser = sel.value; requestLedger(); };
    left.append(sel);
  } else left.append(el('span', 'dim', 'Your chip movements in this club'));
  const csv = el('button', 'btn sm ghost', 'Download CSV');
  csv.onclick = () => download('ledger.csv', [['time', 'member', 'kind', 'chips', 'table', 'hand', 'by', 'note'],
    ...rows.map(r => [r.at, r.name, r.kind, r.delta, r.tableId ?? '', r.handId ?? '', r.actorId ?? '', r.note ?? ''])]);
  bar.append(left, csv); pane.append(bar);
  const wrap = el('div', 'scrollX'), tbl = el('table', 'grid');
  const hr = el('tr'); for (const h of ['When', 'Member', 'What', 'Chips', 'Note']) hr.append(el('th', h === 'Chips' ? 'num' : null, h));
  const thead = el('thead'); thead.append(hr); tbl.append(thead);
  const body = el('tbody');
  if (!rows.length) { const tr = el('tr'); const td = el('td', 'dim', 'Nothing yet.'); td.colSpan = 5; tr.append(td); body.append(tr); }
  for (const r of rows) {
    const tr = el('tr');
    tr.append(el('td', null, when(r.at)), el('td', null, r.name), el('td', null, KIND[r.kind] || r.kind),
      el('td', 'num ' + (r.delta > 0 ? 'pos' : 'neg'), (r.delta > 0 ? '+' : '') + fmt(r.delta)),
      el('td', 'dim', r.note || (r.actorId && r.actorId !== r.userId ? 'by ' + r.actorId : '')));
    body.append(tr);
  }
  tbl.append(body); wrap.append(tbl); pane.append(wrap);
}

function requestReport() {
  const f = $('#rpFrom')?.value, t = $('#rpTo')?.value;
  const next = d => { const x = new Date(d); x.setDate(x.getDate() + 1); return x.toISOString(); };
  send({ t: 'report', clubId: S.clubId, from: f ? new Date(f).toISOString() : undefined, to: t ? next(t) : undefined });
}

function paintReport(m) {
  const pane = $('#cp-report'); pane.innerHTML = '';
  const bar = el('div', 'paneBar'), left = el('div', 'ledgerBar');
  const from = el('input'); from.type = 'date'; from.id = 'rpFrom';
  const to = el('input'); to.type = 'date'; to.id = 'rpTo';
  if (m.from) from.value = m.from.slice(0, 10);
  if (m.to) { const d = new Date(m.to); d.setDate(d.getDate() - 1); to.value = d.toISOString().slice(0, 10); }
  const go = el('button', 'btn sm', 'Show'); go.onclick = requestReport;
  left.append('From', from, 'to', to, go);
  const csv = el('button', 'btn sm ghost', 'Download CSV');
  csv.onclick = () => download('settle-up.csv', [['member', 'issued', 'redeemed', 'buy-ins', 'cash-outs', 'won/lost', 'balance'],
    ...m.rows.map(r => [r.name, r.issued, r.redeemed, r.buyins, r.cashouts, r.played, r.balance])]);
  bar.append(left, csv); pane.append(bar);
  pane.append(el('p', 'dim', 'Won/lost = cash-outs − buy-ins at the tables in this period (chips still on a table count once the player leaves). Balance = chips off the tables right now. Chips in play: ' + fmt(m.outstanding) + '.'));
  const wrap = el('div', 'scrollX'), tbl = el('table', 'grid');
  const cols = [['Member', null], ['Issued', 'issued'], ['Redeemed', 'redeemed'], ['Won / lost', 'played'], ['Balance', 'balance']];
  const hr = el('tr'); for (const [h, k] of cols) hr.append(el('th', k ? 'num' : null, h));
  const thead = el('thead'); thead.append(hr); tbl.append(thead);
  const body = el('tbody'), tot = { issued: 0, redeemed: 0, played: 0, balance: 0 };
  for (const r of m.rows) {
    if (r.status === 'pending') continue;
    const tr = el('tr'); tr.append(el('td', null, r.name + (r.status === 'removed' ? ' (removed)' : '')));
    for (const [, k] of cols.slice(1)) {
      tot[k] += r[k];
      tr.append(el('td', 'num' + (k === 'played' ? (r[k] > 0 ? ' pos' : r[k] < 0 ? ' neg' : '') : ''), (k === 'played' && r[k] > 0 ? '+' : '') + fmt(r[k])));
    }
    body.append(tr);
  }
  const foot = el('tfoot'), ft = el('tr'); ft.append(el('td', null, 'Total'));
  for (const [, k] of cols.slice(1)) ft.append(el('td', 'num', fmt(tot[k])));
  foot.append(ft);
  tbl.append(body, foot); wrap.append(tbl); pane.append(wrap);
}

function download(name, rows) {
  const esc = v => { const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const a = el('a'); a.href = URL.createObjectURL(new Blob([rows.map(r => r.map(esc).join(',')).join('\n') + '\n'], { type: 'text/csv' }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

/* ---------- new table form ---------- */

const GAMES = [
  ['holdem', "Hold'em", ['NL', 'FL', 'PL']], ['omaha', 'Omaha', ['PL', 'NL', 'FL']], ['omaha8', 'Omaha Hi/Lo', ['FL', 'PL', 'NL']],
  ['bigo', 'Big O', ['PL', 'FL', 'NL']], ['plo5', '5 Card PLO', ['PL', 'NL', 'FL']], ['plo6', '6 Card PLO', ['PL', 'NL', 'FL']],
  ['stud', '7 Card Stud', ['FL']], ['stud8', 'Stud Hi/Lo', ['FL']], ['razz', 'Razz', ['FL']],
  ['td27', '2-7 Triple Draw', ['FL', 'PL', 'NL']], ['sd27', '2-7 Single Draw', ['NL', 'PL', 'FL']], ['a5td', 'A-5 Triple Draw', ['FL', 'PL', 'NL']], ['badugi', 'Badugi', ['FL', 'PL', 'NL']],
];
function openTableForm() {
  const box = $('#tfGames'); box.innerHTML = '';
  for (const [id, name, structs] of GAMES) {
    const l = el('label'); const cb = el('input'); cb.type = 'checkbox'; cb.value = id;
    const sel = el('select'); for (const x of structs) sel.append(new Option(x === 'NL' ? 'No Limit' : x === 'PL' ? 'Pot Limit' : 'Limit', x));
    l.append(cb, name, sel); box.append(l);
  }
  $('#tfErr').textContent = '';
  $('#tableModal').classList.add('open');
}
$('#tfSmall').oninput = () => { $('#tfBig').value = 2 * Number($('#tfSmall').value || 0); };
$('#tableForm').onsubmit = e => {
  e.preventDefault();
  const games = [...document.querySelectorAll('#tfGames label')].filter(l => l.querySelector('input').checked)
    .map(l => ({ game: l.querySelector('input').value, structure: l.querySelector('select').value }));
  if (!games.length) { $('#tfErr').textContent = 'Pick at least one game.'; return; }
  const n = id => Number($(id).value);
  S.tfPending = true;
  send({ t: 'createTable', clubId: S.clubId, table: { name: $('#tfName').value, games, smallBet: n('#tfSmall'), bigBet: n('#tfBig'), maxSeats: n('#tfSeats'),
    minBuyIn: n('#tfMin'), maxBuyIn: n('#tfMax'), actionSeconds: n('#tfAct'), handsPerGame: n('#tfHpg'), mixedName: $('#tfName').value } });
  // success shows up as a clubChanged refresh; close optimistically after a beat unless an error came back
  setTimeout(() => { if (S.tfPending) { S.tfPending = false; closeModals(); } }, 400);
};

document.querySelectorAll('.ctab').forEach(t => t.onclick = () => {
  S.ctab = t.dataset.ctab; paintClub();
  if (S.ctab === 'ledger') requestLedger();
  if (S.ctab === 'report') requestReport();
});
$('#joinForm').onsubmit = e => { e.preventDefault(); const c = $('#joinCode').value.trim(); if (c) { send({ t: 'joinClub', code: c }); $('#joinCode').value = ''; toast('Request sent — the club owner will approve you.'); } };
$('#createForm').onsubmit = e => { e.preventDefault(); const n = $('#newClubName').value.trim(); if (n) { setScreen('club'); S.club = null; paintClub(); send({ t: 'createClub', name: n }); $('#newClubName').value = ''; } };

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
  const bal = S.balances[v.clubId] ?? 0;
  const max = Math.min(v.buyIn.max, bal);
  if (max < v.buyIn.min) { toast('You need at least ' + fmt(v.buyIn.min) + ' chips to sit here.'); return; }
  const r = $('#buyinRange'), n = $('#buyinNum');
  r.min = n.min = v.buyIn.min; r.max = n.max = max; r.value = n.value = Math.min(max, Math.max(v.buyIn.min, Math.round(v.buyIn.max / 2)));
  r.oninput = () => { n.value = r.value; }; n.oninput = () => { r.value = n.value; };
  $('#buyinTitle').textContent = 'Seat ' + seat + ' — buy in';
  $('#buyinNote').textContent = fmt(v.buyIn.min) + ' to ' + fmt(v.buyIn.max) + ' · you have ' + fmt(bal) + ' in the club';
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
$('#back').onclick = () => { if (S.screen === 'table' && S.clubId) openClub(S.clubId); else showClubs(); };
$('#logout').onclick = () => { S.token = ''; S.user = null; localStorage.removeItem('pr.token'); S.ws.close(); showLogin(); paintMe(); setTimeout(connect, 50); };
$('#loginForm').onsubmit = e => {
  e.preventDefault();
  S.token = $('#token').value.trim();
  if (!S.token) return;
  send({ t: 'hello', token: S.token, clientSeed: freshSeed() });
};
window.addEventListener('resize', () => { if (S.screen === 'table') paintTable(); });

if (S.token) setScreen('clubs'); else showLogin();
connect();
