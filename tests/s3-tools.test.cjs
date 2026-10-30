'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { sign } = require('../lib/s3.cjs');
const { TerminalManager } = require('../lib/terminals.cjs');
const { FileManager } = require('../lib/files.cjs');
const { parsePorts, scanPorts } = require('../lib/system.cjs');

const EMPTY = crypto.createHash('sha256').update('').digest('hex');

test('SigV4 matches the published AWS test vectors', () => {
  // AWS SigV4 test suite "get-vanilla".
  assert.equal(sign({ method: 'GET', host: 'example.amazonaws.com', path: '/', region: 'us-east-1', service: 'service', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', date: new Date('2015-08-30T12:36:00Z') }).signature,
    '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  // Amazon S3 documentation example: GET object with a Range header.
  assert.equal(sign({ method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', headers: { range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY }, region: 'us-east-1', service: 's3', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', date: new Date('2013-05-24T00:00:00Z') }).signature,
    'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

// In-memory S3-compatible endpoint that checks every request signature.
async function fakeS3(t, { accessKeyId = 'AKTEST', secret = 'secret-key' } = {}) {
  const buckets = new Map([['photos', new Map([['readme.txt', Buffer.from('hello s3')], ['2026/a.jpg', Buffer.from('jpeg')]])], ['backups', new Map()]]);
  const xml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks), url = new URL(request.url, 'http://x');
    const query = Object.fromEntries(url.searchParams);
    const signedHeaders = /SignedHeaders=([^,]+)/.exec(request.headers.authorization || '')?.[1].split(';') || [];
    const headers = Object.fromEntries(signedHeaders.filter(name => name !== 'host' && name !== 'x-amz-date').map(name => [name, request.headers[name]]));
    const expected = sign({ method: request.method, host: request.headers.host, path: url.pathname, query, headers, payloadHash: request.headers['x-amz-content-sha256'], region: 'us-east-1', accessKeyId, secretAccessKey: secret, date: new Date(request.headers['x-amz-date'].replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z')) });
    if (expected.headers.authorization !== request.headers.authorization) { response.writeHead(403); response.end('<Error><Code>SignatureDoesNotMatch</Code><Message>bad signature</Message></Error>'); return; }
    const [, bucketName, ...rest] = url.pathname.split('/').map(decodeURIComponent);
    const key = rest.join('/'), bucket = buckets.get(bucketName);
    if (!bucketName) { response.end(`<ListAllMyBucketsResult><Buckets>${[...buckets.keys()].map(name => `<Bucket><Name>${name}</Name><CreationDate>2026-01-01T00:00:00Z</CreationDate></Bucket>`).join('')}</Buckets></ListAllMyBucketsResult>`); return; }
    if (!bucket) { response.writeHead(404); response.end('<Error><Code>NoSuchBucket</Code></Error>'); return; }
    if (request.method === 'GET' && !key) {
      const prefix = query.prefix || '', folders = new Set(), files = [];
      for (const [name, data] of bucket) { if (!name.startsWith(prefix)) continue; const tail = name.slice(prefix.length), slash = tail.indexOf('/'); if (slash >= 0 && slash < tail.length - 1) folders.add(prefix + tail.slice(0, slash + 1)); else if (slash === tail.length - 1 && tail) folders.add(prefix + tail); else files.push([name, data]); }
      if (prefix && bucket.has(prefix)) files.push([prefix, bucket.get(prefix)]);
      response.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${files.map(([name, data]) => `<Contents><Key>${xml(name)}</Key><Size>${data.length}</Size><LastModified>2026-10-25T10:00:00Z</LastModified></Contents>`).join('')}${[...folders].filter(folder => folder !== prefix).map(folder => `<CommonPrefixes><Prefix>${xml(folder)}</Prefix></CommonPrefixes>`).join('')}</ListBucketResult>`);
      return;
    }
    if (request.method === 'PUT') {
      const source = request.headers['x-amz-copy-source'];
      if (source) { const [, from, ...fromKey] = source.split('/').map(decodeURIComponent); bucket.set(key, buckets.get(from).get(fromKey.join('/'))); response.end('<CopyObjectResult/>'); return; }
      bucket.set(key, body); response.end(); return;
    }
    const object = bucket.get(key);
    if (request.method === 'DELETE') { bucket.delete(key); response.writeHead(204); response.end(); return; }
    if (!object) { response.writeHead(404); response.end(request.method === 'HEAD' ? undefined : '<Error><Code>NoSuchKey</Code></Error>'); return; }
    response.writeHead(200, { 'Content-Length': object.length }); response.end(request.method === 'HEAD' ? undefined : object);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  return { buckets, endpoint: `http://127.0.0.1:${server.address().port}`, accessKeyId, secret };
}

test('S3 sessions browse buckets, edit, transfer, rename and delete objects', async t => {
  const s3 = await fakeS3(t);
  const terminals = new TerminalManager({ emit: () => {}, store: null, verifyHost: () => true });
  const files = new FileManager(terminals);
  await assert.rejects(terminals.openFiles({ type: 's3', host: s3.endpoint, username: s3.accessKeyId, password: 'wrong' }), /SignatureDoesNotMatch/);
  const session = await terminals.openFiles({ type: 's3', host: s3.endpoint, username: s3.accessKeyId, password: s3.secret });
  assert.deepEqual((await files.list({ id: session.id })).entries.map(entry => entry.name), ['backups', 'photos']);
  const photos = await files.list({ id: session.id, path: '/photos' });
  assert.deepEqual(photos.entries.map(entry => [entry.name, entry.type]), [['2026', 'directory'], ['readme.txt', 'file']]);
  assert.equal(photos.parent, '/');
  assert.deepEqual((await files.list({ id: session.id, path: '/photos/2026' })).entries.map(entry => entry.name), ['a.jpg']);
  assert.equal((await files.read({ id: session.id, path: '/photos/readme.txt' })).content, 'hello s3');
  await files.write({ id: session.id, path: '/photos/notes.txt', content: 'edited' });
  assert.equal(s3.buckets.get('photos').get('notes.txt').toString(), 'edited');
  await files.action({ id: session.id, action: 'rename', path: '/photos/notes.txt', newPath: '/backups/notes.txt' });
  assert.equal(s3.buckets.get('photos').has('notes.txt'), false); assert.equal(s3.buckets.get('backups').get('notes.txt').toString(), 'edited');
  await files.action({ id: session.id, action: 'mkdir', path: '/backups/new folder' });
  assert.ok(s3.buckets.get('backups').has('new folder/'));
  await assert.rejects(files.action({ id: session.id, action: 'delete', path: '/photos/2026' }), /not empty/);
  await files.action({ id: session.id, action: 'delete', path: '/backups/new folder' });
  assert.equal(s3.buckets.get('backups').has('new folder/'), false);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'termora-s3-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const local = path.join(temporary, 'upload.bin'); fs.writeFileSync(local, crypto.randomBytes(70000));
  await files.upload(session.id, local, '/backups/upload.bin');
  assert.deepEqual(s3.buckets.get('backups').get('upload.bin'), fs.readFileSync(local));
  await assert.rejects(files.upload(session.id, local, '/backups/upload.bin'), /exists/);
  await files.download(session.id, '/photos/2026/a.jpg', path.join(temporary, 'a.jpg'));
  assert.equal(fs.readFileSync(path.join(temporary, 'a.jpg'), 'utf8'), 'jpeg');
  const fixed = await terminals.openFiles({ type: 's3', host: s3.endpoint, username: s3.accessKeyId, password: s3.secret, path: 'photos' });
  assert.equal((await files.list({ id: fixed.id })).path, '/photos');
});

test('port scanner parses lists and finds open ports', async t => {
  assert.deepEqual(parsePorts('22, 80,8000-8002,22'), [22, 80, 8000, 8001, 8002]);
  assert.throws(() => parsePorts('1-5000'), /at most/); assert.throws(() => parsePorts('0'), /between/); assert.throws(() => parsePorts('ssh'), /Invalid/);
  const open = net.createServer(socket => socket.destroy()); open.listen(0, '127.0.0.1'); await once(open, 'listening');
  const closed = net.createServer(); closed.listen(0, '127.0.0.1'); await once(closed, 'listening');
  const closedPort = closed.address().port; closed.close();
  t.after(() => open.close());
  const result = await scanPorts({ host: '127.0.0.1', ports: `${open.address().port},${closedPort}` });
  assert.deepEqual(result.open.map(entry => entry.port), [open.address().port]);
  assert.equal(result.closed, 1); assert.equal(result.scanned, 2);
});
