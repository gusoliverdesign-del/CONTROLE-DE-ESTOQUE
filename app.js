/* Controle de Estoque — Laboratório Pasteur
   Toda a regra de negócio replica a planilha CONTROLE_DE_ESTOQUE_2026.xlsx:
   ENTRADAS(local) = ENTRADA no local + TRANSFERÊNCIA com destino = local
   SAÍDAS(local)   = SAÍDA no local   + TRANSFERÊNCIA com origem  = local
   ATUAL = INICIAL + ENTRADAS − SAÍDAS
   STATUS = mínimo vazio → SEM MÍNIMO; ATUAL ≤ MÍNIMO → REPOR; senão OK */
(() => {
'use strict';

const KEY = 'pasteur-estoque-v1';
const TIPOS = ['ENTRADA', 'SAÍDA', 'TRANSFERÊNCIA'];
const UNIDADES = ['CX', 'FRASCO', 'PCT', 'POTE', 'ROLO', 'UN.', 'UNIDADE'];
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fmt = n => Number(n || 0).toLocaleString('pt-BR');
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const fmtDate = iso => { if (!iso) return '—'; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
const clone = o => JSON.parse(JSON.stringify(o));

const ICON = {
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>',
  mov: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h13l-4-4"/><path d="M17 17H4l4 4"/></svg>',
};

/* ---------------- Estado ---------------- */
const CFG = window.SUPABASE_CONFIG || {};
const CLOUD = !!(CFG.url && CFG.key);
const CACHE = KEY + '-nuvem';
const EMPTY = () => ({insumos: [], locais: [], estoque: [], movs: []});
const hhmm = () => new Date().toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'});
let S = load();
function seedState() {
  const s = clone(window.SEED);
  s.movs.forEach((m, i) => m.uid = 'seed-' + (i + 1));
  return dedupe(s);
}
function dedupe(st) {
  const seen = new Map(), out = [];
  for (const e of st.estoque || []) {
    const k = e.local + '|' + e.id, prev = seen.get(k);
    if (!prev) { const c = {...e}; seen.set(k, c); out.push(c); continue; }
    prev.ini = (Number(prev.ini) || 0) + (Number(e.ini) || 0);
    const mins = [prev.min, e.min].filter(v => v !== null && v !== undefined && v !== '').map(Number);
    prev.min = mins.length ? Math.max(...mins) : null;
  }
  st.estoque = out;
  return st;
}
function readKey(k) {
  try { const raw = localStorage.getItem(k); if (raw) { const s = JSON.parse(raw); if (s && s.insumos && s.estoque) return dedupe(s); } } catch (e) {}
  return null;
}
function load() { return CLOUD ? (readKey(CACHE) || EMPTY()) : (readKey(KEY) || seedState()); }
// dados que este aparelho tinha antes da nuvem (usados no primeiro envio)
const localData = () => readKey(KEY) || seedState();
function setStatus(t, state) {
  ['#saveStatus', '#sheetSave'].forEach(sel => { const el = $(sel); if (el) el.textContent = t; });
  document.body.dataset.sync = state || '';
}
let saveTimer;
function save() {
  try { localStorage.setItem(CLOUD ? CACHE : KEY, JSON.stringify(S)); }
  catch (e) { if (!CLOUD) return setStatus('Não foi possível salvar — faça um backup', 'off'); }
  if (CLOUD) return;
  setStatus('Salvo às ' + hhmm());
  clearTimeout(saveTimer); saveTimer = setTimeout(() => setStatus('Dados salvos neste navegador'), 6000);
}
let undoStack = [];
function commit(msg, fn) {
  const before = clone(S);
  undoStack.push(JSON.stringify(S)); if (undoStack.length > 20) undoStack.shift();
  fn(); save(); renderAll();
  const undo = () => {
    const cur = clone(S); S = JSON.parse(undoStack.pop()); save(); renderAll();
    sync(cur, S).then(ok => { if (ok) toast('Ação desfeita'); });
  };
  if (!CLOUD) return toast(msg, undo);
  sync(before, S).then(ok => { if (ok) toast(msg, undo); else undoStack.pop(); });
}

/* ---------------- Nuvem (Supabase): banco compartilhado pela equipe ---------------- */
let membro = null, membros = [], accessChannel = null, pendingPoll = null;
let sb = null, me = null, pushing = 0, reloadWanted = false, channel = null, reloadT = null;
const numOrNull = v => v === null || v === undefined || v === '' ? null : Number(v);
const T = {
  insumos: {pk: ['id'], key: r => r.id,
    to: i => ({id: i.id, nome: i.nome, un: i.un || ''}),
    from: r => ({id: r.id, nome: r.nome, un: r.un || ''})},
  locais: {pk: ['nome'], key: r => r.nome,
    to: (l, i) => ({nome: l.nome, tipo: l.tipo || 'Sala', ordem: i}),
    from: r => ({nome: r.nome, tipo: r.tipo})},
  estoque: {pk: ['local', 'insumo_id'], key: r => r.local + '|' + r.insumo_id,
    to: e => ({local: e.local, insumo_id: e.id, inicial: Number(e.ini) || 0, minimo: numOrNull(e.min)}),
    from: r => ({local: r.local, id: r.insumo_id, ini: Number(r.inicial) || 0, min: numOrNull(r.minimo)})},
  movs: {pk: ['uid'], key: r => r.uid,
    to: m => ({uid: m.uid, data: m.data, local: m.local, insumo_id: m.id, tipo: m.tipo, qtd: Number(m.qtd), resp: m.resp || '', obs: m.obs || '', destino: m.destino || ''}),
    from: r => ({uid: r.uid, data: r.data, local: r.local, id: r.insumo_id, tipo: r.tipo, qtd: Number(r.qtd), resp: r.resp || '', obs: r.obs || '', destino: r.destino || '', por: r.criado_por || ''})},
};
const TABLES = Object.keys(T);
async function q(req) { const {data, error} = await req; if (error) throw error; return data; }
function errMsg(e) {
  const m = String((e && (e.message || e.error_description)) || e || '');
  if (/fetch|network|load failed/i.test(m)) return 'sem conexão com a internet';
  if (/jwt|token/i.test(m)) return 'sua sessão expirou, entre novamente';
  if (/permission|policy|row-level/i.test(m)) return 'sem permissão (você está logado?)';
  return m || 'erro desconhecido';
}
function live() { if (!pushing) setStatus('Sincronizado · ao vivo', 'live'); }
function offline() { setStatus('Sem conexão — mostrando a última versão', 'off'); }
async function fetchTable(name) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const page = await q(sb.from(name).select('*').range(from, from + 999));
    rows.push(...page); if (page.length < 1000) break;
  }
  if (name === 'locais') rows.sort((a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome));
  if (name === 'insumos') rows.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  if (name === 'estoque') rows.sort((a, b) => a.local.localeCompare(b.local) || a.insumo_id.localeCompare(b.insumo_id));
  if (name === 'movs') rows.sort((a, b) => (a.data + (a.criado_em || '')).localeCompare(b.data + (b.criado_em || '')));
  return rows.map(T[name].from);
}
async function reloadAll() {
  if (!sb || !me) return;
  if (pushing) { reloadWanted = true; return; }
  try {
    const [insumos, locais, estoque, movs] = await Promise.all(TABLES.map(fetchTable));
    if (pushing) { reloadWanted = true; return; }
    S = {insumos, locais, estoque, movs}; save(); renderAll(); live();
  } catch (e) { offline(); throw e; }
}
function diff(name, before, after) {
  const t = T[name], old = new Map(), seen = new Map();
  (before[name] || []).forEach((x, i) => { const r = t.to(x, i); old.set(t.key(r), r); });
  (after[name] || []).forEach((x, i) => { const r = t.to(x, i); seen.set(t.key(r), r); });
  const ups = [...seen].filter(([k, r]) => !old.has(k) || JSON.stringify(old.get(k)) !== JSON.stringify(r)).map(([, r]) => r);
  const dels = [...old].filter(([k]) => !seen.has(k)).map(([, r]) => r);
  return {ups, dels};
}
async function sync(before, after) {
  if (!CLOUD) return true;
  pushing++; setStatus('Salvando…', 'busy');
  try {
    const plan = TABLES.map(n => [n, diff(n, before, after)]);
    for (const [n, {ups}] of plan)
      for (let i = 0; i < ups.length; i += 500) await q(sb.from(n).upsert(ups.slice(i, i + 500), {onConflict: T[n].pk.join(',')}));
    for (const [n, {dels}] of plan.slice().reverse()) {
      const pk = T[n].pk;
      if (pk.length === 1) {
        const ks = dels.map(r => r[pk[0]]);
        for (let i = 0; i < ks.length; i += 150) await q(sb.from(n).delete().in(pk[0], ks.slice(i, i + 150)));
      } else {
        for (let i = 0; i < dels.length; i += 20) await Promise.all(dels.slice(i, i + 20).map(r => q(sb.from(n).delete().match({local: r.local, insumo_id: r.insumo_id}))));
      }
    }
    pushing--; live();
    if (reloadWanted && !pushing) { reloadWanted = false; reloadAll().catch(() => {}); }
    return true;
  } catch (e) {
    pushing--; reloadWanted = false;
    toast('Não foi possível salvar: ' + errMsg(e), null, true);
    reloadAll().catch(() => {});
    return false;
  }
}
function subscribe() {
  if (channel) sb.removeChannel(channel);
  channel = sb.channel('estoque-equipe');
  TABLES.forEach(t => channel.on('postgres_changes', {event: '*', schema: 'public', table: t}, p => onRemote(t, p)));
  channel.on('postgres_changes', {event: '*', schema: 'public', table: 'membros'}, p => onMembro(p));
  channel.subscribe(st => { if (st === 'SUBSCRIBED') live(); else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') offline(); });
}
function onRemote(t, p) {
  clearTimeout(reloadT); reloadT = setTimeout(() => reloadAll().catch(() => {}), 350);
  const n = p && p.new;
  if (t === 'movs' && p.eventType === 'INSERT' && n && n.criado_por && me && n.criado_por !== me.email) {
    const i = insById().get(n.insumo_id), who = n.resp || n.criado_por.split('@')[0];
    toast(`${who}: ${String(n.tipo).toLowerCase()} de ${fmt(n.qtd)} · ${i ? i.nome : n.insumo_id}`);
  }
}
function loginView(v) {
  $$('#login [data-view]').forEach(el => el.hidden = el.dataset.view !== v);
  $$('#loginTabs button').forEach(b => b.classList.toggle('on', b.dataset.loginView === v));
  $('#loginTabs').hidden = v === 'pendente';
  const f = $(`#login [data-view="${v}"] input`); if (f && !('ontouchstart' in window)) setTimeout(() => f.focus(), 50);
}
function showLogin(msg, view = 'entrar') {
  $('#login').hidden = false; document.body.classList.add('locked');
  loginView(view);
  $('#loginErr').textContent = msg || ''; $('#loginErr').classList.remove('ok');
  closeModal(); closeSheet(true);
}
function hideLogin() { $('#login').hidden = true; document.body.classList.remove('locked'); }
const isAdmin = () => !!(membro && membro.admin && membro.status === 'aprovado');
function renderAccount() {
  const email = me ? me.email : '';
  $$('[data-acct-email]').forEach(el => el.textContent = membro && membro.nome ? `${membro.nome} · ${email}` : email);
  $$('[data-acct]').forEach(el => el.hidden = !me);
  $$('[data-admin]').forEach(el => el.hidden = !isAdmin());
  const pend = isAdmin() ? membros.filter(m => m.status === 'pendente').length : 0;
  [['#navEquipe', false], ['#sheetEquipe', false], ['#tbBadgeMais', true]].forEach(([sel, txt]) => {
    const el = $(sel); if (!el) return; el.textContent = pend; el.classList.toggle('zero', !pend);
  });
}
// verifica se a conta foi aprovada (tabela "membros")
async function checkMember() {
  try {
    const rows = await q(sb.from('membros').select('*').eq('user_id', me.id));
    membro = rows[0] || {status: 'pendente', admin: false, nome: '', email: me.email};
  } catch (e) {
    const m = String((e && (e.message || '')) + ' ' + (e && e.code || ''));
    // banco ainda na versão anterior (sem a tabela de membros): todo usuário logado tem acesso
    if (/membros|42P01|PGRST205|schema cache|does not exist/i.test(m)) membro = {status: 'aprovado', admin: false, nome: '', legacy: true};
    else membro = readMembroCache() || {status: 'aprovado', admin: false, nome: '', offline: true};
  }
  try { localStorage.setItem(KEY + '-membro', JSON.stringify(membro)); } catch (e) {}
  return membro.status;
}
function readMembroCache() { try { const m = JSON.parse(localStorage.getItem(KEY + '-membro')); return m && me && m.user_id === me.id ? m : null; } catch (e) { return null; } }
async function loadMembros() {
  if (!isAdmin()) { membros = []; renderAccount(); return; }
  try { membros = await q(sb.from('membros').select('*').order('criado_em', {ascending: false})); } catch (e) {}
  renderAccount(); if (page === 'equipe') renderEquipe();
}
function onMembro(p) {
  const n = p && p.new;
  if (n && me && n.user_id === me.id) {
    membro = {...membro, ...n};
    if (membro.status !== 'aprovado') return showPending(membro.status);
    renderAccount();
  }
  if (isAdmin()) {
    if (p.eventType === 'INSERT' && n && n.status === 'pendente') toast(`Novo pedido de acesso: ${n.nome || n.email}`);
    loadMembros();
  }
}
function showPending(status) {
  if (channel) { sb.removeChannel(channel); channel = null; }
  S = EMPTY(); try { localStorage.removeItem(CACHE); } catch (e) {}
  showLogin('', 'pendente');
  const blocked = status === 'bloqueado';
  $('#pendingBadge').classList.toggle('blocked', blocked);
  $('#pendingTitle').textContent = blocked ? 'Acesso bloqueado' : 'Aguardando aprovação';
  $('#pendingText').textContent = blocked
    ? 'Um administrador bloqueou o acesso desta conta ao estoque. Fale com ele se achar que isso é um engano.'
    : 'Sua conta foi criada. Agora um administrador precisa liberar o seu acesso. Esta tela abre sozinha assim que você for aprovado.';
  $('#pendingEmail').textContent = me ? me.email : '';
  watchAccess();
}
// enquanto espera aprovação: escuta mudanças na própria linha e confere a cada 20s
function watchAccess() {
  stopWatchAccess();
  if (!sb || !me) return;
  accessChannel = sb.channel('meu-acesso')
    .on('postgres_changes', {event: '*', schema: 'public', table: 'membros', filter: `user_id=eq.${me.id}`}, () => recheck())
    .subscribe();
  pendingPoll = setInterval(recheck, 20000);
}
function stopWatchAccess() {
  if (accessChannel) { sb.removeChannel(accessChannel); accessChannel = null; }
  clearInterval(pendingPoll); pendingPoll = null;
}
async function recheck(manual) {
  if (!me) return;
  const st = await checkMember();
  if (st === 'aprovado') { stopWatchAccess(); if (manual !== 'quiet') toast('Acesso liberado!'); enter(me, true); }
  else if (manual === true) toast(st === 'bloqueado' ? 'O acesso continua bloqueado.' : 'Ainda aguardando aprovação.');
}
async function enter(user, checked) {
  me = user;
  if (!checked) {
    const st = await checkMember();
    if (st !== 'aprovado') return showPending(st);
  }
  stopWatchAccess();
  hideLogin(); renderAccount(); renderAll();
  setStatus('Carregando…', 'busy');
  try {
    await reloadAll();
    if (TABLES.every(t => !S[t].length) && (isAdmin() || membro.legacy)) await offerSeed();
  } catch (e) { toast('Sem conexão com o banco de dados. Mostrando a última versão salva.', null, true); }
  subscribe();
  loadMembros();
}
async function offerSeed() {
  const d = localData();
  if (!confirm(`O banco de dados da equipe está vazio.\n\nEnviar os dados deste aparelho para começar?\n${d.insumos.length} insumos · ${d.locais.length} locais · ${d.estoque.length} itens de estoque · ${d.movs.length} movimentações`)) return;
  if (await sync(EMPTY(), d)) { await reloadAll(); toast('Dados enviados para a equipe'); }
}
async function startCloud() {
  if (!window.supabase || !window.supabase.createClient) return showLogin('Não foi possível carregar a conexão com o banco de dados. Verifique a internet e recarregue a página.');
  sb = window.supabase.createClient(CFG.url, CFG.key, {auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'pasteur-estoque-auth'}});
  sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT' && me) { me = null; renderAccount(); showLogin(); } });
  let session = null;
  try { session = (await sb.auth.getSession()).data.session; } catch (e) {}
  if (session) enter(session.user); else showLogin();
}
function loginForm() {
  $('#login').addEventListener('click', e => {
    const b = e.target.closest('[data-login-view]'); if (!b) return;
    loginView(b.dataset.loginView);
    const em = $('#loginForm').email.value || $('#signupForm').email.value;
    if (em) { $('#loginForm').email.value = em; $('#signupForm').email.value = em; }
  });
  $('#pendingCheck').onclick = async () => { const b = $('#pendingCheck'); b.disabled = true; b.textContent = 'Verificando…'; await recheck(true); b.disabled = false; b.textContent = 'Verificar novamente'; };
  $('#pendingOut').onclick = () => logout(true);
  const f = $('#loginForm');
  f.onsubmit = async e => {
    e.preventDefault();
    const btn = $('button[type=submit]', f), err = $('#loginErr');
    if (!sb) return startCloud();
    err.textContent = ''; err.classList.remove('ok'); btn.disabled = true; btn.textContent = 'Entrando…';
    try {
      const {data, error} = await sb.auth.signInWithPassword({email: f.email.value.trim(), password: f.password.value});
      if (error) throw error;
      f.password.value = '';
      await enter(data.user);
    } catch (e2) {
      const m = String(e2.message || e2);
      err.textContent = /invalid login/i.test(m) ? 'E-mail ou senha incorretos.' : /not confirmed/i.test(m) ? 'Confirme o seu e-mail pelo link que enviamos e depois entre aqui.' : 'Não foi possível entrar: ' + errMsg(e2);
    } finally { btn.disabled = false; btn.textContent = 'Entrar'; }
  };
  const g = $('#signupForm');
  g.onsubmit = async e => {
    e.preventDefault();
    const btn = $('button[type=submit]', g), err = t => $('#signupErr').textContent = t;
    if (!sb) return startCloud();
    const nome = g.nome.value.trim(), email = g.email.value.trim();
    if (g.password.value.length < 6) return err('A senha precisa ter pelo menos 6 caracteres.');
    if (g.password.value !== g.password2.value) return err('As senhas não são iguais.');
    err(''); btn.disabled = true; btn.textContent = 'Criando conta…';
    try {
      const {data, error} = await sb.auth.signUp({email, password: g.password.value, options: {data: {nome}}});
      if (error) throw error;
      g.password.value = g.password2.value = '';
      if (data.session) { await enter(data.user); return; }
      // o projeto exige confirmação por e-mail
      if (data.user && Array.isArray(data.user.identities) && !data.user.identities.length) { err('Este e-mail já tem conta. Use "Entrar".'); return; }
      showLogin('Conta criada! Confirme o seu e-mail pelo link que enviamos e depois entre aqui.');
      $('#loginErr').classList.add('ok'); f.email.value = email;
    } catch (e2) {
      const m = String(e2.message || e2);
      err(/already registered|already exists/i.test(m) ? 'Este e-mail já tem conta. Use "Entrar".'
        : /signups? not allowed|disabled/i.test(m) ? 'A criação de contas está desativada. Fale com o administrador.'
        : /password/i.test(m) && /weak|short|least/i.test(m) ? 'Senha fraca. Use pelo menos 6 caracteres.'
        : /invalid.*email|email.*invalid/i.test(m) ? 'E-mail inválido.'
        : /rate limit/i.test(m) ? 'Muitas tentativas. Aguarde alguns minutos e tente de novo.'
        : 'Não foi possível criar a conta: ' + errMsg(e2));
    } finally { btn.disabled = false; btn.textContent = 'Criar conta'; }
  };
}
async function logout(force) {
  if (force !== true && !confirm('Sair da sua conta neste aparelho?')) return;
  try { localStorage.removeItem(CACHE); localStorage.removeItem(KEY + '-membro'); } catch (e) {}
  if (channel) { sb.removeChannel(channel); channel = null; }
  stopWatchAccess();
  S = EMPTY(); me = null; membro = null; membros = []; renderAccount(); renderAll(); showLogin();
  try { await sb.auth.signOut(); } catch (e) {}
}
function modalSenha() {
  openModal(head('Sua conta', 'Alterar senha') + `
  <form class="form" id="fPwd" autocomplete="off">
    <label class="full">E-mail<input value="${esc(me ? me.email : '')}" readonly style="color:#999"></label>
    <label>Nova senha<input name="p1" type="password" minlength="6" required autocomplete="new-password" autofocus></label>
    <label>Repita a nova senha<input name="p2" type="password" minlength="6" required autocomplete="new-password"></label>
    <div class="error" id="pwdErr"></div>
    <div class="form-actions"><div class="right"><button class="btn ghost" type="button" data-close>Cancelar</button><button class="btn accent" type="submit">Salvar senha</button></div></div>
  </form>`, root => {
    $('#fPwd', root).onsubmit = async ev => {
      ev.preventDefault();
      const f = ev.target, err = t => $('#pwdErr', root).textContent = t;
      if (f.p1.value.length < 6) return err('A senha precisa ter pelo menos 6 caracteres.');
      if (f.p1.value !== f.p2.value) return err('As senhas não são iguais.');
      const {error} = await sb.auth.updateUser({password: f.p1.value});
      if (error) return err('Não foi possível alterar: ' + errMsg(error));
      closeModal(); toast('Senha alterada');
    };
  });
}

/* ---------------- Cálculo ---------------- */
const insById = () => new Map(S.insumos.map(i => [i.id, i]));
const locTipo = () => new Map(S.locais.map(l => [l.nome, l.tipo]));
function compute() {
  const ent = new Map(), sai = new Map();
  const add = (m, k, q) => m.set(k, (m.get(k) || 0) + q);
  for (const m of S.movs) {
    const q = Number(m.qtd) || 0;
    if (m.tipo === 'ENTRADA') add(ent, m.local + '|' + m.id, q);
    else if (m.tipo === 'SAÍDA') add(sai, m.local + '|' + m.id, q);
    else if (m.tipo === 'TRANSFERÊNCIA') { add(sai, m.local + '|' + m.id, q); add(ent, m.destino + '|' + m.id, q); }
  }
  const ib = insById(), lt = locTipo();
  return S.estoque.map((e, idx) => {
    const k = e.local + '|' + e.id, i = ib.get(e.id) || {nome: '(insumo removido)', un: ''};
    const E = ent.get(k) || 0, Sa = sai.get(k) || 0, atual = (Number(e.ini) || 0) + E - Sa;
    const hasMin = e.min !== null && e.min !== '' && e.min !== undefined;
    const status = !hasMin ? 'SEM MÍNIMO' : atual <= Number(e.min) ? 'REPOR' : 'OK';
    return {idx, local: e.local, tipo: lt.get(e.local) || '—', id: e.id, nome: i.nome, un: i.un, ini: Number(e.ini) || 0, min: hasMin ? Number(e.min) : null, ent: E, sai: Sa, atual, status};
  });
}
function consolidate(rows) {
  const m = new Map();
  for (const r of rows) {
    let c = m.get(r.id);
    if (!c) { c = {id: r.id, nome: r.nome, un: r.un, locais: 0, ini: 0, ent: 0, sai: 0, atual: 0, min: null, repor: 0}; m.set(r.id, c); }
    c.locais++; c.ini += r.ini; c.ent += r.ent; c.sai += r.sai; c.atual += r.atual;
    if (r.min !== null) c.min = (c.min || 0) + r.min;
    if (r.status === 'REPOR') c.repor++;
  }
  return [...m.values()].map(c => ({...c, status: c.min === null ? 'SEM MÍNIMO' : c.atual <= c.min ? 'REPOR' : 'OK'}));
}
function saldo(local, id) {
  const r = compute().find(r => r.local === local && r.id === id);
  return r ? r.atual : null;
}
function nextId() {
  const n = S.insumos.reduce((m, i) => Math.max(m, parseInt(String(i.id).replace(/\D/g, '')) || 0), 0) + 1;
  return 'INS-' + String(n).padStart(3, '0');
}

/* ---------------- UI helpers ---------------- */
function toast(msg, undo, err) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.innerHTML = `<span>${esc(msg)}</span>` + (undo ? '<button type="button">Desfazer</button>' : '');
  if (undo) t.querySelector('button').onclick = () => { t.remove(); undo(); };
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), undo ? 6000 : 3200);
}
const statusPill = s => `<span class="pill ${s === 'SEM MÍNIMO' ? 'SEM' : s}">${s}</span>`;
function meter(atual, min) {
  let color = '#4a4a4a', pct = 100;
  if (min !== null) { pct = min > 0 ? Math.min(100, (atual / (min * 2)) * 100) : (atual > 0 ? 100 : 0); color = atual <= min ? 'var(--red)' : 'var(--accent)'; }
  return `<div class="meter"><span class="bar"><b style="width:${Math.max(atual > 0 ? 6 : 0, pct)}%;background:${color}"></b></span><strong class="num">${fmt(atual)}</strong></div>`;
}
function pills(el, opts, current, onPick) {
  el.innerHTML = opts.map(o => `<button class="filter${o.v === current ? ' active' : ''}" data-v="${esc(o.v)}">${esc(o.label)}${o.count !== undefined ? `<span class="count">${o.count}</span>` : ''}</button>`).join('');
  el.onclick = e => { const b = e.target.closest('button'); if (b) onPick(b.dataset.v); };
}
function localOptions(sel, withAll, allLabel = 'Todos os locais') {
  const groups = ['Sala', 'Antessala'];
  let h = withAll ? `<option value="">${allLabel}</option>` : '';
  for (const g of groups) {
    const ls = S.locais.filter(l => l.tipo === g);
    if (ls.length) h += `<optgroup label="${g === 'Sala' ? 'Salas' : 'Antessalas'}">` + ls.map(l => `<option ${l.nome === sel ? 'selected' : ''}>${esc(l.nome)}</option>`).join('') + '</optgroup>';
  }
  const other = S.locais.filter(l => !groups.includes(l.tipo));
  h += other.map(l => `<option ${l.nome === sel ? 'selected' : ''}>${esc(l.nome)}</option>`).join('');
  return h;
}
function sortRows(rows, sort) {
  const {k, d} = sort;
  return rows.sort((a, b) => {
    let x = a[k], y = b[k];
    if (x === null) x = -Infinity; if (y === null) y = -Infinity;
    if (typeof x === 'string') return x.localeCompare(y, 'pt-BR') * d;
    return (x - y) * d;
  });
}
function thead(cols, sort, tableId) {
  return '<thead><tr>' + cols.map(c => {
    const s = c.k && sort ? ' sortable' : '';
    const ar = sort && sort.k === c.k ? `<span class="arrow">${sort.d > 0 ? '↑' : '↓'}</span>` : '';
    return `<th class="${c.r ? 'r' : ''}${s}${c.cls ? ' ' + c.cls : ''}" ${c.k ? `data-k="${c.k}"` : ''}>${c.t}${ar}</th>`;
  }).join('') + '</tr></thead>';
}
function bindSort(table, sort, rerender) {
  $$('th.sortable', table).forEach(th => th.onclick = () => {
    if (sort.k === th.dataset.k) sort.d *= -1; else { sort.k = th.dataset.k; sort.d = 1; }
    rerender();
  });
}

