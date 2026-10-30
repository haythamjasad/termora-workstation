// Reads back a UDIF image and its HFS+/HFSX volume, used to verify the DMG writer.
import zlib from 'node:zlib';

export function readUdif(dmg) {
  const koly = dmg.subarray(dmg.length - 512);
  if (koly.toString('latin1', 0, 4) !== 'koly') throw new Error('Missing koly trailer.');
  const dataLength = Number(koly.readBigUInt64BE(32)), xmlOffset = Number(koly.readBigUInt64BE(216)), xmlLength = Number(koly.readBigUInt64BE(224));
  const sectorCount = Number(koly.readBigUInt64BE(492));
  if (koly.readUInt32BE(80) === 2 && (zlib.crc32(dmg.subarray(0, dataLength)) >>> 0) !== koly.readUInt32BE(88)) throw new Error('Data fork checksum mismatch.');
  const xml = dmg.subarray(xmlOffset, xmlOffset + xmlLength).toString('utf8');
  const blkx = /<key>blkx<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1];
  if (!blkx) throw new Error('No blkx resource.');
  const image = Buffer.alloc(sectorCount * 512);
  for (const match of blkx.matchAll(/<data>([\s\S]*?)<\/data>/g)) {
    const mish = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
    if (mish.toString('latin1', 0, 4) !== 'mish') throw new Error('Bad mish block.');
    const first = Number(mish.readBigUInt64BE(8)), runs = mish.readUInt32BE(200);
    for (let i = 0; i < runs; i++) {
      const at = 204 + i * 40, type = mish.readUInt32BE(at), sector = Number(mish.readBigUInt64BE(at + 8)), count = Number(mish.readBigUInt64BE(at + 16));
      const offset = Number(mish.readBigUInt64BE(at + 24)), length = Number(mish.readBigUInt64BE(at + 32));
      if (type === 0xffffffff) break;
      if (type === 0x80000005) { const data = zlib.inflateSync(dmg.subarray(offset, offset + length)); if (data.length !== count * 512) throw new Error('Chunk size mismatch.'); data.copy(image, (first + sector) * 512); }
      else if (type === 1) dmg.copy(image, (first + sector) * 512, offset, offset + length);
      else if (type !== 2 && type !== 0) throw new Error(`Unsupported run type ${type.toString(16)}.`);
    }
    if (mish.readUInt32BE(64) === 2 && (zlib.crc32(image) >>> 0) !== mish.readUInt32BE(72)) throw new Error('Partition checksum mismatch.');
  }
  return image;
}

export function readHfs(image) {
  const header = image.subarray(1024, 1536);
  const signature = header.toString('latin1', 0, 2);
  if (!['H+', 'HX'].includes(signature)) throw new Error('Not an HFS+ volume.');
  if (!header.equals(image.subarray(image.length - 1024, image.length - 512))) throw new Error('Alternate volume header differs.');
  const blockSize = header.readUInt32BE(40), totalBlocks = header.readUInt32BE(44);
  if (totalBlocks * blockSize !== image.length) throw new Error('Volume size mismatch.');
  const fork = offset => ({ size: Number(header.readBigUInt64BE(offset)), start: header.readUInt32BE(offset + 16), blocks: header.readUInt32BE(offset + 20) });
  const catalogFork = fork(272), bitmapFork = fork(112);
  const catalog = image.subarray(catalogFork.start * blockSize, catalogFork.start * blockSize + catalogFork.size);
  const nodeSize = catalog.readUInt16BE(14 + 18), compare = catalog.readUInt8(14 + 37);
  const records = [];
  const nodeAt = number => catalog.subarray(number * nodeSize, (number + 1) * nodeSize);
  const recordsOf = node => { const count = node.readUInt16BE(10); return Array.from({ length: count }, (_, i) => node.readUInt16BE(nodeSize - 2 * (i + 1))).map((start, i, all) => node.subarray(start, i + 1 < count ? all[i + 1] : node.readUInt16BE(nodeSize - 2 * (count + 1)))); };
  // Descend from the root through index nodes to check the tree shape, then walk the leaf chain.
  let depth = catalog.readUInt16BE(14), node = catalog.readUInt32BE(16);
  for (let level = depth; level > 1; level--) { const current = nodeAt(node); if (current.readInt8(8) !== 0 || current.readUInt8(9) !== level) throw new Error('Bad index node.'); const first = recordsOf(current)[0]; node = first.readUInt32BE(2 + first.readUInt16BE(0)); }
  if (node !== catalog.readUInt32BE(14 + 10)) throw new Error('Leftmost path does not reach the first leaf.');
  for (let number = node; number; number = nodeAt(number).readUInt32BE(0)) {
    const current = nodeAt(number);
    if (current.readInt8(8) !== -1) throw new Error('Leaf chain reached a non-leaf node.');
    for (const record of recordsOf(current)) {
      const keyLength = record.readUInt16BE(0), parentID = record.readUInt32BE(2), nameLength = record.readUInt16BE(6);
      const name = String.fromCharCode(...Array.from({ length: nameLength }, (_, i) => record.readUInt16BE(8 + i * 2)));
      records.push({ parentID, name, data: record.subarray(2 + keyLength) });
    }
  }
  if (records.length !== catalog.readUInt32BE(14 + 6)) throw new Error('Leaf record count mismatch.');
  for (let i = 1; i < records.length; i++) {
    const a = records[i - 1], b = records[i];
    const order = a.parentID - b.parentID || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    if (order >= 0) throw new Error(`Catalog records out of order at ${b.name}.`);
  }
  // Rebuild paths from folder/file records.
  const byID = new Map([[1, { path: null }]]), items = [];
  const folders = records.filter(record => record.data.readInt16BE(0) === 1).sort((a, b) => a.data.readUInt32BE(8) - b.data.readUInt32BE(8));
  const pathOf = (parentID, name) => { const parent = byID.get(parentID); if (!parent) throw new Error(`Orphan record ${name}.`); return parent.path === null ? '' : parent.path ? `${parent.path}/${name}` : name; };
  for (const folder of folders) { const id = folder.data.readUInt32BE(8); byID.set(id, { path: folder.parentID === 1 ? '' : pathOf(folder.parentID, folder.name), mode: folder.data.readUInt16BE(42), valence: folder.data.readUInt32BE(4) }); }
  for (const record of records) {
    const type = record.data.readInt16BE(0);
    if (type === 1 && record.parentID !== 1) items.push({ path: byID.get(record.data.readUInt32BE(8)).path, type: 'dir', mode: record.data.readUInt16BE(42) });
    if (type === 2) {
      const mode = record.data.readUInt16BE(42), size = Number(record.data.readBigUInt64BE(88)), start = record.data.readUInt32BE(104);
      const data = image.subarray(start * blockSize, start * blockSize + size);
      items.push({ path: pathOf(record.parentID, record.name), type: (mode & 0o170000) === 0o120000 ? 'symlink' : 'file', mode, data, creator: record.data.toString('latin1', 52, 56) });
    }
  }
  const bitmap = image.subarray(bitmapFork.start * blockSize);
  let used = 0; for (let block = 0; block < totalBlocks; block++) if (bitmap[block >> 3] & (0x80 >> (block & 7))) used++;
  if (used !== totalBlocks - header.readUInt32BE(48)) throw new Error('Free block count disagrees with the allocation bitmap.');
  return { signature, compare, items, fileCount: header.readUInt32BE(32), folderCount: header.readUInt32BE(36), volumeName: records.find(record => record.parentID === 1)?.name };
}
