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

// Textos con los que WhatsApp indica que el número no existe / no hay resultados
const NEG = /not on whatsapp|isn.t on whatsapp|no est[aá] en whatsapp|no results|no se encontr|sin resultados|invalid|inv[aá]lid|not found/i;

const sessions = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Session {
  constructor(id) {
    this.id = id; this.dir = path.join(BASE_DIR, id);
    this.state = 'starting'; this.qr = null; this.running = false; this.stop = false;
    this.total = 0; this.rows = []; this.clients = new Set(); this.touched = Date.now(); this.closed = false;
  }
  touch() { this.touched = Date.now(); }
  pub() {
    return {
      state: this.state, qr: this.qr, running: this.running, stopping: this.running && this.stop,
      total: this.total, done: this.rows.length,
      yes: this.rows.filter(r => r.status === 'yes').length,
      no: this.rows.filter(r => r.status === 'no').length,
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

  caja() { return this.page.locator('[contenteditable="true"][role="textbox"]').first(); }

  // Abre "Nuevo chat" una sola vez; queda abierto durante toda la lista
  async openPanel() {
    if (this.panelOpen) return;
    await this.nuevoChat().click();
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
    const r = await caja.evaluate((el, minMs, maxMs) => new Promise(resolve => {
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
        // listo: pasó el mínimo y el panel dejó de cambiar 200 ms (o se agotó el máximo)
        if ((now - t0 >= minMs && now - lastChange >= 200) || now - t0 >= maxMs) {
          return resolve({ text: cur, count: panel.querySelectorAll('[role="listitem"], [role="gridcell"]').length, waited: now - t0 });
        }
        setTimeout(tick, 40);
      };
      tick();
    }), ESPERA_RESULTADO, 3000);
    const t = r.text.replace(/\s*\n\s*/g, ' | ').trim();
    return { phone: num, status: !NEG.test(t) && r.count > 0 ? 'yes' : 'no', raw: `[${r.waited}ms] ` + t };
  }

  async run(numbers) {
    this.running = true; this.stop = false; this.rows = []; this.total = numbers.length; this.push();
    for (const n of numbers) {
      if (this.stop || this.closed) break;
      try { this.rows.push(await this.check(n)); }
      catch (e) {
        await this.closePanel(); // ante cualquier falla se reabre limpio en el próximo número
        if (e.message === 'stopped') break; // el número interrumpido no se cuenta
        this.rows.push({ phone: n, status: 'no', raw: 'error: ' + e.message.split('\n')[0] });
      }
      this.touch(); this.push();
      if (PAUSE_MAX > 0) await this.wait(PAUSE_MIN + Math.random() * (PAUSE_MAX - PAUSE_MIN));
    }
    await this.closePanel();
    this.running = false; this.touch(); this.push();
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

const cookieId = req => (/(?:^|;\s*)sid=([a-f0-9]{32})/.exec(req.headers.cookie || '') || [])[1];
const body = req => new Promise(r => { let b = ''; req.on('data', c => { b += c; if (b.length > 5e6) req.destroy(); }); req.on('end', () => r(b)); });

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  let sid = cookieId(req);
  const s = sid && sessions.get(sid);
  if (s) s.touch();

  if (url === '/') {
    if (!sid) {
      sid = crypto.randomBytes(16).toString('hex');
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${KEEP ? 2592000 : 86400}${secure}`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  }

  if (url === '/connect' && req.method === 'POST') {
    if (!sid) { res.writeHead(400); return res.end('sin cookie'); }
    if (!s) {
      if (sessions.size >= MAX_SESSIONS) { res.writeHead(503); return res.end('Servidor ocupado'); }
      const ns = new Session(sid); sessions.set(sid, ns);
      ns.start().catch(() => ns.close(!KEEP));
    }
    res.writeHead(200); return res.end('ok');
  }

  if (!s) { // el resto requiere sesión viva
    if (url === '/state') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"exists":false}'); }
    res.writeHead(404); return res.end('sin sesión');
  }

  if (url === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ exists: true, ...s.pub() }));
  }
  if (url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    s.clients.add(res);
    res.write(`data: ${JSON.stringify(s.pub())}\n\n`);
    const ka = setInterval(() => res.write(': ka\n\n'), 20000);
    return req.on('close', () => { clearInterval(ka); s.clients.delete(res); });
  }
  if (url === '/start' && req.method === 'POST') {
    if (s.state !== 'connected' || s.running) { res.writeHead(409); return res.end('no listo'); }
    let nums;
    try { nums = [...new Set(JSON.parse(await body(req)).numbers.map(String))].filter(n => /^\d{8,15}$/.test(n)); }
    catch { res.writeHead(400); return res.end('json inválido'); }
    if (!nums.length) { res.writeHead(400); return res.end('Ningún número válido: deben tener entre 8 y 15 dígitos, con código de país (ej. 5491122334455).'); }
    if (nums.length > MAX_NUMBERS) { res.writeHead(413); return res.end(`Máximo ${MAX_NUMBERS} números por corrida`); }
    s.run(nums);
    res.writeHead(200); return res.end('ok');
  }
  if (url === '/stop' && req.method === 'POST') { s.stop = true; s.push(); res.writeHead(200); return res.end('ok'); }
  if (url === '/logout' && req.method === 'POST') { await s.close(true); res.writeHead(200); return res.end('ok'); }
  if (url === '/results.csv') {
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="resultados.csv"' });
    return res.end(s.csv());
  }
  if (url === '/results-debug.csv') { // incluye el texto crudo que leyó WhatsApp, para calibrar
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
    return res.end('phone,status,raw\n' + s.rows.map(r => `${r.phone},${r.status},"${r.raw.replace(/"/g, '""')}"`).join('\n'));
  }
  res.writeHead(404); res.end();
}).listen(PORT, '0.0.0.0', () => console.log(`Escuchando en :${PORT} (máx ${MAX_SESSIONS} sesiones, headless=${HEADLESS})`));

const shutdown = async () => { await Promise.all([...sessions.values()].map(s => s.close(!KEEP))); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