/* ---------------- Navegação ---------------- */
let page = 'painel';
function go(p, opts = {}) {
  if (p === 'equipe' && !isAdmin()) p = 'painel';
  if (p === 'equipe') loadMembros();
  page = p;
  $$('.page').forEach(s => s.classList.toggle('active', s.id === 'page-' + p));
  $$('#sideNav button').forEach(b => b.classList.toggle('active', b.dataset.page === p));
  if (opts.local !== undefined) { F.est.local = opts.local; F.est.view = 'local'; }
  if (opts.status) F.est.status = opts.status;
  if (opts.search !== undefined) F.est.q = opts.search;
  if (p === 'estoque' && opts.local === undefined && !opts.keepLocal) F.est.local = F.est.local;
  $('#sidebar').classList.remove('open'); $('#menuBtn').setAttribute('aria-expanded', 'false');
  history.replaceState(null, '', '#' + p);
  closeSheet(true);
  syncTabs();
  renderAll();
  window.scrollTo({top: 0, behavior: 'smooth'});
}


/* ---------------- Barra de navegação mobile ---------------- */
const TABS = ['painel', 'estoque', 'movimentacoes', 'mais'];
const tabOf = p => TABS.includes(p) ? p : 'mais';
let tabIdx = 0;
function moveInd(i, stretch = true) {
  const ind = $('#tbInd');
  if (stretch && i !== tabIdx) { ind.classList.add('stretch'); clearTimeout(moveInd.t); moveInd.t = setTimeout(() => ind.classList.remove('stretch'), 240); }
  placeInd(i);
  $$('#tbPill .tb-btn').forEach((b, j) => { b.classList.toggle('active', j === i); b.setAttribute('aria-selected', j === i); });
  tabIdx = i;
}
const MOBILE_MQ = matchMedia('(max-width:820px),(orientation:landscape) and (max-height:520px) and (pointer:coarse)');
const LAND_MQ = matchMedia('(orientation:landscape) and (max-height:520px) and (pointer:coarse)');
const tabBtns = () => $$('#tbPill .tb-btn');
// posiciona o destaque exatamente sobre a aba (funciona com abas de larguras diferentes)
function placeInd(i) {
  const b = tabBtns()[i], ind = $('#tbInd'); if (!b) return;
  ind.style.width = b.offsetWidth + 'px';
  ind.style.transform = `translateX(${b.offsetLeft}px)`;
}
function pop(i) { const b = $$('#tbPill .tb-btn')[i]; if (!b) return; b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
function syncTabs() { const i = TABS.indexOf(tabOf(page)); if (i !== tabIdx) pop(i); moveInd(i); syncSheetTiles(); }
function pickTab(i) {
  const t = TABS[i];
  if (t === 'mais') { pop(i); moveInd(i); return openSheet(); }
  if (t === page) { pop(i); return window.scrollTo({top: 0, behavior: 'smooth'}); }
  go(t);
}
// arrastar o dedo pela barra desliza o destaque (como no iOS)
(() => {
  const pill = $('#tbPill'), ind = $('#tbInd');
  let drag = null;
  const idxAt = x => {
    let best = 0, bd = Infinity;
    tabBtns().forEach((b, j) => { const r = b.getBoundingClientRect(), d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0; if (d < bd) { bd = d; best = j; } });
    return best;
  };
  pill.addEventListener('pointerdown', e => { drag = {x: e.clientX, moved: false}; try { pill.setPointerCapture(e.pointerId); } catch (_) {} });
  pill.addEventListener('pointermove', e => {
    if (!drag) return;
    if (!drag.moved && Math.abs(e.clientX - drag.x) < 8) return;
    drag.moved = true; ind.classList.add('drag');
    const i = idxAt(e.clientX), bs = tabBtns(), w = bs[i].offsetWidth, r = pill.getBoundingClientRect();
    const first = bs[0].offsetLeft, lastB = bs[bs.length - 1], max = lastB.offsetLeft + lastB.offsetWidth - w;
    const pos = Math.max(first, Math.min(max, e.clientX - r.left - w / 2));
    ind.style.transition = 'scale .3s cubic-bezier(.34,1.45,.5,1), width .3s ease';
    ind.style.width = w + 'px';
    ind.style.transform = `translateX(${pos}px)`; $$('#tbPill .tb-btn').forEach((b, j) => b.classList.toggle('active', j === i));
  });
  const end = e => {
    if (!drag) return;
    const i = idxAt(e.clientX), moved = drag.moved; drag = null;
    ind.classList.remove('drag'); ind.style.transition = '';
    if (e.type === 'pointercancel') return moveInd(tabIdx, false);
    if (moved) { suppress = Date.now(); moveInd(i, false); pickTab(i); }
  };
  let suppress = 0;
  pill.addEventListener('pointerup', end); pill.addEventListener('pointercancel', end);
  // toque simples: tratado no click (evita o "clique fantasma" que fecharia o sheet)
  pill.addEventListener('click', e => { if (Date.now() - suppress < 500) return; const i = idxAt(e.clientX); moveInd(i); pickTab(i); });
})();
$('#tbFab').onclick = () => { const f = $('#tbFab'); f.classList.add('spin'); setTimeout(() => f.classList.remove('spin'), 450); closeSheet(); modalMov(); };
// compacta ao rolar para baixo, expande ao rolar para cima
(() => {
  let last = window.scrollY, ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return; ticking = true;
    requestAnimationFrame(() => {
      const y = window.scrollY, bar = $('#tabbar'), atEnd = y + innerHeight >= document.documentElement.scrollHeight - 30;
      if (y > last + 6 && y > 90 && !atEnd && !LAND_MQ.matches) bar.classList.add('compact');
      else if (y < last - 6 || y < 90) bar.classList.remove('compact');
      last = y; ticking = false;
    });
  }, {passive: true});
  $('#tabbar').addEventListener('click', () => $('#tabbar').classList.remove('compact'));
})();
// esconde a barra enquanto o teclado está aberto
const isField = el => el && el.matches && el.matches('.main input, .main select');
document.addEventListener('focusin', e => { if (isField(e.target) && MOBILE_MQ.matches) $('#tabbar').classList.add('hidden'); });
document.addEventListener('focusout', () => setTimeout(() => { if (!isField(document.activeElement)) $('#tabbar').classList.remove('hidden'); }, 50));

