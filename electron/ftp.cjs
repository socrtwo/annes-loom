// QuillLoom desktop app: a small FTP / explicit FTPS client for publishing a site.
//
// Uses only node:net and node:tls. Supports USER/PASS, explicit TLS (AUTH TLS, PBSZ 0, PROT P, data
// connections in TLS that reuse the control connection's session), binary transfers, passive mode
// (EPSV, falling back to PASV), creating nested folders, STOR and DELE. Every reply wait and every
// data transfer has a timeout. The password is never written to the log.
//
// Data connections always go to the control connection's host, whatever address the server puts in
// its PASV reply, so a hostile server cannot point QuillLoom at another machine ("FTP bounce").
'use strict';
const net = require('node:net');
const tls = require('node:tls');
const path = require('node:path');

const REPLY_TIMEOUT = 30000;
const CONNECT_TIMEOUT = 20000;
const DATA_TIMEOUT = 60000;
const MAX_LOG = 4000;

/** Resolves like `p`, or rejects with `message` after `ms`; the timer never outlives the race. */
function within(p, ms, message) {
  let timer;
  return Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new FtpError(message)), ms); })]).finally(() => clearTimeout(timer));
}

class FtpError extends Error {
  constructor(message, code) { super(message); this.code = code || 0; }
}

/** A remote path: posix, no control characters, no '..' segments. */
function cleanRemote(p, what) {
  if (typeof p !== 'string') throw new FtpError(`${what} must be text`);
  if (/[\r\n\0]/.test(p)) throw new FtpError(`${what} contains a line break`);
  if (p.length > 2048) throw new FtpError(`${what} is too long`);
  const abs = p.startsWith('/');
  const segs = p.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
  if (segs.some((s) => s === '..')) throw new FtpError(`${what} may not contain ".."`);
  return (abs ? '/' : '') + segs.join('/');
}

class FtpClient {
  /** @param {(line: string) => void} log @param {import('node:tls').ConnectionOptions} [tlsExtra] for tests (a private CA) */
  constructor(log, tlsExtra) {
    this.log = log;
    this.tlsExtra = tlsExtra || {};
    this.sock = null; // control socket (net.Socket or tls.TLSSocket)
    this.host = '';
    this.servername = '';
    this.secure = false;
    this.session = undefined;
    this.buf = '';
    this.multi = null; // { code, lines }
    this.replies = [];
    this.waiters = [];
    this.closedError = null;
    this.features = new Set();
  }

  // ---- control connection ------------------------------------------------------------------

  attach(sock) {
    this.sock = sock;
    sock.setEncoding('utf8');
    sock.on('data', this.onData);
    sock.on('error', this.onClose);
    sock.on('close', this.onClose);
    if (sock instanceof tls.TLSSocket) sock.on('session', (s) => { this.session = s; });
  }

  detach() {
    const s = this.sock;
    if (!s) return;
    s.removeListener('data', this.onData);
    s.removeListener('error', this.onClose);
    s.removeListener('close', this.onClose);
  }

