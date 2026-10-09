// Verificador de números en WhatsApp Web, multiusuario.
// Cada visitante tiene su propio Chromium, su QR y un perfil temporal que se borra al terminar.
// Solo tipea en "Nuevo chat" y lee lo que aparece. No envía nada.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 3000;
const HEADLESS = process.env.HEADLESS !== '0';
const MAX_SESSIONS = +process.env.MAX_SESSIONS || 3;      // cada una ~400 MB de RAM
const MAX_NUMBERS = +process.env.MAX_NUMBERS || 200;      // por corrida
const IDLE_MS = (+process.env.IDLE_MIN || 10) * 60 * 1000;
// KEEP_SESSION=1 (modo testing): el perfil con las credenciales de WhatsApp se guarda en disco y
// solo se borra con el botón "Cerrar sesión y borrar datos". Montá SESSIONS_DIR en un volumen.
const KEEP = process.env.KEEP_SESSION === '1';
const BASE_DIR = process.env.SESSIONS_DIR || path.join(os.tmpdir(), 'wa-sessions');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DELAY_TECLA = +process.env.TYPE_DELAY_MS || 70;     // ms entre dígitos
const ESPERA_RESULTADO = +process.env.WAIT_MS || 500;      // espera a que WhatsApp muestre su respuesta
const PAUSE_MIN = +process.env.PAUSE_MIN_MS || 0;          // pausa extra entre números (anti-baneo)
const PAUSE_MAX = +process.env.PAUSE_MAX_MS || 0;

// --- Plan gratis, cuentas y cupo -------------------------------------------------------
const FREE_LIMIT = +process.env.FREE_LIMIT || 100;                 // verificaciones gratis por cuenta (de por vida)
const KEYS_PER_IP_DAY = +process.env.KEYS_PER_IP_DAY || 10;        // cuentas nuevas por IP y por día
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ACC_FILE = path.join(DATA_DIR, 'accounts.json');
let accounts = {};
try { accounts = JSON.parse(fs.readFileSync(ACC_FILE, 'utf8')); } catch {}
let saveTimer = null;
function saveAccounts() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(ACC_FILE + '.tmp', JSON.stringify(accounts));
      fs.renameSync(ACC_FILE + '.tmp', ACC_FILE);
    } catch (e) { console.error('no pude guardar las cuentas:', e.message); }
  }, 300);
}
function getAccount(id, create = true) {
  if (!accounts[id] && create) {
    accounts[id] = { created: new Date().toISOString(), plan: 'free', limit: FREE_LIMIT, used: 0 };
    saveAccounts();
  }
  return accounts[id];
}
const accPub = (a, id, withKey) => ({
  plan: a.plan, limit: a.limit, used: a.used, remaining: Math.max(0, a.limit - a.used),
  ...(withKey ? { api_key: 'wak_' + id } : {}),
});

// Textos con los que WhatsApp indica que el número no existe / no hay resultados
const NEG = /not on whatsapp|isn.t on whatsapp|no est[aá] en whatsapp|no results|no se encontr|sin resultados|invalid|inv[aá]lid|not found/i;