const relayout = () => { $('#tabbar').classList.remove('compact'); placeInd(tabIdx); };
window.addEventListener('resize', relayout);
LAND_MQ.addEventListener && LAND_MQ.addEventListener('change', () => setTimeout(relayout, 60));
$('#tbPill').addEventListener('transitionend', e => { if (e.propertyName === 'height') placeInd(tabIdx); });
document.fonts && document.fonts.ready.then(() => placeInd(tabIdx));

/* Sheet "Mais" */
function syncSheetTiles() { $$('.sheet-tile').forEach(t => t.classList.toggle('active', t.dataset.sheetPage === page)); }
let sheetOpenedAt = 0;
function openSheet() {
  sheetOpenedAt = Date.now();
  const w = $('#sheet'); w.classList.add('open'); w.setAttribute('aria-hidden', 'false');
  $('#sheetPanel').style.transform = ''; $('#sheetPanel').scrollTop = 0;
  syncSheetTiles();
}
function closeSheet(silent) {
  const w = $('#sheet'); if (!w.classList.contains('open')) return;
  w.classList.remove('open'); w.setAttribute('aria-hidden', 'true'); $('#sheetPanel').style.transform = '';
  if (!silent) moveInd(TABS.indexOf(tabOf(page)));
}
$('#sheet').addEventListener('click', e => {
  if (e.target.closest('[data-sheet-close]')) { if (Date.now() - sheetOpenedAt < 400) return; return closeSheet(); }
  const t = e.target.closest('[data-sheet-page], [data-page-go]'); if (t) return go(t.dataset.sheetPage || t.dataset.pageGo);
  const l = e.target.closest('#sheetLocais button'); if (l) return go('estoque', {local: l.dataset.local, status: 'TODOS', search: ''});
  if (e.target.closest('[data-act]')) closeSheet();
});
// arrastar para baixo fecha o sheet
(() => {
  const panel = $('#sheetPanel'); let y0 = null, dy = 0;
  panel.addEventListener('touchstart', e => { if (panel.scrollTop > 0 && !e.target.closest('#grabber')) return; y0 = e.touches[0].clientY; dy = 0; }, {passive: true});
  panel.addEventListener('touchmove', e => {
    if (y0 === null) return; dy = e.touches[0].clientY - y0;
    if (dy <= 0) { panel.classList.remove('dragging'); panel.style.transform = ''; return; }
    panel.classList.add('dragging'); panel.style.transform = `translateY(${dy}px)`;
    if (e.cancelable) e.preventDefault();
  }, {passive: false});
  panel.addEventListener('touchend', () => {
    if (y0 === null) return; panel.classList.remove('dragging');
    if (dy > 110) closeSheet(); else panel.style.transform = '';
    y0 = null;
  });
})();

