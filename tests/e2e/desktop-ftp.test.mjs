// Tests for the desktop app's FTP client (electron/ftp.cjs) against an in-process fake FTP server,
// over plain FTP and explicit FTPS (with a throwaway self-signed certificate made by openssl).
// Usage: node --test tests/e2e/desktop-ftp.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ftpPublish, validate } = require('../../electron/ftp.cjs');

function makeCert() {
  const dir = mkdtempSync(join(tmpdir(), 'ql-ftp-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) };
  } catch { return null; } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** A minimal FTP server: enough of RFC 959 / 2228 / 2428 for the client. */
function fakeServer({ cert, noEpsv = false } = {}) {
  const files = new Map();
  const dirs = new Set(['/']);
  const commands = [];
  const server = net.createServer((raw) => {
    let sock = raw, buf = '', protP = false, user = '', authed = false;
    let dataSrv = null, dataConn = null;
    const send = (s) => sock.write(s + '\r\n');
    const abs = (p) => (p.startsWith('/') ? p : '/' + p);
    const openPassive = () => new Promise((resolve) => {
      if (dataSrv) dataSrv.close();
      dataSrv = net.createServer((c) => {
        dataConn = protP ? new tls.TLSSocket(c, { isServer: true, key: cert.key, cert: cert.cert }) : c;
        dataSrv.emit('connection-ready');
      });
      dataSrv.listen(0, '127.0.0.1', () => resolve(dataSrv.address().port));
    });
    const onLine = async (line) => {
      const [verb, ...rest] = line.split(' ');
      const arg = rest.join(' ');
      commands.push(verb === 'PASS' ? 'PASS' : line);
      switch (verb.toUpperCase()) {
        case 'AUTH':
          if (!cert) return send('502 No TLS');
          send('234 Go ahead');
          raw.removeAllListeners('data');
          sock = new tls.TLSSocket(raw, { isServer: true, key: cert.key, cert: cert.cert });
          sock.setEncoding('utf8');
          sock.on('data', onData);
          return;
        case 'USER': user = arg; return send('331 Password please');
        case 'PASS':
          if (user === 'web' && arg === 'secret') { authed = true; return send('230 Welcome'); }
          return send('530 Login incorrect');
        case 'PBSZ': return send('200 PBSZ=0');
        case 'PROT': protP = arg === 'P'; return send('200 Protection set');
        case 'FEAT': return send('211-Features:\r\n UTF8\r\n EPSV\r\n PASV\r\n211 End');
        case 'OPTS': return send('200 UTF8 on');
        case 'TYPE': return send('200 Binary');
        case 'EPSV':
          if (noEpsv) return send('500 Unknown command');
          return send(`229 Entering Extended Passive Mode (|||${await openPassive()}|)`);
        case 'PASV': {
          const port = await openPassive();
          // A deliberately wrong address: the client must ignore it.
          return send(`227 Entering Passive Mode (10,255,255,1,${port >> 8},${port & 255})`);
        }
        case 'MKD': {
          if (!authed) return send('530 Not logged in');
          const d = abs(arg);
          if (dirs.has(d)) return send('550 Exists');
          const parent = d.slice(0, d.lastIndexOf('/')) || '/';
          if (!dirs.has(parent)) return send('550 No parent');
          dirs.add(d);
          return send(`257 "${d}" created`);
        }
        case 'STOR': {
          const p = abs(arg);
          const parent = p.slice(0, p.lastIndexOf('/')) || '/';
          if (!dirs.has(parent)) return send('553 No such folder');
          const conn = await (dataConn ? Promise.resolve(dataConn) : new Promise((r) => dataSrv.once('connection-ready', () => r(dataConn))));
          dataConn = null;
          send('150 Ok to send');
          const chunks = [];
          conn.on('data', (c) => chunks.push(c));
          conn.on('end', () => { files.set(p, Buffer.concat(chunks)); conn.end(); send('226 Transfer complete'); });
          return;
        }
        case 'DELE': {
          const p = abs(arg);
          if (!files.delete(p)) return send('550 Not found');
          return send('250 Deleted');
        }
        case 'QUIT': send('221 Bye'); sock.end(); return;
        default: return send('502 Not implemented');
      }
    };
    let chain = Promise.resolve();
    const onData = (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); chain = chain.then(() => onLine(line)); }
    };
    raw.setEncoding('utf8');
    raw.on('data', onData);
    raw.on('error', () => undefined);
    raw.on('close', () => { if (dataSrv) dataSrv.close(); });
    send('220-QuillLoom test server\r\n220 Ready');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, files, dirs, commands })));
}

