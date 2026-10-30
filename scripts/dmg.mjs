// Writes a read-only macOS disk image without macOS tools: an HFSX (case-sensitive
// HFS+, Apple TN1150) volume wrapped in a zlib-compressed UDIF (.dmg) container.
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const BLOCK = 4096, CATALOG_NODE = 8192, EXTENTS_NODE = 4096, FIRST_ID = 16;
const HFS_EPOCH = Date.UTC(1904, 0, 1) / 1000;
const S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFLNK = 0o120000;

const hfsDate = date => (Math.floor(date.getTime() / 1000) - HFS_EPOCH) >>> 0;
const nameUnits = name => { const text = name.normalize('NFD').replace(/:/g, '/'); const units = []; for (let i = 0; i < text.length; i++) units.push(text.charCodeAt(i)); if (units.length > 255) throw new Error(`Name too long: ${name}`); return units; };
function catalogKey(parentID, units) {
  const key = Buffer.alloc(2 + 6 + units.length * 2);
  key.writeUInt16BE(6 + units.length * 2, 0); key.writeUInt32BE(parentID, 2); key.writeUInt16BE(units.length, 6);
  units.forEach((unit, i) => key.writeUInt16BE(unit, 8 + i * 2));
  return key;
}
// HFSX binary order: parent ID, then UTF-16 code units, shorter name first.
function compareKeys(a, b) {
  if (a.parentID !== b.parentID) return a.parentID - b.parentID;
  const length = Math.min(a.units.length, b.units.length);
  for (let i = 0; i < length; i++) if (a.units[i] !== b.units[i]) return a.units[i] - b.units[i];
  return a.units.length - b.units.length;
}
function bsdInfo(mode) { const info = Buffer.alloc(16); info.writeUInt32BE(99, 0); info.writeUInt32BE(99, 4); info.writeUInt16BE(mode, 10); return info; }
function forkData(logicalSize, startBlock, blockCount) {
  const fork = Buffer.alloc(80);
  fork.writeBigUInt64BE(BigInt(logicalSize), 0); fork.writeUInt32BE(blockCount, 12);
  if (blockCount) { fork.writeUInt32BE(startBlock, 16); fork.writeUInt32BE(blockCount, 20); }
  return fork;
}
function threadRecord(type, parentID, units) {
  const record = Buffer.alloc(8 + 2 + units.length * 2);
  record.writeInt16BE(type, 0); record.writeUInt32BE(parentID, 4); record.writeUInt16BE(units.length, 8);
  units.forEach((unit, i) => record.writeUInt16BE(unit, 10 + i * 2));
  return record;
}

// Packs sorted records into B-tree nodes; returns node buffers (header node first).
function buildBTree(records, { nodeSize, maxKeyLength, compareType, attributes }) {
  const nodes = [null];
  const pack = (items, kind, height) => {
    const made = [];
    let current = null;
    const close = () => { if (current) { made.push(current); current = null; } };
    for (const item of items) {
      const size = item.record.length;
      if (current && current.used + size + 2 * (current.items.length + 2) > nodeSize - 14) close();
      if (!current) current = { items: [], used: 0 };
      current.items.push(item); current.used += size;
    }
    close();
    const first = nodes.length;
    made.forEach((node, index) => {
      const buffer = Buffer.alloc(nodeSize);
      buffer.writeUInt32BE(index + 1 < made.length ? first + index + 1 : 0, 0);
      buffer.writeUInt32BE(index > 0 ? first + index - 1 : 0, 4);
      buffer.writeInt8(kind, 8); buffer.writeUInt8(height, 9); buffer.writeUInt16BE(node.items.length, 10);
      let offset = 14;
      node.items.forEach((item, i) => { buffer.writeUInt16BE(offset, nodeSize - 2 * (i + 1)); item.record.copy(buffer, offset); offset += item.record.length; });
      buffer.writeUInt16BE(offset, nodeSize - 2 * (node.items.length + 1));
      nodes.push(buffer);
    });
    return made.map((node, index) => ({ number: first + index, firstKey: node.items[0].key }));
  };
  let level = records.length ? pack(records.map(entry => ({ key: entry.key, record: entry.record })), -1, 1) : [];
  const leaves = level;
  let height = level.length ? 1 : 0;
  while (level.length > 1) {
    height++;
    level = pack(level.map(child => { const pointer = Buffer.alloc(4); pointer.writeUInt32BE(child.number); return { key: child.firstKey, record: Buffer.concat([child.firstKey, pointer]) }; }), 0, height);
  }
  const header = Buffer.alloc(nodeSize);
  header.writeInt8(1, 8); header.writeUInt16BE(3, 10);
  const totalNodes = nodes.length;
  if (totalNodes > (nodeSize - 256) * 8) throw new Error('B-tree too large for a single map record.');
  const record = Buffer.alloc(106);
  record.writeUInt16BE(height, 0); record.writeUInt32BE(level[0]?.number || 0, 2); record.writeUInt32BE(records.length, 6);
  record.writeUInt32BE(leaves[0]?.number || 0, 10); record.writeUInt32BE(leaves.at(-1)?.number || 0, 14);
  record.writeUInt16BE(nodeSize, 18); record.writeUInt16BE(maxKeyLength, 20); record.writeUInt32BE(totalNodes, 22); record.writeUInt32BE(0, 26);
  record.writeUInt32BE(nodeSize, 32); record.writeUInt8(0, 36); record.writeUInt8(compareType, 37); record.writeUInt32BE(attributes, 38);
  record.copy(header, 14);
  for (let node = 0; node < totalNodes; node++) header[248 + (node >> 3)] |= 0x80 >> (node & 7);
  header.writeUInt16BE(14, nodeSize - 2); header.writeUInt16BE(120, nodeSize - 4); header.writeUInt16BE(248, nodeSize - 6); header.writeUInt16BE(nodeSize - 8, nodeSize - 8);
  nodes[0] = header;
  return Buffer.concat(nodes);
}