/* ---------------- Filtros ---------------- */
const F = {
  est: {status: 'TODOS', tipo: 'TODOS', local: '', q: '', view: 'local', sort: {k: 'local', d: 1}},
  mov: {tipo: 'TODOS', local: '', q: '', sort: {k: 'data', d: -1}},
  ins: {un: 'TODOS', q: '', sort: {k: 'id', d: 1}},
  loc: {tipo: 'TODOS'},
};


/* ---------------- Render: equipe (administradores) ---------------- */
F.eq = {status: 'TODOS', q: ''};
function renderEquipe() {
  const f = F.eq;
  if ($('#eqSearch') !== document.activeElement) $('#eqSearch').value = f.q;
  let list = membros.slice();
  const qq = norm(f.q); if (qq) list = list.filter(m => norm(m.nome + ' ' + m.email).includes(qq));
  const cnt = st => list.filter(m => m.status === st).length;
  pills($('#eqStatus'), [{v: 'TODOS', label: 'Todos', count: list.length}, {v: 'pendente', label: 'Pendentes', count: cnt('pendente')}, {v: 'aprovado', label: 'Aprovados', count: cnt('aprovado')}, {v: 'bloqueado', label: 'Bloqueados', count: cnt('bloqueado')}], f.status, v => { f.status = v; renderEquipe(); });
  if (f.status !== 'TODOS') list = list.filter(m => m.status === f.status);
  const order = {pendente: 0, aprovado: 1, bloqueado: 2};
  list.sort((a, b) => order[a.status] - order[b.status] || String(b.criado_em).localeCompare(String(a.criado_em)));
  const t = $('#eqTable');
  t.innerHTML = thead([{t: 'Nome'}, {t: 'E-mail', cls: 'hide-sm'}, {t: 'Status', cls: 'hide-sm'}, {t: 'Função', cls: 'hide-sm'}, {t: 'Desde', cls: 'hide-sm'}, {t: ''}]) + '<tbody>' + (list.map(m => {
    const self = me && m.user_id === me.id, acts = [];
    if (m.status === 'pendente') acts.push(`<button class="mini-btn go" data-m="aprovar">Aprovar</button>`, `<button class="mini-btn stop" data-m="bloquear">Recusar</button>`);
    if (m.status === 'aprovado' && !self) acts.push(m.admin ? `<button class="mini-btn" data-m="rebaixar">Tirar admin</button>` : `<button class="mini-btn" data-m="promover">Tornar admin</button>`, `<button class="mini-btn stop" data-m="bloquear">Bloquear</button>`);
    if (m.status === 'bloqueado') acts.push(`<button class="mini-btn" data-m="aprovar">Desbloquear</button>`);
    return `<tr data-uid="${esc(m.user_id)}"><td class="name">${esc(m.nome || '—')}${self ? ' <span class="muted" style="font-size:11px">(você)</span>' : ''}<div class="eq-mail">${esc(m.email)}</div><div class="eq-mail"><span class="pill ${m.status.toUpperCase()}" style="margin-top:6px">${m.status.toUpperCase()}${m.admin ? ' · ADMIN' : ''}</span></div></td><td class="muted hide-sm">${esc(m.email)}</td><td class="hide-sm"><span class="pill ${m.status.toUpperCase()}">${m.status.toUpperCase()}</span></td><td class="hide-sm">${m.admin ? '<span class="role">ADMIN</span>' : '<span class="muted">Membro</span>'}</td><td class="muted hide-sm num">${m.criado_em ? fmtDate(String(m.criado_em).slice(0, 10)) : '—'}</td><td><div class="member-actions">${acts.join('') || '<span class="muted" style="font-size:12px">—</span>'}</div></td></tr>`;
  }).join('') || '<tr><td colspan="6" class="empty">Ninguém por aqui.</td></tr>') + '</tbody>';
  $$('tbody tr[data-uid]', t).forEach(tr => tr.onclick = async e => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    const m = membros.find(x => x.user_id === tr.dataset.uid); if (!m) return;
    const who = m.nome || m.email, act = b.dataset.m;
    const patch = {aprovar: {status: 'aprovado'}, bloquear: {status: 'bloqueado', admin: false}, promover: {admin: true}, rebaixar: {admin: false}}[act];
    const ask = {bloquear: m.status === 'pendente' ? `Recusar o pedido de ${who}?` : `Bloquear o acesso de ${who}? A pessoa sai do estoque na hora.`, promover: `Tornar ${who} administrador? Essa pessoa poderá aprovar e bloquear outras contas.`, rebaixar: `Tirar a função de administrador de ${who}?`}[act];
    if (ask && !confirm(ask)) return;
    b.disabled = true;
    try {
      await q(sb.from('membros').update(patch).eq('user_id', m.user_id));
      toast({aprovar: `${who} agora tem acesso`, bloquear: `${who} foi bloqueado`, promover: `${who} agora é administrador`, rebaixar: `${who} não é mais administrador`}[act]);
      await loadMembros();
    } catch (err) { b.disabled = false; toast('Não foi possível alterar: ' + errMsg(err), null, true); }
  });
  $('#eqFoot').textContent = `${membros.length} ${membros.length === 1 ? 'conta' : 'contas'} · ${membros.filter(m => m.status === 'pendente').length} aguardando aprovação`;
}

/* ---------------- Render: sidebar ---------------- */
function renderSide(rows) {
  const rep = rows.filter(r => r.status === 'REPOR').length;
  const nb = $('#navRepor'); nb.textContent = rep; nb.classList.toggle('zero', !rep);
  const byLoc = new Map(S.locais.map(l => [l.nome, 0]));
  rows.forEach(r => { if (r.status === 'REPOR') byLoc.set(r.local, (byLoc.get(r.local) || 0) + 1); });
  const tb = $('#tbBadge');
  if (tb.textContent !== String(rep) && tb.textContent !== '') { tb.classList.remove('bump'); void tb.offsetWidth; tb.classList.add('bump'); }
  tb.textContent = rep; tb.classList.toggle('zero', !rep);
  $('#shIns').textContent = S.insumos.length + ' itens';
  $('#shLoc').textContent = S.locais.length + ' salas';
  $('#sheetLocais').innerHTML = S.locais.map(l => { const n = byLoc.get(l.nome) || 0; return `<button data-local="${esc(l.nome)}"><span class="lname">${esc(l.nome)}</span><span class="badge${n ? '' : ' zero'}">${n}</span><span class="chev">›</span></button>`; }).join('');
  $('#sideLocais').innerHTML = S.locais.map(l => {
    const n = byLoc.get(l.nome) || 0, act = page === 'estoque' && F.est.local === l.nome && F.est.view === 'local';
    return `<button data-local="${esc(l.nome)}" class="${act ? 'active' : ''}" title="${esc(l.nome)}"><span class="lname">${esc(l.nome)}</span><span class="badge${n ? '' : ' zero'}">${n}</span></button>`;
  }).join('');
}

