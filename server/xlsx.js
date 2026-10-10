'use strict';
// 零依赖的 .xlsx 读写模块
// - 解析：定位 ZIP 中央目录，用 zlib 原始解压读取 sharedStrings / sheet1，正则提取单元格
// - 生成：无压缩（STORED）ZIP + inlineStr 单元格，Excel/WPS 可直接打开

const zlib = require('zlib');

// ==================== ZIP ====================
function crc32(buf) {
  const CRC_TABLE = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** 打包为 ZIP（全部 STORED 不压缩） */
function zipStore(files) {
  const { time, date } = dosDateTime();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, f.data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(f.data.length, 20);
    cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));
    offset += 30 + nameBuf.length + f.data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/** 读取 ZIP 内全部文件（STORED 与 DEFLATE 均支持） */
function zipRead(buf) {
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx（zip）文件');
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let n = 0; n < count; n++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('xlsx 内部目录损坏');
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    const lnLen = buf.readUInt16LE(localOffset + 26);
    const leLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lnLen + leLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    entries[name] = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ==================== XML 辅助 ====================
function xmlDecode(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
function xmlEscape(s) {
  return String(s ?? '')
    .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
    // 去掉 XML 1.0 不允许的控制字符
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

// ==================== 解析 ====================
function parseSharedStrings(xml) {
  const out = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) {
    const texts = [];
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(m[1]))) texts.push(xmlDecode(t[1]));
    out.push(texts.join(''));
  }
  return out;
}

function colToIndex(ref) {
  let c = 0;
  for (const ch of ref) {
    if (ch >= 'A' && ch <= 'Z') c = c * 26 + (ch.charCodeAt(0) - 64);
    else break;
  }
  return c - 1;
}

function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row\b[^>]*?>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[1];
      const inner = cm[2] || '';
      const refM = attrs.match(/r="([A-Z]+)\d+"/);
      const idx = refM ? colToIndex(refM[1]) : cells.length;
      const tM = attrs.match(/t="([^"]+)"/);
      const type = tM ? tM[1] : 'n';
      let value = '';
      if (type === 'inlineStr') {
        const ts = [];
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let t;
        while ((t = tRe.exec(inner))) ts.push(xmlDecode(t[1]));
        value = ts.join('');
      } else {
        const vM = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
        if (vM) {
          const raw = xmlDecode(vM[1]);
          if (type === 's') value = shared[Number(raw)] ?? '';
          else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
          else if (type === 'str' || type === 'e') value = raw;
          else {
            const num = Number(raw);
            value = raw !== '' && !Number.isNaN(num) ? num : raw;
          }
        }
      }
      cells[idx] = value;
    }
    rows.push(cells);
  }
  return rows;
}

/** 解析 xlsx Buffer，返回二维数组（首个工作表），单元格值为 string | number */
function parseXlsxRows(buf) {
  const entries = zipRead(buf);
  const sheetNames = Object.keys(entries)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => (Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1])));
  if (!sheetNames.length) throw new Error('xlsx 中未找到工作表');
  const shared = entries['xl/sharedStrings.xml'] ? parseSharedStrings(entries['xl/sharedStrings.xml'].toString('utf8')) : [];
  return parseSheet(entries[sheetNames[0]].toString('utf8'), shared);
}

/** 二维数组 → 表头键值对象数组（首个非空行作为表头） */
function rowsToObjects(rows) {
  const headerIdx = rows.findIndex((r) => r.some((c) => String(c ?? '').trim() !== ''));
  if (headerIdx < 0) return [];
  const header = rows[headerIdx];
  const objects = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.some((c) => String(c ?? '').trim() !== '')) continue;
    const obj = {};
    header.forEach((h, idx) => {
      if (String(h ?? '').trim() === '') return;
      obj[String(h).trim()] = row[idx] ?? '';
    });
    objects.push(obj);
  }
  return objects;
}

// ==================== 生成 ====================
function colRef(i) {
  let s = '';
  i++;
  while (i > 0) {
    s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

/** 生成 xlsx Buffer（单工作表：headers + rows，数值单元格用数字类型，其余 inlineStr） */
function buildXlsx(headers, rows) {
  const cell = (v, ref) => {
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
  };
  const allRows = [headers, ...rows];
  const sheetRows = allRows
    .map((row, ri) => `<row r="${ri + 1}">${row.map((v, ci) => cell(v, `${colRef(ci)}${ri + 1}`)).join('')}</row>`)
    .join('');
  const files = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
        'utf8'
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        'utf8'
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        'utf8'
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
        'utf8'
      ),
    },
    {
      name: 'xl/styles.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`,
        'utf8'
      ),
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
        'utf8'
      ),
    },
  ];
  return zipStore(files);
}

// ==================== Excel 日期时间 ====================
/** Excel 日期序列号 → { date: 'YYYY-MM-DD', time: 'HH:MM' }（按 UTC 分解，避免时区漂移） */
function excelSerialToDateTime(n) {
  const ms = Math.round((n - 25569) * 86400000);
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
  };
}

/**
 * 单元格值 → { date, time }（date/time 可能为 null）
 * 支持：Excel 序列号、2026-09-23 20:00:00、2026/9/23 20:00、2026年9月23日 20:00、2026-09-23、20:30
 */
function cellToDateTime(v) {
  if (v === '' || v == null) return { date: null, time: null };
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v >= 20000 && v < 100000) return excelSerialToDateTime(v);
    if (v > 0 && v < 1) return { date: null, time: excelSerialToDateTime(v).time };
    return null;
  }
  const s = String(v).trim();
  const p = (x) => String(+x).padStart(2, '0');
  let m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?\s*(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (m) return { date: `${m[1]}-${p(m[2])}-${p(m[3])}`, time: `${p(m[4])}:${m[5]}` };
  m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  if (m) return { date: `${m[1]}-${p(m[2])}-${p(m[3])}`, time: null };
  m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (m) return { date: null, time: `${p(m[1])}:${m[2]}` };
  return null;
}

// 修改80：zipStore / zipRead / crc32 一并导出，供 datamgmt.js 的备份包 zip 化复用
// （函数本体自 xlsx 导出起即在此，仅扩大导出面，不改动任何实现）
module.exports = { parseXlsxRows, rowsToObjects, buildXlsx, cellToDateTime, excelSerialToDateTime, xmlEscape, zipStore, zipRead, crc32 };