const b64 = (s) => Buffer.from(s).toString('base64');
const SITE = [
  { path: 'index.html', data: b64('<!doctype html><title>Home</title>') },
  { path: 'css/site.css', data: b64('body{margin:0}') },
  { path: 'images/icons/dot.bin', data: Buffer.from([0, 1, 2, 255, 13, 10]).toString('base64') },
];

test('validates input and refuses command injection', () => {
  assert.throws(() => validate({ host: 'ftp.example.com\r\nDELE x', user: 'a', password: 'b', files: [] }));
  assert.throws(() => validate({ host: 'ftp.example.com', user: 'a\r\nDELE x', password: 'b', files: [] }));
  assert.throws(() => validate({ host: 'ftp.example.com', user: 'a', password: 'b', files: [{ path: '../etc/passwd', data: '' }] }));
  assert.throws(() => validate({ host: 'ftp.example.com', user: 'a', password: 'b', port: 70000, files: [] }));
  const v = validate({ host: 'ftp://ftp.example.com/', user: 'a', password: 'b', dir: '/public_html/', files: [] });
  assert.equal(v.host, 'ftp.example.com');
  assert.equal(v.dir, '/public_html');
  assert.equal(v.port, 21);
});

test('uploads a site over plain FTP with nested folders', async () => {
  const s = await fakeServer();
  try {
    const r = await ftpPublish({ host: '127.0.0.1', port: s.port, user: 'web', password: 'secret', dir: '/www', files: SITE, remove: ['old.html'] });
    assert.equal(r.ok, true, r.log.join('\n'));
    assert.equal(s.files.get('/www/index.html').toString(), '<!doctype html><title>Home</title>');
    assert.equal(s.files.get('/www/css/site.css').toString(), 'body{margin:0}');
    assert.deepEqual([...s.files.get('/www/images/icons/dot.bin')], [0, 1, 2, 255, 13, 10]);
    assert.ok(!r.log.join('\n').includes('secret'), 'the password must not be logged');
    assert.ok(r.log.some((l) => l.includes('PASS ********')));
  } finally { s.server.close(); }
});

test('falls back to PASV and ignores the address in the reply', async () => {
  const s = await fakeServer({ noEpsv: true });
  try {
    const r = await ftpPublish({ host: '127.0.0.1', port: s.port, user: 'web', password: 'secret', files: SITE.slice(0, 1) });
    assert.equal(r.ok, true, r.log.join('\n'));
    assert.ok(s.files.has('/index.html'));
  } finally { s.server.close(); }
});

test('deletes files and reports a wrong password', async () => {
  const s = await fakeServer();
  try {
    await ftpPublish({ host: '127.0.0.1', port: s.port, user: 'web', password: 'secret', files: SITE.slice(0, 1) });
    const r = await ftpPublish({ host: '127.0.0.1', port: s.port, user: 'web', password: 'secret', files: [], remove: ['index.html'] });
    assert.equal(r.ok, true, r.log.join('\n'));
    assert.equal(s.files.size, 0);
    const bad = await ftpPublish({ host: '127.0.0.1', port: s.port, user: 'web', password: 'wrong', files: SITE });
    assert.equal(bad.ok, false);
    assert.ok(bad.log.some((l) => /Sign-in failed/.test(l)));
  } finally { s.server.close(); }
});

const cert = makeCert();
test('uploads over explicit FTPS', { skip: !cert && 'openssl is not available' }, async () => {
  const s = await fakeServer({ cert });
  try {
    const r = await ftpPublish({ host: '127.0.0.1', port: s.port, user: 'web', password: 'secret', secure: true, dir: 'site', files: SITE }, { tls: { ca: cert.cert } });
    assert.equal(r.ok, true, r.log.join('\n'));
    assert.ok(s.commands.includes('AUTH TLS'));
    assert.ok(s.commands.includes('PROT P'));
    assert.equal(s.files.get('/site/css/site.css').toString(), 'body{margin:0}');
  } finally { s.server.close(); }
});

test('refuses an untrusted FTPS certificate', { skip: !cert && 'openssl is not available' }, async () => {
  const s = await fakeServer({ cert });
  try {
    const r = await ftpPublish({ host: '127.0.0.1', port: s.port, user: 'web', password: 'secret', secure: true, files: SITE });
    assert.equal(r.ok, false);
    assert.equal(s.files.size, 0);
  } finally { s.server.close(); }
});