/* ---------------- Render: painel ---------------- */
function renderPainel(rows) {
  const d = new Date();
  $('#todayLabel').textContent = d.toLocaleDateString('pt-BR', {weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'});
  const rep = rows.filter(r => r.status === 'REPOR');
  const sum = t => S.movs.filter(m => t.includes(m.tipo)).reduce((a, m) => a + (Number(m.qtd) || 0), 0);
  const kp = [
    {v: rep.length, l: 'Itens para repor', s: `em ${new Set(rep.map(r => r.local)).size} locais`, cls: 'alert', go: ['estoque', {status: 'REPOR', local: ''}]},
    {v: S.insumos.length, l: 'Insumos cadastrados', s: `${S.locais.length} salas e antessalas`, go: ['insumos']},
    {v: S.movs.length, l: 'Movimentações', s: S.movs.length ? 'última em ' + fmtDate(S.movs.reduce((a, m) => m.data > a ? m.data : a, '')) : 'nenhuma ainda', go: ['movimentacoes']},
    {v: sum(['ENTRADA', 'TRANSFERÊNCIA']), l: 'Total de entradas', s: 'inclui transferências recebidas', go: ['movimentacoes']},
    {v: sum(['SAÍDA', 'TRANSFERÊNCIA']), l: 'Total de saídas', s: 'inclui transferências enviadas', go: ['movimentacoes']},
  ];
  $('#kpis').innerHTML = kp.map((k, i) => `<div class="kpi clickable ${k.cls || ''}" data-i="${i}"><span>${k.l}</span><div><strong class="num">${fmt(k.v)}</strong><small>${esc(k.s)}</small></div></div>`).join('');
  $$('#kpis .kpi').forEach(el => el.onclick = () => go(...kp[el.dataset.i].go));

  const al = rep.slice().sort((a, b) => (a.atual - a.min) - (b.atual - b.min) || a.nome.localeCompare(b.nome)).slice(0, 12);
  $('#alertList').innerHTML = al.length ? al.map(r => `<div class="alert-item" data-local="${esc(r.local)}" data-id="${esc(r.id)}"><span class="ai-name">${esc(r.nome)}</span><span class="ai-val">${fmt(r.atual)} / ${fmt(r.min)}<small>falta ${fmt(Math.max(0, r.min - r.atual + 1))} ${esc(r.un)}</small></span><span class="ai-loc">${esc(r.local)} · <span class="mono">${esc(r.id)}</span></span></div>`).join('') + (rep.length > al.length ? `<div class="empty" style="padding:14px 0 0;text-align:left">+ ${rep.length - al.length} itens em reposição</div>` : '')
    : '<div class="empty">Nenhum item abaixo do mínimo. Tudo em ordem ✓</div>';
  $$('#alertList .alert-item').forEach(el => el.onclick = () => go('estoque', {local: el.dataset.local, status: 'TODOS', search: el.dataset.id}));

  const per = S.locais.map(l => {
    const rs = rows.filter(r => r.local === l.nome);
    return {nome: l.nome, n: rs.length, rep: rs.filter(r => r.status === 'REPOR').length, ok: rs.filter(r => r.status === 'OK').length, sem: rs.filter(r => r.status === 'SEM MÍNIMO').length};
  }).filter(p => p.n).sort((a, b) => b.rep - a.rep || b.n - a.n);
  $('#localBars').innerHTML = per.map(p => `<div class="lbar" data-local="${esc(p.nome)}" title="${esc(p.nome)} — ${p.rep} repor · ${p.ok} OK · ${p.sem} sem mínimo"><span class="lt">${esc(p.nome)}</span><span class="lv${p.rep ? '' : ' zero'}">${p.rep}/${p.n}</span><div class="track">${p.rep ? `<b class="s-repor" style="flex:${p.rep}"></b>` : ''}${p.ok ? `<b class="s-ok" style="flex:${p.ok}"></b>` : ''}${p.sem ? `<b class="s-sem" style="flex:${p.sem}"></b>` : ''}</div></div>`).join('') || '<div class="empty">Sem itens cadastrados.</div>';
  $$('#localBars .lbar').forEach(el => el.onclick = () => go('estoque', {local: el.dataset.local, status: 'TODOS', search: ''}));

  const last = S.movs.slice().sort((a, b) => b.data.localeCompare(a.data)).slice(0, 5);
  $('#lastMovs').innerHTML = last.length ? last.map(movItem).join('') : '<div class="empty">Nenhuma movimentação registrada.</div>';
}
function movItem(m) {
  const i = insById().get(m.id) || {nome: m.id, un: ''};
  const sym = m.tipo === 'ENTRADA' ? '+' : m.tipo === 'SAÍDA' ? '−' : '⇄';
  const where = m.tipo === 'TRANSFERÊNCIA' ? `${m.local} → ${m.destino}` : m.local;
  return `<div class="mov-item"><span class="mov-ico ${m.tipo}">${sym}</span><div class="mov-main"><b>${esc(i.nome)}</b><span>${esc(where)}${m.resp ? ' · ' + esc(m.resp) : ''}</span></div><div class="mov-q">${sym === '⇄' ? '' : sym}${fmt(m.qtd)} <small>${fmtDate(m.data)}</small></div></div>`;
}

/* ---------------- Render: estoque ---------------- */
let lastEstView = [];
function renderEstoque(rows) {
  const f = F.est;
  $('#estLocal').innerHTML = localOptions(f.local, true);
  $('#estLocal').disabled = f.view === 'geral';
  if ($('#estSearch') !== document.activeElement) $('#estSearch').value = f.q;
  $$('#estView button').forEach(b => b.classList.toggle('on', b.dataset.v === f.view));

  let base = rows.filter(r => (f.view === 'geral' || !f.local || r.local === f.local) && (f.tipo === 'TODOS' || r.tipo === f.tipo));
  let list = f.view === 'geral' ? consolidate(base) : base;
  const q = norm(f.q);
  if (q) list = list.filter(r => norm(r.nome + ' ' + r.id + ' ' + (r.local || '')).includes(q));
  const cnt = s => list.filter(r => r.status === s).length;
  pills($('#estStatus'), [{v: 'TODOS', label: 'Todos', count: list.length}, {v: 'REPOR', label: 'Repor', count: cnt('REPOR')}, {v: 'OK', label: 'OK', count: cnt('OK')}, {v: 'SEM MÍNIMO', label: 'Sem mínimo', count: cnt('SEM MÍNIMO')}], f.status, v => { f.status = v; renderAll(); });
  pills($('#estTipo'), [{v: 'TODOS', label: 'Salas e antessalas'}, {v: 'Sala', label: 'Salas'}, {v: 'Antessala', label: 'Antessalas'}], f.tipo, v => { f.tipo = v; renderAll(); });
  if (f.status !== 'TODOS') list = list.filter(r => r.status === f.status);
  if (f.view === 'geral' && ['local', 'tipo', 'ent', 'sai'].includes(f.sort.k)) f.sort = {k: 'nome', d: 1};
  sortRows(list, f.sort);
  lastEstView = list;

  const t = $('#estTable');
  if (f.view === 'geral') {
    t.innerHTML = thead([{t: 'ID', k: 'id'}, {t: 'Insumo', k: 'nome'}, {t: 'Un.', k: 'un', cls: 'hide-sm'}, {t: 'Locais', k: 'locais', r: 1}, {t: 'Mínimo total', k: 'min', r: 1, cls: 'hide-sm'}, {t: 'Estoque atual', k: 'atual', r: 1}, {t: 'Locais p/ repor', k: 'repor', r: 1}, {t: 'Status', k: 'status'}], f.sort) +
      '<tbody>' + (list.map(r => `<tr><td class="id">${esc(r.id)}</td><td class="name">${esc(r.nome)}</td><td class="muted hide-sm">${esc(r.un)}</td><td class="r num">${r.locais}</td><td class="r num muted hide-sm">${r.min === null ? '—' : fmt(r.min)}</td><td class="r">${meter(r.atual, r.min)}</td><td class="r num">${r.repor ? `<span style="color:#ff7a68">${r.repor}</span>` : '<span class="muted">0</span>'}</td><td>${statusPill(r.status)}</td></tr>`).join('') || `<tr><td colspan="8" class="empty">Nenhum item encontrado.</td></tr>`) + '</tbody>';
  } else {
    t.innerHTML = thead([{t: 'Local', k: 'local'}, {t: 'ID', k: 'id'}, {t: 'Insumo', k: 'nome'}, {t: 'Un.', k: 'un', cls: 'hide-sm'}, {t: 'Inicial', k: 'ini', r: 1, cls: 'hide-sm hide-md'}, {t: 'Entradas', k: 'ent', r: 1, cls: 'hide-sm'}, {t: 'Saídas', k: 'sai', r: 1, cls: 'hide-sm'}, {t: 'Mínimo', k: 'min', r: 1}, {t: 'Atual', k: 'atual', r: 1}, {t: 'Status', k: 'status'}, {t: ''}], f.sort) +
      '<tbody>' + (list.map(r => `<tr data-idx="${r.idx}"><td class="loc">${esc(r.local)}</td><td class="id">${esc(r.id)}</td><td class="name">${esc(r.nome)}</td><td class="muted hide-sm">${esc(r.un)}</td><td class="r num muted hide-sm hide-md">${fmt(r.ini)}</td><td class="r num hide-sm">${r.ent ? '+' + fmt(r.ent) : '<span class="muted">0</span>'}</td><td class="r num hide-sm">${r.sai ? '−' + fmt(r.sai) : '<span class="muted">0</span>'}</td><td class="r num muted">${r.min === null ? '—' : fmt(r.min)}</td><td class="r">${meter(r.atual, r.min)}</td><td>${statusPill(r.status)}</td><td><div class="row-actions"><button class="icon-btn" data-a="mov" title="Movimentar">${ICON.mov}</button><button class="icon-btn" data-a="edit" title="Editar / contagem física">${ICON.edit}</button><button class="icon-btn del" data-a="del" title="Remover do local">${ICON.del}</button></div></td></tr>`).join('') || `<tr><td colspan="11" class="empty">Nenhum item encontrado.</td></tr>`) + '</tbody>';
    $$('tbody tr[data-idx]', t).forEach(tr => tr.onclick = e => {
      const b = e.target.closest('button[data-a]'); const idx = +tr.dataset.idx;
      if (!b) return;
      const e0 = S.estoque[idx];
      if (b.dataset.a === 'edit') modalVinculo(idx);
      if (b.dataset.a === 'mov') modalMov(null, {local: e0.local, id: e0.id});
      if (b.dataset.a === 'del') {
        const nm = (insById().get(e0.id) || {}).nome;
        if (confirm(`Remover "${nm}" de ${e0.local}?\nO histórico de movimentações é mantido.`)) commit('Item removido do local', () => S.estoque.splice(idx, 1));
      }
    });
  }
  bindSort(t, f.sort, renderAll);
  const tot = list.reduce((a, r) => a + r.atual, 0);
  $('#estFoot').textContent = `${list.length} ${list.length === 1 ? 'item' : 'itens'} · ${fmt(tot)} unidades em estoque` + (f.view === 'local' && f.local ? ` · ${f.local}` : '');
}

/* ---------------- Render: movimentações ---------------- */
function renderMovs() {
  const f = F.mov, ib = insById();
  $('#movLocal').innerHTML = localOptions(f.local, true);
  if ($('#movSearch') !== document.activeElement) $('#movSearch').value = f.q;
  let list = S.movs.map(m => ({...m, nome: (ib.get(m.id) || {}).nome || m.id, un: (ib.get(m.id) || {}).un || ''}));
  if (f.local) list = list.filter(m => m.local === f.local || m.destino === f.local);
  const q = norm(f.q);
  if (q) list = list.filter(m => norm([m.nome, m.id, m.resp, m.obs, m.local, m.destino].join(' ')).includes(q));
  const cnt = t => list.filter(m => m.tipo === t).length;
  pills($('#movTipo'), [{v: 'TODOS', label: 'Todas', count: list.length}, ...TIPOS.map(t => ({v: t, label: t[0] + t.slice(1).toLowerCase(), count: cnt(t)}))], f.tipo, v => { f.tipo = v; renderAll(); });
  if (f.tipo !== 'TODOS') list = list.filter(m => m.tipo === f.tipo);
  sortRows(list, f.sort);
  const t = $('#movTable');
  t.innerHTML = thead([{t: 'Data', k: 'data'}, {t: 'Tipo', k: 'tipo'}, {t: 'Insumo', k: 'nome'}, {t: 'Qtd.', k: 'qtd', r: 1}, {t: 'Local', k: 'local'}, {t: 'Destino', k: 'destino', cls: 'hide-sm'}, {t: 'Responsável', k: 'resp', cls: 'hide-sm'}, {t: 'Observações', cls: 'hide-sm'}, {t: ''}], f.sort) +
    '<tbody>' + (list.map(m => `<tr data-uid="${m.uid}"><td class="num" style="white-space:nowrap">${fmtDate(m.data)}</td><td><span class="pill ${m.tipo}">${m.tipo}</span></td><td class="name">${esc(m.nome)}<div class="id" style="font:400 11px var(--mono);color:#777">${esc(m.id)}</div></td><td class="r num"><strong>${fmt(m.qtd)}</strong> <span class="muted" style="font-size:11px">${esc(m.un)}</span></td><td class="loc">${esc(m.local)}</td><td class="loc hide-sm">${esc(m.destino) || '<span class="muted">—</span>'}</td><td class="hide-sm">${esc(m.resp) || '<span class="muted">—</span>'}${m.por ? `<div style="font-size:11px;color:#6f6f6b" title="Registrado por">${esc(m.por)}</div>` : ''}</td><td class="muted hide-sm" style="max-width:220px">${esc(m.obs) || '—'}</td><td><div class="row-actions"><button class="icon-btn" data-a="edit" title="Editar">${ICON.edit}</button><button class="icon-btn del" data-a="del" title="Excluir">${ICON.del}</button></div></td></tr>`).join('') || '<tr><td colspan="9" class="empty">Nenhuma movimentação encontrada.</td></tr>') + '</tbody>';
  $$('tbody tr[data-uid]', t).forEach(tr => tr.onclick = e => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const i = S.movs.findIndex(m => m.uid === tr.dataset.uid);
    if (b.dataset.a === 'edit') modalMov(i);
    if (b.dataset.a === 'del' && confirm('Excluir esta movimentação? O saldo será recalculado.')) commit('Movimentação excluída', () => S.movs.splice(i, 1));
  });
  bindSort(t, f.sort, renderAll);
  $('#movFoot').textContent = `${list.length} ${list.length === 1 ? 'movimentação' : 'movimentações'} · ${fmt(list.reduce((a, m) => a + (Number(m.qtd) || 0), 0))} unidades movimentadas`;
}

/* ---------------- Render: insumos ---------------- */
function renderInsumos(rows) {
  const f = F.ins;
  if ($('#insSearch') !== document.activeElement) $('#insSearch').value = f.q;
  const agg = new Map(consolidate(rows).map(c => [c.id, c]));
  let list = S.insumos.map(i => { const c = agg.get(i.id); return {...i, locais: c ? c.locais : 0, atual: c ? c.atual : 0, repor: c ? c.repor : 0}; });
  const q = norm(f.q);
  if (q) list = list.filter(i => norm(i.nome + ' ' + i.id).includes(q));
  const uns = [...new Set(S.insumos.map(i => i.un).filter(Boolean))].sort();
  pills($('#insUn'), [{v: 'TODOS', label: 'Todas as unidades', count: list.length}, ...uns.map(u => ({v: u, label: u, count: list.filter(i => i.un === u).length}))], f.un, v => { f.un = v; renderAll(); });
  if (f.un !== 'TODOS') list = list.filter(i => i.un === f.un);
  sortRows(list, f.sort);
  const t = $('#insTable');
  t.innerHTML = thead([{t: 'ID', k: 'id'}, {t: 'Insumo', k: 'nome'}, {t: 'Unidade', k: 'un'}, {t: 'Locais', k: 'locais', r: 1}, {t: 'Estoque total', k: 'atual', r: 1}, {t: 'Em reposição', k: 'repor', r: 1, cls: 'hide-sm'}, {t: ''}], f.sort) +
    '<tbody>' + (list.map(i => `<tr data-id="${esc(i.id)}"><td class="id">${esc(i.id)}</td><td class="name">${esc(i.nome)}</td><td class="muted">${esc(i.un)}</td><td class="r num">${i.locais || '<span class="muted">0</span>'}</td><td class="r num"><strong>${fmt(i.atual)}</strong></td><td class="r num hide-sm">${i.repor ? `<span class="pill REPOR">${i.repor} ${i.repor > 1 ? 'locais' : 'local'}</span>` : '<span class="muted">—</span>'}</td><td><div class="row-actions"><button class="icon-btn" data-a="see" title="Ver no estoque">${ICON.mov}</button><button class="icon-btn" data-a="edit" title="Editar">${ICON.edit}</button><button class="icon-btn del" data-a="del" title="Excluir">${ICON.del}</button></div></td></tr>`).join('') || '<tr><td colspan="7" class="empty">Nenhum insumo encontrado.</td></tr>') + '</tbody>';
  $$('tbody tr[data-id]', t).forEach(tr => tr.onclick = e => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const id = tr.dataset.id;
    if (b.dataset.a === 'edit') modalInsumo(id);
    if (b.dataset.a === 'see') { F.est.view = 'local'; go('estoque', {local: '', status: 'TODOS', search: id}); }
    if (b.dataset.a === 'del') {
      const uses = S.estoque.filter(e => e.id === id).length, movs = S.movs.filter(m => m.id === id).length;
      if (movs) return toast(`Este insumo tem ${movs} movimentação(ões) e não pode ser excluído.`, null, true);
      if (confirm(`Excluir o insumo ${id}?` + (uses ? `\nEle também será removido de ${uses} local(is).` : ''))) commit('Insumo excluído', () => { S.insumos = S.insumos.filter(i => i.id !== id); S.estoque = S.estoque.filter(e => e.id !== id); });
    }
  });
  bindSort(t, f.sort, renderAll);
  $('#insFoot').textContent = `${list.length} de ${S.insumos.length} insumos`;
}