// entries: [{ path: 'Termora.app/Contents/Info.plist', type: 'dir'|'file'|'symlink', mode, data }]
export function buildHfsVolume(entries, { volumeName = 'Termora', date = new Date() } = {}) {
  const stamp = hfsDate(date);
  const folders = new Map([['', { id: 2, parentID: 1, name: volumeName, children: 0, mode: S_IFDIR | 0o755 }]]);
  const files = [];
  let nextID = FIRST_ID;
  const folderFor = folderPath => {
    if (folders.has(folderPath)) return folders.get(folderPath);
    const slash = folderPath.lastIndexOf('/');
    const parent = folderFor(slash < 0 ? '' : folderPath.slice(0, slash));
    const folder = { id: nextID++, parentID: parent.id, name: folderPath.slice(slash + 1), children: 0, mode: S_IFDIR | 0o755 };
    parent.children++; folders.set(folderPath, folder);
    return folder;
  };
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const clean = entry.path.replace(/\/+$/, '');
    if (entry.type === 'dir') { const folder = folderFor(clean); folder.mode = S_IFDIR | (entry.mode & 0o7777 || 0o755); continue; }
    const slash = clean.lastIndexOf('/'), parent = folderFor(slash < 0 ? '' : clean.slice(0, slash));
    parent.children++;
    files.push({ id: nextID++, parentID: parent.id, name: clean.slice(slash + 1), symlink: entry.type === 'symlink', mode: (entry.type === 'symlink' ? S_IFLNK : S_IFREG) | (entry.mode & 0o7777 || 0o644), data: Buffer.from(entry.data) });
  }

  // Catalog records: a thread record and a file/folder record for every item.
  const records = [];
  const add = (parentID, name, record) => { const units = nameUnits(name); records.push({ parentID, units, key: catalogKey(parentID, units), record }); };
  for (const folder of folders.values()) {
    const units = nameUnits(folder.name), record = Buffer.alloc(88);
    record.writeInt16BE(1, 0); record.writeUInt32BE(folder.children, 4); record.writeUInt32BE(folder.id, 8);
    for (let i = 0; i < 4; i++) record.writeUInt32BE(stamp, 12 + i * 4);
    bsdInfo(folder.mode).copy(record, 32);
    add(folder.parentID, folder.name, record);
    add(folder.id, '', threadRecord(3, folder.parentID, units));
  }
  // Data blocks: block 0 holds the volume header; then allocation bitmap, B-trees, files.
  const fileBlocks = files.reduce((sum, file) => sum + Math.ceil(file.data.length / BLOCK), 0);
  // Generous upper bound for sizing the allocation bitmap (one bit per block).
  const catalogBound = Math.ceil(((records.length + files.length * 2) * 800) / BLOCK) + 8;
  const blockBound = 1 + 4 + catalogBound + fileBlocks + Math.ceil(fileBlocks * 0.02) + 64;
  const bitmapBlocks = Math.ceil(Math.ceil(blockBound / 8) / BLOCK);
  let catalog, totalBlocks;
  const bitmapStart = 1, extentsStart = bitmapStart + bitmapBlocks, catalogStart = extentsStart + EXTENTS_NODE / BLOCK;
  // File records need their final block numbers, so lay files out after a provisional catalog size.
  const layout = catalogBlocks => {
    let next = catalogStart + catalogBlocks;
    for (const file of files) { file.blocks = Math.ceil(file.data.length / BLOCK); file.start = file.blocks ? next : 0; next += file.blocks; }
    return next;
  };
  const fileRecords = () => files.flatMap(file => {
    const record = Buffer.alloc(248);
    record.writeInt16BE(2, 0); record.writeUInt16BE(0x0002, 2); record.writeUInt32BE(file.id, 8);
    for (let i = 0; i < 4; i++) record.writeUInt32BE(stamp, 12 + i * 4);
    bsdInfo(file.mode).copy(record, 32);
    if (file.symlink) { record.write('slnk', 48, 'latin1'); record.write('rhap', 52, 'latin1'); }
    forkData(file.data.length, file.start, file.blocks).copy(record, 88);
    return [{ parentID: file.parentID, name: file.name, record }, { parentID: file.id, name: '', record: threadRecord(4, file.parentID, nameUnits(file.name)) }];
  });
  const catalogTree = () => {
    const all = records.concat(fileRecords().map(item => { const units = nameUnits(item.name); return { parentID: item.parentID, units, key: catalogKey(item.parentID, units), record: item.record }; }));
    all.sort(compareKeys);
    return buildBTree(all.map(item => ({ key: item.key, record: Buffer.concat([item.key, item.record]) })), { nodeSize: CATALOG_NODE, maxKeyLength: 516, compareType: 0xbc, attributes: 6 });
  };
  let catalogBlocks = 2;
  for (let pass = 0; pass < 8; pass++) { layout(catalogBlocks); const size = catalogTree().length / BLOCK; if (size === catalogBlocks) break; catalogBlocks = size; }
  const usedEnd = layout(catalogBlocks);
  catalog = catalogTree();
  if (catalog.length / BLOCK !== catalogBlocks) throw new Error('Catalog layout did not converge.');
  totalBlocks = usedEnd + 1 + Math.max(16, Math.ceil(usedEnd * 0.01));
  if (Math.ceil(Math.ceil(totalBlocks / 8) / BLOCK) > bitmapBlocks) throw new Error('Allocation bitmap estimate too small.');
  const image = Buffer.alloc(totalBlocks * BLOCK);
  // Allocation bitmap: everything up to usedEnd plus the last block (alternate header).
  const bitmap = image.subarray(bitmapStart * BLOCK, (bitmapStart + bitmapBlocks) * BLOCK);
  const mark = block => { bitmap[block >> 3] |= 0x80 >> (block & 7); };
  for (let block = 0; block < usedEnd; block++) mark(block);
  mark(totalBlocks - 1);
  const freeBlocks = totalBlocks - usedEnd - 1;
  buildBTree([], { nodeSize: EXTENTS_NODE, maxKeyLength: 10, compareType: 0, attributes: 2 }).copy(image, extentsStart * BLOCK);
  catalog.copy(image, catalogStart * BLOCK);
  for (const file of files) if (file.blocks) file.data.copy(image, file.start * BLOCK);
  const header = Buffer.alloc(512);
  header.write('HX', 0, 'latin1'); header.writeUInt16BE(5, 2); header.writeUInt32BE(0x100 | 0x8000, 4); // unmounted, software-locked
  header.write('10.0', 8, 'latin1');
  for (const offset of [16, 20, 28]) header.writeUInt32BE(stamp, offset); // created, modified, checked
  header.writeUInt32BE(files.length, 32); header.writeUInt32BE(folders.size - 1, 36); header.writeUInt32BE(BLOCK, 40);
  header.writeUInt32BE(totalBlocks, 44); header.writeUInt32BE(freeBlocks, 48); header.writeUInt32BE(usedEnd, 52);
  header.writeUInt32BE(65536, 56); header.writeUInt32BE(65536, 60); header.writeUInt32BE(nextID, 64); header.writeUInt32BE(1, 68);
  header.writeBigUInt64BE(1n, 72);
  crypto.randomBytes(8).copy(header, 80 + 24); // volume UUID in Finder info words 6-7
  forkData(bitmapBlocks * BLOCK, bitmapStart, bitmapBlocks).copy(header, 112);
  forkData(EXTENTS_NODE, extentsStart, EXTENTS_NODE / BLOCK).copy(header, 192);
  forkData(catalog.length, catalogStart, catalogBlocks).copy(header, 272);
  header.writeUInt32BE(CATALOG_NODE, 272 + 8); header.writeUInt32BE(EXTENTS_NODE, 192 + 8);
  header.copy(image, 1024);
  header.copy(image, image.length - 1024);
  return { image, files: files.length, folders: folders.size, totalBlocks, freeBlocks };
}

