// =============================================================================
// store-only ZIP 打包器单测：验证结构合法、条目内容/CRC 正确、路径穿越被清洗
// 运行：cd server && npm test
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createStoreOnlyZip, type ZipEntry } from '../src/lib/zip';

// CRC-32（与 zip.ts 同算法）用于回读校验
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ParsedEntry {
  name: string;
  data: Buffer;
  crc: number;
  method: number;
}

/** 最小 ZIP 解析器：只回读本地文件头 + 数据，校验签名/方法/CRC。 */
function parseZip(buf: Buffer): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const sig = buf.readUInt32LE(pos);
    if (sig !== 0x04034b50) break; // 本地头结束
    const method = buf.readUInt16LE(pos + 8);
    const crc = buf.readUInt32LE(pos + 14);
    const compSize = buf.readUInt32LE(pos + 18);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    const name = buf.toString('utf8', pos + 30, pos + 30 + nameLen);
    const dataStart = pos + 30 + nameLen + extraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    entries.push({ name, data: Buffer.from(data), crc, method });
    pos = dataStart + compSize;
  }
  return entries;
}

test('store-only zip：多条目结构与内容正确', () => {
  const a = Buffer.from('hello world');
  const b = Buffer.from('second file content');
  const entries: ZipEntry[] = [
    { name: 'a.txt', data: a },
    { name: 'b.txt', data: b },
  ];

  const zip = createStoreOnlyZip(entries);
  assert.ok(zip.length > 0);
  // 首部是本地文件头
  assert.strictEqual(zip.readUInt32LE(0), 0x04034b50, '首部应为 Local File Header');
  // 尾部是 EOCD（固定 22 字节）
  const eocd = zip.readUInt32LE(zip.length - 22);
  assert.strictEqual(eocd, 0x06054b50, '尾部应为 End Of Central Directory');

  const parsed = parseZip(zip);
  assert.strictEqual(parsed.length, 2, '应解析出 2 个条目');

  const byName = new Map(parsed.map((e) => [e.name, e]));
  const ea = byName.get('a.txt');
  const eb = byName.get('b.txt');
  assert.ok(ea, 'a.txt 存在');
  assert.ok(eb, 'sub/b.txt 存在');

  assert.strictEqual(ea?.data.toString('utf8'), 'hello world');
  assert.strictEqual(eb?.data.toString('utf8'), 'second file content');
  assert.strictEqual(ea?.method, 0, '应为 store 方法（不压缩）');
  // CRC 与回算一致
  assert.strictEqual(ea?.crc, crc32(a), 'a.txt CRC 应匹配');
  assert.strictEqual(eb?.crc, crc32(b), 'b.txt CRC 应匹配');
});

test('zip：路径穿越被清洗为安全名', () => {
  const zip = createStoreOnlyZip([{ name: '../../evil.txt', data: Buffer.from('x') }]);
  const parsed = parseZip(zip);
  assert.strictEqual(parsed.length, 1);
  assert.ok(
    !parsed[0]!.name.includes('..'),
    `条目名不应包含上级引用，实际：${parsed[0]!.name}`,
  );
  assert.strictEqual(parsed[0]!.data.toString('utf8'), 'x');
});

test('zip：空条目数组生成合法空包（仅 EOCD）', () => {
  const zip = createStoreOnlyZip([]);
  assert.ok(zip.length >= 22);
  assert.strictEqual(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  // 条目数为 0
  assert.strictEqual(zip.readUInt16LE(zip.length - 22 + 10), 0);
});