/* ---------------- Render: locais ---------------- */
function renderLocais(rows) {
  const f = F.loc;
  pills($('#locTipo'), [{v: 'TODOS', label: 'Todos', count: S.locais.length}, {v: 'Sala', label: 'Salas', count: S.locais.filter(l => l.tipo === 'Sala').length}, {v: 'Antessala', label: 'Antessalas', count: S.locais.filter(l => l.tipo === 'Antessala').length}], f.tipo, v => { f.tipo = v; renderAll(); });
  const ls = S.locais.filter(l => f.tipo === 'TODOS' || l.tipo === f.tipo);
  $('#locGrid').innerHTML = ls.map((l, i) => {
    const rs = rows.filter(r => r.local === l.nome), rep = rs.filter(r => r.status === 'REPOR').length, ok = rs.filter(r => r.status === 'OK').length, sem = rs.length - rep - ok;
    return `<div class="loc-card" data-local="${esc(l.nome)}" style="animation-delay:${i * 30}ms"><div class="row-actions"><button class="icon-btn" data-a="edit" title="Editar">${ICON.edit}</button><button class="icon-btn del" data-a="del" title="Excluir">${ICON.del}</button></div><div><span class="eyebrow">${esc(l.tipo)}</span><h3>${esc(l.nome)}</h3></div><div class="track" title="${rep} repor · ${ok} OK · ${sem} sem mínimo">${rep ? `<b class="s-repor" style="flex:${rep}"></b>` : ''}${ok ? `<b class="s-ok" style="flex:${ok}"></b>` : ''}${sem ? `<b class="s-sem" style="flex:${sem}"></b>` : ''}</div><div class="loc-stats"><div><strong>${rs.length}</strong><span>Itens</span></div><div><strong class="${rep ? 'red' : ''}">${rep}</strong><span>Repor</span></div><div><strong>${fmt(rs.reduce((a, r) => a + r.atual, 0))}</strong><span>Unidades</span></div></div></div>`;
  }).join('') || '<div class="empty">Nenhum local.</div>';
  $$('#locGrid .loc-card').forEach(c => c.onclick = e => {
    const b = e.target.closest('button[data-a]'), nome = c.dataset.local;
    if (!b) return go('estoque', {local: nome, status: 'TODOS', search: ''});
    if (b.dataset.a === 'edit') modalLocal(nome);
    if (b.dataset.a === 'del') {
      const used = S.estoque.some(e => e.local === nome) || S.movs.some(m => m.local === nome || m.destino === nome);
      if (used) return toast('Este local tem itens ou movimentações e não pode ser excluído.', null, true);
      if (confirm(`Excluir o local ${nome}?`)) commit('Local excluído', () => S.locais = S.locais.filter(l => l.nome !== nome));
    }
  });
}

function renderAll() {
  const rows = compute();
  renderSide(rows);
  if (page === 'painel') renderPainel(rows);
  if (page === 'estoque') renderEstoque(rows);
  if (page === 'movimentacoes') renderMovs();
  if (page === 'insumos') renderInsumos(rows);
  if (page === 'locais') renderLocais(rows);
  if (page === 'equipe') renderEquipe();
}