  onData = (chunk) => {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      this.onLine(line);
    }
    if (this.buf.length > 1 << 20) this.onClose(new FtpError('The server sent an overlong reply line'));
  };

  onLine(line) {
    if (this.multi) {
      this.multi.lines.push(line);
      if (line.startsWith(this.multi.code + ' ')) {
        const r = { code: Number(this.multi.code), text: this.multi.lines.join('\n') };
        this.multi = null;
        this.push(r);
      }
      return;
    }
    const m = /^(\d{3})([ -])(.*)$/.exec(line);
    if (!m) return; // stray text outside a reply
    if (m[2] === '-') { this.multi = { code: m[1], lines: [line] }; return; }
    this.push({ code: Number(m[1]), text: line });
  }

  push(r) {
    const first = r.text.split('\n')[0];
    this.log(`< ${first.length > 300 ? first.slice(0, 300) + '…' : first}`);
    const w = this.waiters.shift();
    if (w) { clearTimeout(w.timer); w.resolve(r); } else this.replies.push(r);
  }

  onClose = (err) => {
    if (this.closedError) return;
    this.closedError = err instanceof Error ? err : new FtpError('The server closed the connection');
    for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(this.closedError); }
  };

  /** The next reply. */
  reply(timeout = REPLY_TIMEOUT) {
    if (this.replies.length) return Promise.resolve(this.replies.shift());
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        const k = this.waiters.indexOf(w);
        if (k >= 0) this.waiters.splice(k, 1);
        reject(new FtpError('The server did not answer in time'));
      }, timeout);
      this.waiters.push(w);
    });
  }

  write(cmd) {
    if (/[\r\n\0]/.test(cmd)) throw new FtpError('Refused a command containing a line break');
    if (this.closedError) throw this.closedError;
    this.log('> ' + (/^PASS /i.test(cmd) ? 'PASS ********' : cmd));
    this.sock.write(cmd + '\r\n', 'utf8');
  }

  /** Sends a command and returns its final reply (skipping 1xx preliminary replies). */
  async cmd(cmd, timeout) {
    this.write(cmd);
    let r = await this.reply(timeout);
    while (r.code >= 100 && r.code < 200) r = await this.reply(timeout);
    return r;
  }

  /** Sends a command and requires a 2xx/3xx reply. */
  async expect(cmd, ok = (c) => c >= 200 && c < 400) {
    const r = await this.cmd(cmd);
    if (!ok(r.code)) throw new FtpError(`${cmd.split(' ')[0] === 'PASS' ? 'PASS' : cmd}: ${r.text}`, r.code);
    return r;
  }

  async connect({ host, port, secure }) {
    this.host = host;
    this.servername = net.isIP(host) ? undefined : host;
    const sock = await new Promise((resolve, reject) => {
      const s = net.connect({ host, port });
      const t = setTimeout(() => { s.destroy(); reject(new FtpError(`Could not connect to ${host}:${port} (timed out)`)); }, CONNECT_TIMEOUT);
      s.once('connect', () => { clearTimeout(t); resolve(s); });
      s.once('error', (e) => { clearTimeout(t); reject(new FtpError(`Could not connect to ${host}:${port}: ${e.message}`)); });
    });
    this.raw = sock;
    sock.setKeepAlive(true, 10000);
    this.attach(sock);
    const hello = await this.reply();
    if (hello.code >= 400) throw new FtpError(`The server refused the connection: ${hello.text}`, hello.code);
    if (secure) await this.upgrade();
  }

  async upgrade() {
    const r = await this.cmd('AUTH TLS');
    if (r.code !== 234 && r.code !== 334) throw new FtpError(`The server does not offer FTPS (AUTH TLS): ${r.text}`, r.code);
    this.detach();
    const plain = this.sock;
    const t = await new Promise((resolve, reject) => {
      const s = tls.connect({ ...this.tlsExtra, socket: plain, servername: this.servername, minVersion: 'TLSv1.2' });
      const timer = setTimeout(() => { s.destroy(); reject(new FtpError('The TLS handshake timed out')); }, CONNECT_TIMEOUT);
      s.once('secureConnect', () => { clearTimeout(timer); resolve(s); });
      s.once('error', (e) => { clearTimeout(timer); reject(new FtpError(`TLS failed: ${e.message}`)); });
    });
    this.session = t.getSession();
    this.secure = true;
    this.attach(t);
    this.log(`  TLS ${t.getProtocol() || ''} established`);
  }

  async login(user, password) {
    let r = await this.cmd('USER ' + user);
    if (r.code === 331 || r.code === 332) r = await this.cmd('PASS ' + password);
    if (r.code !== 230 && r.code !== 202) throw new FtpError(`Sign-in failed: ${r.text}`, r.code);
    if (this.secure) {
      await this.cmd('PBSZ 0');
      const p = await this.cmd('PROT P');
      if (p.code >= 300) throw new FtpError(`The server refused encrypted data connections (PROT P): ${p.text}`, p.code);
    }
    const f = await this.cmd('FEAT');
    if (f.code === 211) for (const line of f.text.split('\n').slice(1, -1)) this.features.add(line.trim().split(' ')[0].toUpperCase());
    if (this.features.has('UTF8')) await this.cmd('OPTS UTF8 ON');
    await this.expect('TYPE I');
  }

  // ---- data connections --------------------------------------------------------------------

  async passivePort() {
    if (this.useEpsv !== false) {
      const r = await this.cmd('EPSV');
      const m = /\(([^\d])\1\1(\d+)\1\)/.exec(r.text);
      if (r.code === 229 && m) { this.useEpsv = true; return Number(m[2]); }
      this.useEpsv = false;
    }
    const r = await this.cmd('PASV');
    const m = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(r.text);
    if (r.code !== 227 || !m) throw new FtpError(`Passive mode failed: ${r.text}`, r.code);
    // The address in the reply is ignored (see the top of the file).
    return Number(m[5]) * 256 + Number(m[6]);
  }

  async openData() {
    const port = await this.passivePort();
    if (!(port > 0 && port < 65536)) throw new FtpError('The server sent an invalid data port');
    const host = this.raw.remoteAddress || this.host;
    const sock = await new Promise((resolve, reject) => {
      const s = net.connect({ host, port });
      const t = setTimeout(() => { s.destroy(); reject(new FtpError('The data connection timed out')); }, CONNECT_TIMEOUT);
      s.once('connect', () => { clearTimeout(t); resolve(s); });
      s.once('error', (e) => { clearTimeout(t); reject(new FtpError(`The data connection failed: ${e.message}`)); });
    });
    if (!this.secure) return { sock, ready: Promise.resolve() };
    // The TLS handshake starts now and completes once the server accepts it (after it answers STOR).
    const t = tls.connect({ ...this.tlsExtra, socket: sock, servername: this.servername, session: this.session, minVersion: 'TLSv1.2' });
    const ready = new Promise((resolve, reject) => {
      t.once('secureConnect', resolve);
      t.once('error', (e) => reject(new FtpError(`TLS on the data connection failed: ${e.message}`)));
    });
    ready.catch(() => undefined);
    return { sock: t, ready };
  }

  /** Uploads one file. */
  async stor(remote, data) {
    const { sock, ready } = await this.openData();
    let done;
    try {
      sock.setTimeout(DATA_TIMEOUT, () => sock.destroy(new FtpError('The upload stalled')));
      done = new Promise((resolve, reject) => {
        sock.once('close', resolve);
        sock.once('error', reject);
      });
      done.catch(() => undefined);
      this.write('STOR ' + remote);
      const pre = await this.reply();
      if (pre.code >= 300) throw new FtpError(`Upload of ${remote} refused: ${pre.text}`, pre.code);
      if (pre.code >= 200) {
        // Some servers answer 2xx at once for empty files; nothing more to wait for.
        sock.destroy();
        return;
      }
      await within(ready, CONNECT_TIMEOUT, 'The data TLS handshake timed out');
      await new Promise((resolve, reject) => sock.end(data, (e) => (e ? reject(e) : resolve())));
      await within(done, DATA_TIMEOUT, 'The upload did not finish in time');
    } catch (e) {
      sock.destroy();
      throw e;
    }
    const fin = await this.reply(DATA_TIMEOUT);
    if (fin.code >= 300) throw new FtpError(`Upload of ${remote} failed: ${fin.text}`, fin.code);
  }

  async mkdirs(dir, made) {
    if (!dir || dir === '/' || made.has(dir)) return;
    const abs = dir.startsWith('/');
    const segs = dir.split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < segs.length; i++) {
      cur = (i === 0 ? (abs ? '/' : '') : cur + '/') + segs[i];
      if (made.has(cur)) continue;
      const r = await this.cmd('MKD ' + cur);
      // 257 created; 550/521/553 usually mean it exists already. A real failure shows up on STOR.
      if (r.code !== 257 && !(r.code >= 500 && r.code < 600)) throw new FtpError(`Could not create ${cur}: ${r.text}`, r.code);
      made.add(cur);
    }
  }

  async quit() {
    try { if (!this.closedError) await this.cmd('QUIT', 5000); } catch { /* closing anyway */ }
    this.close();
  }

  close() {
    try { this.sock && this.sock.destroy(); } catch { /* */ }
    try { this.raw && this.raw.destroy(); } catch { /* */ }
  }
}