// UDIF container ("UDZO"): 1 MiB zlib chunks, zero chunks stored as gaps, CRC32 checksums.
export function buildUdif(image, { name = 'Termora' } = {}) {
  if (image.length % 512) throw new Error('Image size must be a multiple of 512 bytes.');
  const SECTORS = 2048, sectorCount = image.length / 512, runs = [], chunks = [];
  let dataOffset = 0;
  for (let sector = 0; sector < sectorCount; sector += SECTORS) {
    const count = Math.min(SECTORS, sectorCount - sector), slice = image.subarray(sector * 512, (sector + count) * 512);
    if (slice.every(byte => byte === 0)) { runs.push({ type: 2, sector, count, offset: dataOffset, length: 0 }); continue; }
    const compressed = zlib.deflateSync(slice, { level: 9 });
    runs.push({ type: 0x80000005, sector, count, offset: dataOffset, length: compressed.length });
    chunks.push(compressed); dataOffset += compressed.length;
  }
  const dataFork = Buffer.concat(chunks);
  const checksum = value => { const block = Buffer.alloc(136); block.writeUInt32BE(2, 0); block.writeUInt32BE(32, 4); block.writeUInt32BE(value >>> 0, 8); return block; };
  const imageCrc = zlib.crc32(image) >>> 0;
  const mish = Buffer.alloc(204 + (runs.length + 1) * 40);
  mish.write('mish', 0, 'latin1'); mish.writeUInt32BE(1, 4); mish.writeBigUInt64BE(0n, 8); mish.writeBigUInt64BE(BigInt(sectorCount), 16);
  mish.writeBigUInt64BE(0n, 24); mish.writeUInt32BE(SECTORS + 8, 32); mish.writeUInt32BE(0, 36);
  checksum(imageCrc).copy(mish, 64); mish.writeUInt32BE(runs.length + 1, 200);
  runs.concat([{ type: 0xffffffff, sector: sectorCount, count: 0, offset: dataOffset, length: 0 }]).forEach((run, i) => {
    const at = 204 + i * 40;
    mish.writeUInt32BE(run.type, at); mish.writeBigUInt64BE(BigInt(run.sector), at + 8); mish.writeBigUInt64BE(BigInt(run.count), at + 16);
    mish.writeBigUInt64BE(BigInt(run.offset), at + 24); mish.writeBigUInt64BE(BigInt(run.length), at + 32);
  });
  const label = `${name} (Apple_HFSX : 0)`;
  const plist = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>resource-fork</key>
	<dict>
		<key>blkx</key>
		<array>
			<dict>
				<key>Attributes</key>
				<string>0x0050</string>
				<key>CFName</key>
				<string>${label}</string>
				<key>Data</key>
				<data>
				${mish.toString('base64').match(/.{1,52}/g).join('\n\t\t\t\t')}
				</data>
				<key>ID</key>
				<string>0</string>
				<key>Name</key>
				<string>${label}</string>
			</dict>
		</array>
		<key>plst</key>
		<array>
			<dict>
				<key>Attributes</key>
				<string>0x0050</string>
				<key>Data</key>
				<data>
				${Buffer.alloc(0x204).toString('base64').match(/.{1,52}/g).join('\n\t\t\t\t')}
				</data>
				<key>ID</key>
				<string>0</string>
				<key>Name</key>
				<string></string>
			</dict>
		</array>
	</dict>
</dict>
</plist>
`);
  const koly = Buffer.alloc(512);
  koly.write('koly', 0, 'latin1'); koly.writeUInt32BE(4, 4); koly.writeUInt32BE(512, 8); koly.writeUInt32BE(1, 12);
  koly.writeBigUInt64BE(0n, 16); koly.writeBigUInt64BE(0n, 24); koly.writeBigUInt64BE(BigInt(dataFork.length), 32);
  koly.writeUInt32BE(1, 56); koly.writeUInt32BE(1, 60); crypto.randomBytes(16).copy(koly, 64);
  checksum(zlib.crc32(dataFork)).copy(koly, 80);
  koly.writeBigUInt64BE(BigInt(dataFork.length), 216); koly.writeBigUInt64BE(BigInt(plist.length), 224);
  // As libdmg-hfsplus: CRC32 over each partition checksum word in little-endian order.
  const master = Buffer.alloc(4); master.writeUInt32LE(imageCrc);
  checksum(zlib.crc32(master)).copy(koly, 352);
  koly.writeUInt32BE(1, 488); koly.writeBigUInt64BE(BigInt(sectorCount), 492);
  return Buffer.concat([dataFork, plist, koly]);
}