/* ---------------- Modais ---------------- */
function openModal(html, onReady) {
  $('#modal').innerHTML = html;
  $('#overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  $('#modal .close').onclick = closeModal;
  $$('#modal [data-close]').forEach(b => b.onclick = closeModal);
  onReady && onReady($('#modal'));
  setTimeout(() => { const f = $('#modal [autofocus]') || $('#modal input,#modal select'); f && f.focus(); }, 60);
}
function closeModal() { $('#overlay').classList.remove('open'); document.body.style.overflow = ''; }
const head = (eyebrow, title) => `<div class="modal-head"><div><span class="eyebrow">${eyebrow}</span><h2>${title}</h2></div><button class="close" type="button">Fechar ✕</button></div>`;
const insDatalist = () => '<datalist id="dlIns">' + S.insumos.map(i => `<option value="${esc(i.id)} — ${esc(i.nome)}"></option>`).join('') + '</datalist>';
function parseIns(v) {
  v = String(v || '').trim(); if (!v) return null;
  const id = v.split(' — ')[0].trim().toUpperCase();
  return S.insumos.find(i => i.id.toUpperCase() === id) || S.insumos.find(i => norm(i.nome) === norm(v)) || null;
}

function modalMov(index = null, preset = {}) {
  const editing = index !== null && index >= 0;
  const m = editing ? {...S.movs[index]} : {data: todayISO(), tipo: preset.tipo || 'SAÍDA', local: preset.local || F.est.local || '', id: preset.id || '', qtd: '', resp: localStorage.getItem(KEY + '-resp') || (membro && membro.nome ? membro.nome.toUpperCase() : me ? me.email.split('@')[0].toUpperCase() : ''), obs: '', destino: ''};
  const ins = m.id ? insById().get(m.id) : null;
  openModal(head(editing ? 'Editar' : 'Nova', 'Movimentação') + `
  <form class="form" id="fMov" autocomplete="off">
    <label class="full">Tipo<div class="seg" id="segTipo">${TIPOS.map(t => `<button type="button" data-v="${t}" class="${t === m.tipo ? 'on' : ''}">${t[0] + t.slice(1).toLowerCase()}</button>`).join('')}</div></label>
    <label class="full">Insumo<input name="ins" list="dlIns" required placeholder="Digite o nome ou ID" value="${ins ? esc(ins.id + ' — ' + ins.nome) : ''}" ${m.id ? '' : 'autofocus'}>${insDatalist()}</label>
    <label id="lblLocal">Local<select name="local" required><option value="">Selecione…</option>${localOptions(m.local, false)}</select></label>
    <label id="lblDestino">Destino<select name="destino"><option value="">Selecione…</option>${localOptions(m.destino, false)}</select></label>
    <label>Quantidade<input name="qtd" type="number" min="1" step="any" required value="${esc(m.qtd)}" ${m.id ? 'autofocus' : ''}></label>
    <label>Data<input name="data" type="date" required value="${esc(m.data)}"></label>
    <div class="hint" id="movHint"></div>
    <label class="full">Responsável<input name="resp" value="${esc(m.resp)}" placeholder="Nome de quem movimentou"></label>
    <label class="full">Observações<textarea name="obs" rows="2" placeholder="Opcional">${esc(m.obs)}</textarea></label>
    <div class="error" id="movErr"></div>
    <div class="form-actions"><span class="muted" style="font-size:12px;color:#777">Se o insumo ainda não existir no local, ele é adicionado automaticamente.</span><div class="right"><button class="btn ghost" type="button" data-close>Cancelar</button><button class="btn accent" type="submit">${editing ? 'Salvar alterações' : 'Registrar'}</button></div></div>
  </form>`, root => {
    const fm = $('#fMov', root);
    let tipo = m.tipo;
    const upd = () => {
      $('#lblDestino', root).style.display = tipo === 'TRANSFERÊNCIA' ? '' : 'none';
      $('#lblLocal', root).firstChild.textContent = tipo === 'TRANSFERÊNCIA' ? 'Origem' : 'Local';
      if (tipo !== 'TRANSFERÊNCIA') $('#lblLocal', root).style.gridColumn = '1/-1'; else $('#lblLocal', root).style.gridColumn = '';
      const i = parseIns(fm.ins.value), loc = fm.local.value, q = Number(fm.qtd.value) || 0;
      let h = '';
      if (i && loc) {
        let s = saldo(loc, i.id);
        if (editing) { const o = S.movs[index]; if (o.id === i.id && s !== null) { if (o.local === loc && o.tipo !== 'ENTRADA') s += Number(o.qtd); if ((o.tipo === 'ENTRADA' && o.local === loc) || (o.tipo === 'TRANSFERÊNCIA' && o.destino === loc)) s -= Number(o.qtd); } }
        const after = s === null ? null : tipo === 'ENTRADA' ? s + q : s - q;
        h = `<span>Saldo em ${esc(loc)}: <b>${s === null ? 'não cadastrado' : fmt(s) + ' ' + esc(i.un)}</b></span>`;
        if (q && s !== null) h += `<span>Após: <b class="${after < 0 ? 'warn' : ''}">${fmt(after)}</b></span>`;
        if (tipo === 'TRANSFERÊNCIA' && fm.destino.value) { const d = saldo(fm.destino.value, i.id); h += `<span>Destino: <b>${d === null ? 'novo' : fmt(d)}${q ? ' → ' + fmt((d || 0) + q) : ''}</b></span>`; }
      }
      $('#movHint', root).innerHTML = h;
    };
    $('#segTipo', root).onclick = e => { const b = e.target.closest('button'); if (!b) return; tipo = b.dataset.v; $$('#segTipo button', root).forEach(x => x.classList.toggle('on', x === b)); upd(); };
    fm.oninput = upd; fm.onchange = upd; upd();
    fm.onsubmit = e => {
      e.preventDefault();
      const err = t => $('#movErr', root).textContent = t;
      const i = parseIns(fm.ins.value);
      if (!i) return err('Selecione um insumo válido da lista.');
      if (!fm.local.value) return err('Selecione o local.');
      const q = Number(fm.qtd.value);
      if (!(q > 0)) return err('Informe uma quantidade maior que zero.');
      if (tipo === 'TRANSFERÊNCIA' && !fm.destino.value) return err('Selecione o local de destino.');
      if (tipo === 'TRANSFERÊNCIA' && fm.destino.value === fm.local.value) return err('Origem e destino precisam ser diferentes.');
      if (tipo !== 'ENTRADA') {
        let s = saldo(fm.local.value, i.id);
        if (editing) { const o = S.movs[index]; if (o.id === i.id && o.local === fm.local.value && o.tipo !== 'ENTRADA') s += Number(o.qtd); }
        if ((s ?? 0) - q < 0 && !confirm(`O saldo em ${fm.local.value} ficará negativo (${fmt((s ?? 0) - q)}). Registrar mesmo assim?`)) return;
      }
      const rec = {uid: editing ? S.movs[index].uid : uid(), data: fm.data.value, local: fm.local.value, id: i.id, tipo, qtd: q, resp: fm.resp.value.trim().toUpperCase(), obs: fm.obs.value.trim(), destino: tipo === 'TRANSFERÊNCIA' ? fm.destino.value : ''};
      try { localStorage.setItem(KEY + '-resp', rec.resp); } catch (_) {}
      commit(editing ? 'Movimentação atualizada' : `${tipo[0] + tipo.slice(1).toLowerCase()} registrada`, () => {
        if (editing) S.movs[index] = rec; else S.movs.push(rec);
        ensureVinculo(rec.local, rec.id); if (rec.destino) ensureVinculo(rec.destino, rec.id);
      });
      closeModal();
    };
  });
}
function ensureVinculo(local, id) {
  if (!S.estoque.some(e => e.local === local && e.id === id)) S.estoque.push({local, id, ini: 0, min: null});
}

function modalVinculo(idx = null) {
  const editing = idx !== null;
  const e = editing ? S.estoque[idx] : {local: F.est.local || '', id: '', ini: 0, min: null};
  const ins = e.id ? insById().get(e.id) : null;
  const atual = editing ? compute().find(r => r.idx === idx).atual : 0;
  openModal(head(editing ? esc(e.local) : 'Estoque', editing ? esc(ins ? ins.nome : e.id) : 'Adicionar insumo a um local') + `
  <form class="form" id="fVin" autocomplete="off">
    ${editing ? '' : `<label class="full">Insumo<input name="ins" list="dlIns" required placeholder="Digite o nome ou ID" autofocus>${insDatalist()}</label>
    <label class="full">Local<select name="local" required><option value="">Selecione…</option>${localOptions(e.local, false)}</select></label>`}
    <label>Estoque inicial<input name="ini" type="number" step="any" min="0" value="${esc(e.ini)}"></label>
    <label>Estoque mínimo<input name="min" type="number" step="any" min="0" value="${e.min === null ? '' : esc(e.min)}" placeholder="Vazio = sem mínimo"></label>
    ${editing ? `<div class="hint"><span>Saldo atual: <b>${fmt(atual)} ${esc(ins ? ins.un : '')}</b></span><span>Entradas/saídas vêm das movimentações.</span></div>
    <label class="full">Contagem física (opcional)<input name="contagem" type="number" step="any" min="0" placeholder="Informe a quantidade contada para ajustar o saldo"></label>` : ''}
    <div class="error" id="vinErr"></div>
    <div class="form-actions"><div class="right"><button class="btn ghost" type="button" data-close>Cancelar</button><button class="btn accent" type="submit">Salvar</button></div></div>
  </form>`, root => {
    const fm = $('#fVin', root);
    fm.onsubmit = ev => {
      ev.preventDefault();
      const err = t => $('#vinErr', root).textContent = t;
      const min = fm.min.value === '' ? null : Number(fm.min.value);
      let ini = Number(fm.ini.value) || 0;
      if (editing) {
        if (fm.contagem.value !== '') { const c = Number(fm.contagem.value); ini = ini + (c - atual); }
        commit('Item atualizado', () => { S.estoque[idx] = {...S.estoque[idx], ini, min}; });
      } else {
        const i = parseIns(fm.ins.value);
        if (!i) return err('Selecione um insumo válido da lista.');
        if (!fm.local.value) return err('Selecione o local.');
        if (S.estoque.some(x => x.local === fm.local.value && x.id === i.id)) return err('Este insumo já está cadastrado neste local.');
        commit('Insumo adicionado ao local', () => S.estoque.push({local: fm.local.value, id: i.id, ini, min}));
      }
      closeModal();
    };
  });
}

function modalInsumo(id = null) {
  const i = id ? S.insumos.find(x => x.id === id) : {id: nextId(), nome: '', un: 'UNIDADE'};
  const uns = [...new Set([...UNIDADES, ...S.insumos.map(x => x.un)].filter(Boolean))].sort();
  openModal(head(id ? 'Editar insumo' : 'Novo insumo', id ? esc(i.nome) : 'Cadastrar insumo') + `
  <form class="form" id="fIns" autocomplete="off">
    <label>ID<input name="id" value="${esc(i.id)}" readonly style="color:#999;font-family:var(--mono)"></label>
    <label>Unidade<input name="un" list="dlUn" value="${esc(i.un)}" required><datalist id="dlUn">${uns.map(u => `<option value="${esc(u)}">`).join('')}</datalist></label>
    <label class="full">Nome do insumo<input name="nome" value="${esc(i.nome)}" required autofocus placeholder="Ex.: PONTEIRAS P200 µL COM FILTRO"></label>
    ${id ? '' : `<label>Adicionar ao local (opcional)<select name="local"><option value="">—</option>${localOptions('', false)}</select></label><label>Estoque inicial<input name="ini" type="number" min="0" step="any" placeholder="0"></label><label>Estoque mínimo<input name="min" type="number" min="0" step="any" placeholder="Vazio = sem mínimo"></label>`}
    <div class="error" id="insErr"></div>
    <div class="form-actions"><div class="right"><button class="btn ghost" type="button" data-close>Cancelar</button><button class="btn accent" type="submit">Salvar</button></div></div>
  </form>`, root => {
    const fm = $('#fIns', root);
    fm.onsubmit = ev => {
      ev.preventDefault();
      const nome = fm.nome.value.trim().toUpperCase(), un = fm.un.value.trim().toUpperCase();
      if (!nome) return $('#insErr', root).textContent = 'Informe o nome.';
      if (S.insumos.some(x => x.id !== i.id && norm(x.nome) === norm(nome))) return $('#insErr', root).textContent = 'Já existe um insumo com este nome.';
      commit(id ? 'Insumo atualizado' : 'Insumo cadastrado', () => {
        if (id) Object.assign(S.insumos.find(x => x.id === id), {nome, un});
        else {
          S.insumos.push({id: i.id, nome, un});
          S.insumos.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
          if (fm.local.value) S.estoque.push({local: fm.local.value, id: i.id, ini: Number(fm.ini.value) || 0, min: fm.min.value === '' ? null : Number(fm.min.value)});
        }
      });
      closeModal();
    };
  });
}

function modalLocal(nome = null) {
  const l = nome ? S.locais.find(x => x.nome === nome) : {nome: '', tipo: 'Sala'};
  openModal(head(nome ? 'Editar local' : 'Novo local', nome ? esc(nome) : 'Cadastrar local') + `
  <form class="form" id="fLoc" autocomplete="off">
    <label class="full">Nome<input name="nome" value="${esc(l.nome)}" required autofocus placeholder="Ex.: SALA DE MICROSCOPIA"></label>
    <label class="full">Tipo<div class="seg" id="segLT">${['Sala', 'Antessala'].map(t => `<button type="button" data-v="${t}" class="${t === l.tipo ? 'on' : ''}" style="${t === l.tipo ? 'background:var(--text);color:#111;border-color:var(--text)' : ''}">${t}</button>`).join('')}</div></label>
    <div class="error" id="locErr"></div>
    <div class="form-actions"><div class="right"><button class="btn ghost" type="button" data-close>Cancelar</button><button class="btn accent" type="submit">Salvar</button></div></div>
  </form>`, root => {
    let tipo = l.tipo;
    $('#segLT', root).onclick = e => { const b = e.target.closest('button'); if (!b) return; tipo = b.dataset.v; $$('#segLT button', root).forEach(x => { const on = x === b; x.classList.toggle('on', on); x.style.cssText = on ? 'background:var(--text);color:#111;border-color:var(--text)' : ''; }); };
    $('#fLoc', root).onsubmit = ev => {
      ev.preventDefault();
      const nv = ev.target.nome.value.trim().toUpperCase();
      if (!nv) return;
      if (S.locais.some(x => x.nome === nv && x.nome !== nome)) return $('#locErr', root).textContent = 'Já existe um local com este nome.';
      commit(nome ? 'Local atualizado' : 'Local cadastrado', () => {
        if (nome) {
          Object.assign(S.locais.find(x => x.nome === nome), {nome: nv, tipo});
          if (nv !== nome) { S.estoque.forEach(e => { if (e.local === nome) e.local = nv; }); S.movs.forEach(m => { if (m.local === nome) m.local = nv; if (m.destino === nome) m.destino = nv; }); if (F.est.local === nome) F.est.local = nv; }
        } else S.locais.push({nome: nv, tipo});
      });
      closeModal();
    };
  });
}

/* ---------------- Excel / backup ---------------- */
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
const stamp = () => todayISO();
function needXLSX() { if (!window.XLSX) { toast('Biblioteca de Excel não carregou — verifique a conexão.', null, true); return false; } return true; }
function sheet(rows, widths) { const ws = XLSX.utils.json_to_sheet(rows); if (widths) ws['!cols'] = widths.map(w => ({wch: w})); return ws; }
function exportXlsx() {
  if (!needXLSX()) return;
  const rows = compute(), ib = insById();
  const wb = XLSX.utils.book_new();
  const rep = rows.filter(r => r.status === 'REPOR');
  XLSX.utils.book_append_sheet(wb, sheet([
    {INDICADOR: 'INSUMOS CADASTRADOS', VALOR: S.insumos.length},
    {INDICADOR: 'MOVIMENTAÇÕES REGISTRADAS', VALOR: S.movs.length},
    {INDICADOR: 'ITENS PARA REPOR', VALOR: rep.length},
    {INDICADOR: 'TOTAL DE SAÍDAS', VALOR: S.movs.filter(m => m.tipo !== 'ENTRADA').reduce((a, m) => a + Number(m.qtd), 0)},
    {INDICADOR: 'TOTAL DE ENTRADAS', VALOR: S.movs.filter(m => m.tipo !== 'SAÍDA').reduce((a, m) => a + Number(m.qtd), 0)},
    {INDICADOR: 'GERADO EM', VALOR: new Date().toLocaleString('pt-BR')},
  ], [30, 22]), 'DASHBOARD');
  XLSX.utils.book_append_sheet(wb, sheet(S.movs.slice().sort((a, b) => a.data.localeCompare(b.data)).map(m => ({DATA: m.data ? new Date(m.data + 'T12:00:00') : '', LOCAL: m.local, ID_INSUMO: m.id, NOME_INSUMO: (ib.get(m.id) || {}).nome || '', UNIDADE: (ib.get(m.id) || {}).un || '', TIPO: m.tipo, QUANTIDADE: Number(m.qtd), 'RESPONSÁVEL': m.resp, 'OBSERVAÇÕES': m.obs || 'N/A', DESTINO: m.destino})), [12, 32, 11, 40, 10, 15, 12, 16, 30, 32]), 'MOVIMENTAÇÕES');
  XLSX.utils.book_append_sheet(wb, sheet(S.insumos.map(i => ({ID_INSUMO: i.id, NOME_INSUMO: i.nome, UNIDADE: i.un})), [11, 45, 10]), 'INSUMOS');
  XLSX.utils.book_append_sheet(wb, sheet(S.locais.map(l => ({LOCAL: l.nome, TIPO_LOCAL: l.tipo})), [40, 12]), 'LOCAIS');
  XLSX.utils.book_append_sheet(wb, sheet(rows.map(r => ({LOCAL: r.local, TIPO_LOCAL: r.tipo, ID_INSUMO: r.id, NOME_INSUMO: r.nome, UNIDADE: r.un, ESTOQUE_INICIAL: r.ini, ESTOQUE_MINIMO: r.min === null ? '' : r.min, ENTRADAS: r.ent, SAIDAS: r.sai, ESTOQUE_ATUAL: r.atual, STATUS: r.status})), [32, 11, 11, 40, 10, 9, 9, 9, 9, 9, 12]), 'ESTOQUE');
  XLSX.utils.book_append_sheet(wb, sheet(rep.map(r => ({SALA: r.local, ID: r.id, INSUMO: r.nome, 'ESTOQUE TOTAL': r.atual, 'ESTOQUE MINIMO': r.min})), [32, 10, 40, 14, 14]), 'ALERTAS DE REPOSIÇÃO');
  XLSX.writeFile(wb, `CONTROLE_DE_ESTOQUE_${stamp()}.xlsx`, {cellDates: true});
  toast('Planilha exportada');
}
function exportView() {
  if (!needXLSX()) return;
  const geral = F.est.view === 'geral';
  const data = lastEstView.map(r => geral ? {ID_INSUMO: r.id, NOME_INSUMO: r.nome, UNIDADE: r.un, LOCAIS: r.locais, ESTOQUE_MINIMO_TOTAL: r.min ?? '', ESTOQUE_ATUAL: r.atual, STATUS: r.status} : {LOCAL: r.local, ID_INSUMO: r.id, NOME_INSUMO: r.nome, UNIDADE: r.un, ESTOQUE_INICIAL: r.ini, ENTRADAS: r.ent, SAIDAS: r.sai, ESTOQUE_MINIMO: r.min ?? '', ESTOQUE_ATUAL: r.atual, STATUS: r.status});
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, sheet(data), 'CONSULTA');
  XLSX.writeFile(wb, `CONSULTA_ESTOQUE_${stamp()}.xlsx`); toast('Consulta exportada');
}
function exportJson() { download(new Blob([JSON.stringify({app: 'pasteur-estoque', version: 1, exportedAt: new Date().toISOString(), data: S}, null, 1)], {type: 'application/json'}), `backup-estoque-${stamp()}.json`); toast('Backup baixado'); }