/**
 * Validates the renderer's request. Throws on anything malformed.
 * @returns {{ host: string, port: number, user: string, password: string, secure: boolean, dir: string, files: { path: string, data: Buffer }[], remove: string[] }}
 */
function validate(o) {
  if (!o || typeof o !== 'object') throw new FtpError('Missing FTP settings');
  const host = typeof o.host === 'string' ? o.host.trim().replace(/^ftps?:\/\//i, '').replace(/\/.*$/, '') : '';
  if (!host || host.length > 253 || !/^[A-Za-z0-9.\-]+$|^\[?[0-9A-Fa-f:.]+\]?$/.test(host)) throw new FtpError('Enter a valid server name');
  const port = o.port == null || o.port === '' ? 21 : Number(o.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new FtpError('Enter a valid port (1-65535)');
  const user = o.user == null || o.user === '' ? 'anonymous' : o.user;
  const password = o.password == null ? '' : o.password;
  if (typeof user !== 'string' || typeof password !== 'string' || /[\r\n\0]/.test(user + password) || user.length > 512 || password.length > 1024) throw new FtpError('Invalid user name or password');
  const dir = o.dir == null || o.dir === '' ? '' : cleanRemote(o.dir, 'The remote folder');
  if (!Array.isArray(o.files) || o.files.length > 100000) throw new FtpError('Invalid file list');
  let total = 0;
  const files = o.files.map((f, i) => {
    if (!f || typeof f !== 'object' || typeof f.data !== 'string') throw new FtpError(`Invalid file #${i + 1}`);
    const p = cleanRemote(f.path, 'A file path').replace(/^\/+/, '');
    if (!p) throw new FtpError(`File #${i + 1} has no name`);
    const data = Buffer.from(f.data, 'base64');
    total += data.length;
    if (total > 2 * 1024 * 1024 * 1024) throw new FtpError('The upload is larger than 2 GB');
    return { path: p, data };
  });
  const rm = o.remove == null ? [] : o.remove;
  if (!Array.isArray(rm) || rm.length > 100000) throw new FtpError('Invalid list of files to remove');
  const remove = rm.map((p) => cleanRemote(p, 'A path to remove').replace(/^\/+/, '')).filter(Boolean);
  return { host: host.replace(/^\[|\]$/g, ''), port, user, password, secure: !!o.secure, dir, files, remove };
}

const join = (dir, p) => (dir ? path.posix.join(dir, p) : p);

/**
 * Uploads files (and deletes `remove`) over FTP or explicit FTPS.
 * @returns {Promise<{ ok: boolean, log: string[], uploaded: number, removed: number, failed: string[] }>}
 */
async function ftpPublish(opts, internal = {}) {
  const log = [];
  const add = (line) => { if (log.length < MAX_LOG) log.push(line); else if (log.length === MAX_LOG) log.push('… (log truncated)'); };
  let o;
  try { o = validate(opts); } catch (e) { return { ok: false, log: [String(e.message || e)], uploaded: 0, removed: 0, failed: [] }; }
  const c = new FtpClient(add, internal.tls);
  const failed = [];
  let uploaded = 0, removed = 0;
  try {
    add(`Connecting to ${o.host}:${o.port}${o.secure ? ' (FTPS)' : ''}`);
    await c.connect(o);
    await c.login(o.user, o.password);
    const made = new Set();
    if (o.dir) await c.mkdirs(o.dir, made);
    for (const f of o.files) {
      const remote = join(o.dir, f.path);
      try {
        await c.mkdirs(path.posix.dirname(remote) === '.' ? '' : path.posix.dirname(remote), made);
        await c.stor(remote, f.data);
        uploaded++;
      } catch (e) {
        if (c.closedError) throw e;
        failed.push(f.path);
        add(`! ${e.message || e}`);
      }
    }
    for (const p of o.remove) {
      const remote = join(o.dir, p);
      const r = await c.cmd('DELE ' + remote);
      if (r.code >= 200 && r.code < 300) removed++;
      else if (r.code !== 550) { failed.push(p); add(`! Could not delete ${remote}: ${r.text}`); }
    }
    await c.quit();
    add(`Uploaded ${uploaded} file${uploaded === 1 ? '' : 's'}${o.remove.length ? `, deleted ${removed}` : ''}${failed.length ? `, ${failed.length} failed` : ''}.`);
    return { ok: failed.length === 0, log, uploaded, removed, failed };
  } catch (e) {
    add(`! ${e.message || e}`);
    c.close();
    return { ok: false, log, uploaded, removed, failed };
  }
}

module.exports = { ftpPublish, FtpClient, validate, cleanRemote };