const sessions = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Session {
  constructor(id) {
    this.id = id; this.dir = path.join(BASE_DIR, id);
    this.state = 'starting'; this.qr = null; this.running = false; this.stop = false;
    this.total = 0; this.rows = []; this.jobs = new Map(); this.job = null; this.clients = new Set(); this.touched = Date.now(); this.closed = false;
  }
  touch() { this.touched = Date.now(); }
  pub() {
    return {
      state: this.state, qr: this.qr, running: this.running, stopping: this.running && this.stop, error: this.error || null,
      total: this.total, done: this.rows.length,
      yes: this.rows.filter(r => r.status === 'yes').length,
      no: this.rows.filter(r => r.status === 'no').length,
      errors: this.rows.filter(r => r.status === 'error').length,
      last: this.rows.slice(-12).reverse(),
    };
  }
  push() { const m = `data: ${JSON.stringify(this.pub())}\n\n`; this.clients.forEach(c => c.write(m)); }
  nuevoChat() { return this.page.getByRole('button', { name: /new chat|nuevo chat/i }).first(); }

  async start() {
    this.ctx = await chromium.launchPersistentContext(this.dir, {
      headless: HEADLESS, userAgent: UA, viewport: { width: 1100, height: 760 },
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    this.page = this.ctx.pages()[0] || await this.ctx.newPage();
    this.page.setDefaultTimeout(8000); // fallar rápido, no esperar 30 s
    await this.page.goto('https://web.whatsapp.com');
    while (!this.closed) {
      try {
        if (this.running) { await sleep(1500); continue; }
        if (await this.nuevoChat().isVisible()) {
          if (this.state !== 'connected') { this.state = 'connected'; this.qr = null; this.push(); }
        } else {
          const canvas = this.page.locator('canvas').first();
          if (await canvas.isVisible()) {
            this.qr = (await canvas.screenshot()).toString('base64'); this.state = 'qr';
          } else if (this.state !== 'connected') this.state = 'loading';
          this.push();
        }
      } catch { /* página navegando */ }
      await sleep(1500);
    }
  }

  // Espera en tramos cortos para poder frenar en cualquier momento
  async wait(ms) { for (let t = 0; t < ms && !this.stop; t += 200) await sleep(200); }
  halt() { if (this.stop) throw new Error('stopped'); }

  // El buscador de "Nuevo chat" es un <input role="textbox"> (versiones viejas: contenteditable)
  caja() { return this.page.locator('input[role="textbox"], input[type="text"], [contenteditable="true"][role="textbox"]').first(); }

  // Abre "Nuevo chat" una sola vez; queda abierto durante toda la lista
  // Cierra carteles que tapan la pantalla ("Novedades", avisos, etc.)
  async dismissDialogs() {
    for (let i = 0; i < 3; i++) {
      const d = this.page.locator('[role="dialog"]').first();
      if (!(await d.isVisible().catch(() => false))) return;
      const btn = d.getByRole('button', { name: /continuar|continue|aceptar|accept|entendido|got it|ok|cerrar|close/i }).first();
      if (await btn.count()) await btn.click({ timeout: 3000 }).catch(() => {});
      else await this.page.keyboard.press('Escape');
      await sleep(300);
    }
  }

  async openPanel() {
    if (this.panelOpen) return;
    await this.dismissDialogs();
    try { await this.nuevoChat().click({ timeout: 4000 }); }
    catch { await this.dismissDialogs(); await this.nuevoChat().click({ timeout: 4000 }); }
    await this.caja().waitFor({ timeout: 8000 });
    this.panelOpen = true;
  }

  async closePanel() {
    if (!this.panelOpen) return;
    this.panelOpen = false;
    try {
      await this.page.keyboard.press('Control+A');
      await this.page.keyboard.press('Backspace');
      await this.page.keyboard.press('Escape'); // cierra el panel; nunca Enter, nunca abre un chat
    } catch {}
  }

  // Pega el número de una sola vez (una búsqueda en vez de una por dígito) y lee el panel apenas se estabiliza.
  async check(num) {
    const { page } = this;
    this.halt();
    await this.openPanel();
    const caja = this.caja();
    await caja.focus();
    await page.keyboard.press('Control+A');   // borra el número anterior
    await page.keyboard.press('Backspace');
    await page.keyboard.insertText(num);      // un solo evento de entrada, sin tipear tecla por tecla
    this.halt();
    const r = await caja.evaluate((el, { minMs, maxMs, num }) => new Promise(resolve => {
      let panel = el;
      for (let i = 0; i < 8 && panel.parentElement; i++) {
        panel = panel.parentElement;
        if (panel.querySelector('[role="listitem"], [role="list"], [role="grid"]')) break;
      }
      const t0 = Date.now();
      let last = panel.innerText, lastChange = t0;
      const tick = () => {
        const cur = panel.innerText, now = Date.now();
        if (cur !== last) { last = cur; lastChange = now; }
        // listo: pasó el mínimo, el panel dejó de cambiar 150 ms y ya menciona el número buscado
        // (así no se lee el resultado del número anterior); o se agotó el máximo
        const mencionaNumero = cur.replace(/\D/g, '').includes(num);
        if ((now - t0 >= minMs && now - lastChange >= 150 && mencionaNumero) || now - t0 >= maxMs) {
          return resolve({ text: cur, count: panel.querySelectorAll('[role="listitem"], [role="gridcell"]').length, waited: now - t0 });
        }
        setTimeout(tick, 40);
      };
      tick();
    }), { minMs: ESPERA_RESULTADO, maxMs: 2500, num });
    const t = r.text.replace(/\s*\n\s*/g, ' | ').trim();
    return { phone: num, status: !NEG.test(t) && r.count > 0 ? 'yes' : 'no', raw: `[${r.waited}ms] ` + t };
  }

  async run(numbers, truncated = false) {
    const acc = getAccount(this.id);
    this.running = true; this.stop = false; this.error = null; this.rows = [];
    const job = { id: 'job_' + crypto.randomBytes(6).toString('hex'), status: 'running', total: numbers.length,
      truncated, created: new Date().toISOString(), rows: this.rows, error: null };
    this.jobs.set(job.id, job); this.job = job;
    if (this.jobs.size > 5) this.jobs.delete(this.jobs.keys().next().value);
    let fallos = 0; this.total = numbers.length; this.push();
    for (const n of numbers) {
      if (this.stop || this.closed) break;
      if (acc.used >= acc.limit) { this.error = `Agotaste las ${acc.limit} verificaciones gratis.`; break; }
      try { this.rows.push(await this.check(n)); acc.used++; saveAccounts(); fallos = 0; }
      catch (e) {
        await this.closePanel(); // ante cualquier falla se reabre limpio en el próximo número
        if (e.message === 'stopped') break; // el número interrumpido no se cuenta
        // un error no es un "no": queda aparte y no descuenta del cupo
        const motivo = e.message.split('\n')[0];
        this.rows.push({ phone: n, status: 'error', raw: 'error: ' + motivo });
        if (++fallos >= 3) { this.error = 'No pude operar WhatsApp Web (3 fallos seguidos): ' + motivo; break; }
      }
      this.touch(); this.push();
      if (PAUSE_MAX > 0) await this.wait(PAUSE_MIN + Math.random() * (PAUSE_MAX - PAUSE_MIN));
    }
    await this.closePanel();
    job.status = this.error ? 'error' : (this.stop ? 'stopped' : 'done'); job.error = this.error;
    this.running = false; this.touch(); this.push();
  }

  jobPub(job, full = true) {
    const rows = job.rows;
    return {
      id: job.id, status: job.status, total: job.total, done: rows.length, truncated: job.truncated,
      yes: rows.filter(r => r.status === 'yes').length, no: rows.filter(r => r.status === 'no').length,
      errors: rows.filter(r => r.status === 'error').length, error: job.error, created: job.created,
      ...(full ? { results: rows.map(r => ({ phone: r.phone, status: r.status })) } : {}),
    };
  }

  csv() { return 'phone,status\n' + this.rows.map(r => `${r.phone},${r.status}`).join('\n'); }

  async close(wipe = true) { // wipe=false: cierra el navegador pero conserva el perfil
    if (this.closed) return;
    this.closed = true; this.stop = true;
    this.clients.forEach(c => c.end()); this.clients.clear();
    try { await this.ctx?.close(); } catch {}
    if (wipe) { try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch {} }
    sessions.delete(this.id);
  }
}

// Limpieza de sesiones inactivas (y de carpetas huérfanas de una corrida anterior)
if (!KEEP) fs.rmSync(BASE_DIR, { recursive: true, force: true });
fs.mkdirSync(BASE_DIR, { recursive: true });
setInterval(() => {
  for (const s of sessions.values()) {
    if (!s.running && Date.now() - s.touched > IDLE_MS) s.close(!KEEP); // en modo KEEP libera la RAM pero conserva las credenciales
  }
}, 30000);

const body = req => new Promise(r => { let b = ''; req.on('data', c => { b += c; if (b.length > 5e6) req.destroy(); }); req.on('end', () => r(b)); });
const sendJson = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const apiErr = (res, code, errCode, message, extra = {}) => sendJson(res, code, { error: { code: errCode, message, ...extra } });
const clientIp = req => req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
const ipKeys = new Map(); // ip -> { day, n }
const ipAllowed = ip => {
  const day = new Date().toISOString().slice(0, 10), e = ipKeys.get(ip);
  if (!e || e.day !== day) { ipKeys.set(ip, { day, n: 1 }); return true; }
  return ++e.n <= KEYS_PER_IP_DAY;
};

// Identifica al cliente: API key (Authorization: Bearer wak_… / X-API-Key) o la cookie del navegador.
function authOf(req) {
  const h = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || '';
  const m = /^wak_([a-f0-9]{32})$/.exec(String(h).trim());
  if (m) return { id: m[1], viaKey: true };
  const c = (/(?:^|;\s*)sid=([a-f0-9]{32})/.exec(req.headers.cookie || '') || [])[1];
  return c ? { id: c, viaKey: false } : null;
}

// Valida y lanza una corrida; la usan la web (/start) y la API (POST /v1/checks).
function launch(s, rawBody) {
  if (s.state !== 'connected') return { status: 409, code: 'session_not_ready', message: 'WhatsApp todavía no está conectado.' };
  if (s.running) return { status: 409, code: 'job_running', message: 'Ya hay una verificación en curso.' };
  let nums;
  try {
    const list = JSON.parse(rawBody).numbers;
    if (!Array.isArray(list)) throw new Error('numbers');
    nums = [...new Set(list.map(n => String(n).replace(/\D/g, '')))].filter(n => /^\d{8,15}$/.test(n));
  } catch { return { status: 400, code: 'invalid_body', message: 'Enviá JSON con {"numbers": ["5491122334455", …]}.' }; }
  if (!nums.length) return { status: 400, code: 'no_valid_numbers', message: 'Ningún número válido: deben tener entre 8 y 15 dígitos, con código de país (ej. 5491122334455).' };
  if (nums.length > MAX_NUMBERS) return { status: 413, code: 'too_many_numbers', message: `Máximo ${MAX_NUMBERS} números por pedido.` };
  const acc = getAccount(s.id);
  const left = Math.max(0, acc.limit - acc.used);
  if (left === 0) return { status: 402, code: 'quota_exceeded', message: `Usaste tus ${acc.limit} verificaciones gratis.`, quota: accPub(acc, s.id) };
  const truncated = nums.length > left;
  if (truncated) nums = nums.slice(0, left);
  s.run(nums, truncated);
  return { status: 202, id: s.job.id, total: nums.length, truncated, quota: accPub(acc, s.id) };
}

function openSession(id) {
  const cur = sessions.get(id);
  if (cur) return cur;
  if (sessions.size >= MAX_SESSIONS) return null;
  const ns = new Session(id); sessions.set(id, ns);
  ns.start().catch(() => ns.close(!KEEP));
  return ns;
}

async function api(req, res, url) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (url === '/v1/keys' && req.method === 'POST') { // alta de cuenta gratis
    if (!ipAllowed(clientIp(req))) return apiErr(res, 429, 'rate_limited', 'Demasiadas cuentas nuevas desde esta red hoy. Probá mañana.');
    const id = crypto.randomBytes(16).toString('hex');
    return sendJson(res, 201, { ...accPub(getAccount(id), id, true), note: 'Guardá la API key: no se puede recuperar.' });
  }

  const a = authOf(req);
  if (!a) return apiErr(res, 401, 'unauthorized', 'Falta la API key. Usá el encabezado Authorization: Bearer wak_…');
  if (a.viaKey && !accounts[a.id]) return apiErr(res, 401, 'invalid_key', 'API key inválida.');
  const acc = getAccount(a.id);
  const s = sessions.get(a.id);
  if (s) s.touch();

  if (url === '/v1/account' && req.method === 'GET') return sendJson(res, 200, accPub(acc, a.id, !a.viaKey));

  if (url === '/v1/session') {
    if (req.method === 'POST') {
      const ns = openSession(a.id);
      if (!ns) return apiErr(res, 503, 'server_busy', 'El servidor está ocupado. Probá en unos minutos.');
      return sendJson(res, 202, { state: ns.state });
    }
    if (req.method === 'GET') {
      if (!s) return sendJson(res, 200, { state: 'none', qr: null });
      return sendJson(res, 200, { state: s.state, qr: s.qr, running: s.running });
    }
    if (req.method === 'DELETE') { if (s) await s.close(true); return sendJson(res, 200, { state: 'none' }); }
  }

  if (url === '/v1/checks' && req.method === 'POST') {
    if (!s) return apiErr(res, 409, 'no_session', 'Primero creá la sesión (POST /v1/session) y escaneá el QR.');
    const out = launch(s, await body(req));
    if (out.status !== 202) return apiErr(res, out.status, out.code, out.message, out.quota ? { quota: out.quota } : {});
    return sendJson(res, 202, { id: out.id, status: 'running', total: out.total, truncated: out.truncated, quota: out.quota });
  }

  const m = /^\/v1\/checks\/(job_[a-f0-9]+)(\.csv)?$/.exec(url);
  if (m && req.method === 'GET') {
    const job = s && s.jobs.get(m[1]);
    if (!job) return apiErr(res, 404, 'job_not_found', 'No existe ese pedido (o la sesión ya se cerró).');
    if (m[2]) {
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${job.id}.csv"` });
      return res.end('phone,status\n' + job.rows.map(r => `${r.phone},${r.status}`).join('\n'));
    }
    return sendJson(res, 200, s.jobPub(job));
  }

  return apiErr(res, 404, 'not_found', 'Ruta no encontrada.');
}

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/v1/')) return api(req, res, url).catch(e => apiErr(res, 500, 'internal', String(e.message || e)));

  let sid = authOf(req)?.id;
  const s = sid && sessions.get(sid);
  if (s) s.touch();

  if (url === '/' || url === '/docs') {
    if (!sid) {
      if (!ipAllowed(clientIp(req))) { res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Demasiados accesos nuevos desde esta red hoy. Probá mañana.'); }
      sid = crypto.randomBytes(16).toString('hex');
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${KEEP ? 2592000 : 86400}${secure}`);
    }
    getAccount(sid);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'public', url === '/' ? 'index.html' : 'docs.html')));
  }

  if (url === '/connect' && req.method === 'POST') {
    if (!sid) { res.writeHead(400); return res.end('sin cookie'); }
    getAccount(sid);
    if (!openSession(sid)) { res.writeHead(503); return res.end('Servidor ocupado'); }
    res.writeHead(200); return res.end('ok');
  }

  if (!s) { // el resto requiere sesión viva
    if (url === '/state') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"exists":false}'); }
    res.writeHead(404); return res.end('sin sesión');
  }

  if (url === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ exists: true, ...s.pub(), quota: accPub(getAccount(s.id), s.id) }));
  }
  if (url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    s.clients.add(res);
    res.write(`data: ${JSON.stringify({ ...s.pub(), quota: accPub(getAccount(s.id), s.id) })}\n\n`);
    const ka = setInterval(() => res.write(': ka\n\n'), 20000);
    return req.on('close', () => { clearInterval(ka); s.clients.delete(res); });
  }
  if (url === '/start' && req.method === 'POST') {
    const out = launch(s, await body(req));
    res.writeHead(out.status === 202 ? 200 : out.status, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(out.status === 202 ? 'ok' : out.message);
  }
  if (url === '/stop' && req.method === 'POST') { s.stop = true; s.push(); res.writeHead(200); return res.end('ok'); }
  if (url === '/logout' && req.method === 'POST') { await s.close(true); res.writeHead(200); return res.end('ok'); }
  if (url === '/screenshot.png' && process.env.DEBUG_SCREENSHOT === '1') { // solo diagnóstico
    try { const png = await s.page.screenshot(); res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(png); }
    catch { res.writeHead(500); return res.end('sin página'); }
  }
  if (url === '/results.csv') {
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="resultados.csv"' });
    return res.end(s.csv());
  }
  if (url === '/results-debug.csv' && process.env.DEBUG_SCREENSHOT === '1') { // incluye el texto crudo que leyó WhatsApp
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
    return res.end('phone,status,raw\n' + s.rows.map(r => `${r.phone},${r.status},"${r.raw.replace(/"/g, '""')}"`).join('\n'));
  }
  res.writeHead(404); res.end();
}).listen(PORT, '0.0.0.0', () => console.log(`Escuchando en :${PORT} (máx ${MAX_SESSIONS} sesiones, plan gratis ${FREE_LIMIT}, headless=${HEADLESS})`));

const shutdown = async () => { await Promise.all([...sessions.values()].map(s => s.close(!KEEP))); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