/* Importa a planilha original OU a exportada por esta plataforma. */
function rowsWithHeader(ws, mustHave) {
  const a = XLSX.utils.sheet_to_json(ws, {header: 1, defval: null, raw: true});
  const hi = a.findIndex(r => r && mustHave.every(h => r.some(c => norm(c) === norm(h))));
  if (hi < 0) return [];
  const hdr = a[hi].map(c => norm(c).trim());
  return a.slice(hi + 1).map(r => { const o = {}; hdr.forEach((h, i) => { if (h) o[h] = r[i]; }); return o; });
}
const findSheet = (wb, name) => { const k = wb.SheetNames.find(n => norm(n).replace(/\s/g, '') === norm(name).replace(/\s/g, '')); return k ? wb.Sheets[k] : null; };
const str = v => v === null || v === undefined ? '' : String(v).trim();
function toISO(v) {
  if (v instanceof Date) { const d = new Date(v.getTime() - v.getTimezoneOffset() * 60000); return d.toISOString().slice(0, 10); }
  if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); return d ? `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` : ''; }
  const s = str(v); const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}
function importWorkbook(buf) {
  const wb = XLSX.read(buf, {type: 'array', cellDates: true});
  const insS = findSheet(wb, 'INSUMOS'), estS = findSheet(wb, 'ESTOQUE'), movS = findSheet(wb, 'MOVIMENTAÇÕES'), locS = findSheet(wb, 'LOCAIS');
  if (!insS || !estS) throw new Error('A planilha precisa das abas INSUMOS e ESTOQUE.');
  const insumos = [], seen = new Set();
  for (const r of rowsWithHeader(insS, ['ID_INSUMO', 'NOME_INSUMO'])) {
    const id = str(r.id_insumo), nome = str(r.nome_insumo);
    if (!id || !nome || id === 'N/A' || /^_+$/.test(id) || seen.has(id)) continue;
    seen.add(id); insumos.push({id, nome, un: str(r.unidade)});
  }
  let locais = [];
  const lrows = locS ? rowsWithHeader(locS, ['LOCAL', 'TIPO_LOCAL']) : rowsWithHeader(insS, ['LOCAL', 'TIPO_LOCAL']);
  for (const r of lrows) { const n = str(r.local), t = str(r.tipo_local); if (n && t && !['N/A', 'TODOS'].includes(n) && !locais.some(l => l.nome === n)) locais.push({nome: n, tipo: t}); }
  const byName = new Map(insumos.map(i => [norm(i.nome), i.id]));
  const estoque = [];
  for (const r of rowsWithHeader(estS, ['LOCAL', 'NOME_INSUMO'])) {
    const local = str(r.local); if (!local) continue;
    let id = str(r.id_insumo); if (!seen.has(id)) id = byName.get(norm(r.nome_insumo)) || '';
    if (!id) continue;
    const mn = r.estoque_minimo;
    estoque.push({local, id, ini: Number(r.estoque_inicial) || 0, min: mn === null || mn === '' ? null : Number(mn)});
    if (!locais.some(l => l.nome === local)) locais.push({nome: local, tipo: str(r.tipo_local) || 'Sala'});
  }
  const movs = [];
  if (movS) for (const r of rowsWithHeader(movS, ['DATA', 'TIPO', 'QUANTIDADE'])) {
    const tipo = str(r.tipo).toUpperCase(), qtd = Number(r.quantidade), local = str(r.local);
    if (!TIPOS.includes(tipo) || !(qtd > 0) || !local) continue;
    let id = str(r.id_insumo); if (!seen.has(id)) id = byName.get(norm(r.nome_insumo)) || ''; if (!id) continue;
    const obs = str(r.observacoes);
    movs.push({uid: uid(), data: toISO(r.data) || todayISO(), local, id, tipo, qtd, resp: str(r.responsavel), obs: obs === 'N/A' ? '' : obs, destino: tipo === 'TRANSFERÊNCIA' ? str(r.destino) : ''});
  }
  if (!insumos.length) throw new Error('Nenhum insumo encontrado na aba INSUMOS.');
  return dedupe({insumos, locais, estoque, movs});
}
function handleFile(file) {
  const rd = new FileReader();
  rd.onload = () => {
    try {
      let data;
      if (/\.json$/i.test(file.name)) { const j = JSON.parse(new TextDecoder().decode(rd.result)); data = j.data || j; if (!data.insumos || !data.estoque) throw new Error('Backup inválido.'); }
      else { if (!needXLSX()) return; data = importWorkbook(rd.result); }
      if (!confirm(`Importar "${file.name}"?\n\n${data.insumos.length} insumos · ${data.locais.length} locais · ${data.estoque.length} itens de estoque · ${data.movs.length} movimentações\n\nOs dados atuais serão substituídos${CLOUD ? ' PARA TODA A EQUIPE' : ''} (você pode desfazer logo em seguida).`)) return;
      data.movs.forEach(m => { if (!m.uid) m.uid = uid(); });
      commit('Dados importados', () => { S = data; });
    } catch (e) { toast('Não foi possível importar: ' + e.message, null, true); }
  };
  rd.readAsArrayBuffer(file);
}

/* ---------------- Eventos globais ---------------- */
document.addEventListener('click', e => {
  const nav = e.target.closest('#sideNav button'); if (nav) return go(nav.dataset.page);
  const sl = e.target.closest('#sideLocais button'); if (sl) return go('estoque', {local: sl.dataset.local, status: 'TODOS', search: ''});
  const g = e.target.closest('[data-goto]'); if (g) return go(g.dataset.goto, g.dataset.status ? {status: g.dataset.status, local: ''} : {});
  const a = e.target.closest('[data-act]'); if (!a) return;
  const act = a.dataset.act;
  if (act === 'new-mov') modalMov();
  if (act === 'new-insumo') modalInsumo();
  if (act === 'new-vinculo') modalVinculo();
  if (act === 'new-local') modalLocal();
  if (act === 'export-xlsx') exportXlsx();
  if (act === 'export-view') exportView();
  if (act === 'export-json') exportJson();
  if (act === 'password') modalSenha();
  if (act === 'logout') logout();
  if (act === 'refresh') reloadAll().then(() => toast('Dados atualizados')).catch(e => toast('Não foi possível atualizar: ' + errMsg(e), null, true));
  if (act === 'import') { $('#fileInput').value = ''; $('#fileInput').click(); }
  if (act === 'reset' && confirm('Restaurar os dados da planilha original? Tudo que foi registrado será substituído' + (CLOUD ? ' PARA TODA A EQUIPE.' : '.'))) commit('Dados originais restaurados', () => { S = seedState(); });
});
$('#fileInput').onchange = e => e.target.files[0] && handleFile(e.target.files[0]);
$('#overlay').addEventListener('mousedown', e => { if (e.target.id === 'overlay') closeModal(); });
$('#menuBtn').onclick = () => { const o = $('#sidebar').classList.toggle('open'); $('#menuBtn').setAttribute('aria-expanded', o); $('#menuBtn').textContent = o ? 'Fechar' : 'Menu'; };
$('#estLocal').onchange = e => { F.est.local = e.target.value; renderAll(); };
$('#estSearch').oninput = e => { F.est.q = e.target.value; renderAll(); };
$('#estView').onclick = e => { const b = e.target.closest('button'); if (b) { F.est.view = b.dataset.v; F.est.sort = b.dataset.v === 'geral' ? {k: 'nome', d: 1} : {k: 'local', d: 1}; renderAll(); } };
$('#movLocal').onchange = e => { F.mov.local = e.target.value; renderAll(); };
$('#movSearch').oninput = e => { F.mov.q = e.target.value; renderAll(); };
$('#insSearch').oninput = e => { F.ins.q = e.target.value; renderAll(); };
$('#eqSearch').oninput = e => { F.eq.q = e.target.value; renderEquipe(); };
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#overlay').classList.contains('open')) return closeModal();
  if (e.key === 'Escape' && $('#sheet').classList.contains('open')) return closeSheet();
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (typing || e.metaKey || e.ctrlKey || e.altKey || $('#overlay').classList.contains('open')) return;
  if (e.key.toLowerCase() === 'n') { e.preventDefault(); modalMov(); }
  if (e.key === '/') { const s = $('.page.active .search'); if (s) { e.preventDefault(); s.focus(); } }
});
window.addEventListener('storage', e => { if (!CLOUD && e.key === KEY) { S = load(); renderAll(); } });
// ao voltar para o app (iPhone suspende o app em segundo plano), busca as novidades
document.addEventListener('visibilitychange', () => {
  if (!CLOUD || !me || document.visibilityState !== 'visible') return;
  if (pendingPoll) return recheck('quiet');
  checkMember().then(st => { if (st !== 'aprovado') showPending(st); else { reloadAll().catch(() => {}); loadMembros(); } });
});
window.addEventListener('online', () => { if (CLOUD && me) reloadAll().catch(() => {}); });
window.addEventListener('offline', () => { if (CLOUD) offline(); });

const PAGES = ['painel', 'estoque', 'movimentacoes', 'insumos', 'locais', 'guia', 'equipe'];
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (PAGES.includes(h) && h !== page) go(h); });
const start = (location.hash || '').slice(1);
if (PAGES.includes(start) && start !== 'equipe') page = start;
if (CLOUD) { showLogin(); loginForm(); }
go(page);
if (CLOUD) startCloud();
})();
