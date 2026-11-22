const http = require("http");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "inventory.db");
const PUBLIC_DIR = path.join(ROOT, "public");
const SEED_PATH = process.env.STOCK_SEED || "";
const PORT = 8765;

const HEADER_ALIASES = {
  comment: ["comment"],
  footprint: ["footprint"],
  value: ["value"],
  mpn: ["manufacturer part", "manufacturer part number", "mpn"],
  qty: ["quantity", "qty", "数量"],
  designator: ["designator", "位号"],
  manufacturer: ["manufacturer", "厂家"],
  supplierPart: ["supplier part", "供应商型号", "lcsc part"],
  category: ["category", "分类"],
  no: ["no.", "no", "序号"],
};

function norm(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\uFEFF/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function cleanCell(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\uFEFF/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

function decodeBuffer(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString("utf16le").replace(/^\uFEFF/, "");
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString("utf16le").replace(/^\uFEFF/, "");
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf8");
  }
  const utf8 = buf.toString("utf8");
  if (/comment/i.test(utf8.slice(0, 500))) return utf8;
  try {
    const gbk = new TextDecoder("gbk").decode(buf);
    if (/comment/i.test(gbk.slice(0, 500))) return gbk;
  } catch {
    // This Node build has no GBK decoder. Fall through to UTF-8.
  }
  return utf8;
}

function detectDelimiter(text) {
  const first = text.split(/\r?\n/).find((line) => line.trim()) || "";
  const tabs = (first.match(/\t/g) || []).length;
  const commas = (first.match(/,/g) || []).length;
  return tabs >= commas ? "\t" : ",";
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cleanCell(cell) !== ""));
}

function headerIndex(headers, aliases) {
  const normalized = headers.map((header) => cleanCell(header).toLowerCase());
  return normalized.findIndex((header) => aliases.includes(header));
}

function cell(row, index) {
  if (index < 0) return "";
  return cleanCell(row[index] ?? "");
}

function parseQty(value) {
  const number = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(number) ? number : 0;
}

function parseBom(text) {
  const rows = parseDelimited(text, detectDelimiter(text));
  if (!rows.length) {
    throw new Error("表格是空的");
  }
  const headers = rows[0];
  const columns = Object.fromEntries(
    Object.entries(HEADER_ALIASES).map(([key, aliases]) => [key, headerIndex(headers, aliases)])
  );
  for (const key of ["comment", "footprint", "value", "mpn"]) {
    if (columns[key] < 0) {
      throw new Error("这不是嘉立创 BOM。表头需要有 Comment、Footprint、Value、Manufacturer Part");
    }
  }

  const parts = [];
  for (const row of rows.slice(1)) {
    const comment = cell(row, columns.comment);
    if (!comment || comment.includes("元器件成本")) continue;
    const footprint = cell(row, columns.footprint);
    const value = cell(row, columns.value);
    const mpn = cell(row, columns.mpn);
    parts.push({
      no: cell(row, columns.no),
      qty: parseQty(cell(row, columns.qty)),
      comment,
      designator: cell(row, columns.designator),
      footprint,
      value,
      mpn,
      manufacturer: cell(row, columns.manufacturer),
      supplierPart: cell(row, columns.supplierPart),
      category: cell(row, columns.category),
      commentKey: norm(comment),
      footprintKey: norm(footprint),
      valueKey: norm(value),
      mpnKey: norm(mpn),
    });
  }
  if (!parts.length) {
    throw new Error("表格里没有零件行");
  }
  return parts;
}

function judge(bomRow, stockRows) {
  const sameSpec = stockRows.filter(
    (item) =>
      item.comment_key === bomRow.commentKey &&
      item.footprint_key === bomRow.footprintKey &&
      item.value_key === bomRow.valueKey
  );
  const exact = sameSpec.filter((item) => item.mpn_key === bomRow.mpnKey);
  if (exact.length) return { status: "match", stock: exact };
  if (sameSpec.length) return { status: "param", stock: sameSpec };
  return { status: "missing", stock: [] };
}

function openDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comment TEXT NOT NULL,
      footprint TEXT NOT NULL,
      value TEXT NOT NULL,
      mpn TEXT NOT NULL,
      manufacturer TEXT NOT NULL DEFAULT '',
      supplier_part TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      qty REAL NOT NULL DEFAULT 0,
      comment_key TEXT NOT NULL,
      footprint_key TEXT NOT NULL,
      value_key TEXT NOT NULL,
      mpn_key TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ignored (
      comment_key TEXT NOT NULL,
      footprint_key TEXT NOT NULL,
      value_key TEXT NOT NULL,
      mpn_key TEXT NOT NULL,
      PRIMARY KEY (comment_key, footprint_key, value_key, mpn_key)
    );
  `);
  const columns = db.prepare("PRAGMA table_info(parts)").all();
  if (!columns.some((column) => column.name === "note")) {
    db.exec("ALTER TABLE parts ADD COLUMN note TEXT NOT NULL DEFAULT ''");
  }
  return db;
}

function seedStock(db) {
  const existing = db.prepare("SELECT COUNT(*) AS count FROM parts").get();
  if (existing.count > 0) return existing.count;
  if (!SEED_PATH || !fs.existsSync(SEED_PATH)) return 0;
  const parts = parseBom(decodeBuffer(fs.readFileSync(SEED_PATH)));
  const find = db.prepare(`
    SELECT id, qty FROM parts
    WHERE comment_key = ? AND footprint_key = ? AND value_key = ? AND mpn_key = ?
  `);
  const insert = db.prepare(`
    INSERT INTO parts (
      comment, footprint, value, mpn, manufacturer, supplier_part, category, qty,
      comment_key, footprint_key, value_key, mpn_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const addQty = db.prepare("UPDATE parts SET qty = qty + ? WHERE id = ?");
  const setMeta = db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");

  db.exec("BEGIN");
  try {
    for (const part of parts) {
      const found = find.get(part.commentKey, part.footprintKey, part.valueKey, part.mpnKey);
      if (found) {
        addQty.run(part.qty, found.id);
      } else {
        insert.run(
          part.comment,
          part.footprint,
          part.value,
          part.mpn,
          part.manufacturer,
          part.supplierPart,
          part.category,
          part.qty,
          part.commentKey,
          part.footprintKey,
          part.valueKey,
          part.mpnKey
        );
      }
    }
    setMeta.run("source", SEED_PATH);
    setMeta.run("imported_at", new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return db.prepare("SELECT COUNT(*) AS count FROM parts").get().count;
}

function listStock(db) {
  return db.prepare(`
    SELECT id, comment, footprint, value, mpn, manufacturer, supplier_part, category, qty, note
    FROM parts
    ORDER BY comment, footprint, value, mpn
  `).all();
}

function stockForJudge(db) {
  return db.prepare(`
    SELECT comment, footprint, value, mpn, manufacturer, supplier_part, qty, note,
           comment_key, footprint_key, value_key, mpn_key
    FROM parts
  `).all();
}

function publicStock(item) {
  return {
    comment: item.comment,
    footprint: item.footprint,
    value: item.value,
    mpn: item.mpn,
    note: item.note || "",
    manufacturer: item.manufacturer,
    supplierPart: item.supplier_part,
    qty: item.qty,
  };
}

function ignoreKey(part) {
  return [part.commentKey, part.footprintKey, part.valueKey, part.mpnKey].join("\0");
}

function ignoredKeys(db) {
  return new Set(
    db.prepare("SELECT comment_key, footprint_key, value_key, mpn_key FROM ignored").all()
      .map((item) => [item.comment_key, item.footprint_key, item.value_key, item.mpn_key].join("\0"))
  );
}

function checkBom(db, parts) {
  const stock = stockForJudge(db);
  const ignored = ignoredKeys(db);
  return parts.map((part) => {
    const result = judge(part, stock);
    return {
      no: part.no,
      designator: part.designator,
      comment: part.comment,
      footprint: part.footprint,
      value: part.value,
      mpn: part.mpn,
      manufacturer: part.manufacturer,
      qty: part.qty,
      status: result.status,
      ignored: ignored.has(ignoreKey(part)),
      stock: result.stock.map(publicStock),
    };
  });
}

function inboundPart(db, input) {
  const comment = cleanCell(input.comment);
  if (!comment) throw new Error("Comment 不能为空");
  const footprint = cleanCell(input.footprint);
  const value = cleanCell(input.value);
  const mpn = cleanCell(input.mpn);
  const note = cleanCell(input.note);
  const manufacturer = cleanCell(input.manufacturer);
  const qty = parseQty(input.qty);
  if (!(qty > 0)) throw new Error("数量要大于 0");
  const keys = [norm(comment), norm(footprint), norm(value), norm(mpn)];
  const find = db.prepare(`
    SELECT id FROM parts
    WHERE comment_key = ? AND footprint_key = ? AND value_key = ? AND mpn_key = ?
  `);
  const found = find.get(...keys);
  if (found) {
    db.prepare("UPDATE parts SET qty = qty + ? WHERE id = ?").run(qty, found.id);
    if (note) db.prepare("UPDATE parts SET note = ? WHERE id = ?").run(note, found.id);
  } else {
    db.prepare(`
      INSERT INTO parts (
        comment, footprint, value, mpn, manufacturer, supplier_part, category, qty, note,
        comment_key, footprint_key, value_key, mpn_key
      ) VALUES (?, ?, ?, ?, ?, '', '', ?, ?, ?, ?, ?, ?)
    `).run(comment, footprint, value, mpn, manufacturer, qty, note, ...keys);
  }
  return db.prepare(`
    SELECT id, comment, footprint, value, mpn, manufacturer, supplier_part, category, qty, note
    FROM parts
    WHERE comment_key = ? AND footprint_key = ? AND value_key = ? AND mpn_key = ?
  `).get(...keys);
}

function setIgnored(db, input) {
  const keys = [norm(input.comment), norm(input.footprint), norm(input.value), norm(input.mpn)];
  if (!keys[0]) throw new Error("Comment 不能为空");
  if (input.ignored) {
    db.prepare(`
      INSERT INTO ignored (comment_key, footprint_key, value_key, mpn_key)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(comment_key, footprint_key, value_key, mpn_key) DO NOTHING
    `).run(...keys);
    return true;
  }
  db.prepare(`
    DELETE FROM ignored
    WHERE comment_key = ? AND footprint_key = ? AND value_key = ? AND mpn_key = ?
  `).run(...keys);
  return false;
}

function readJson(req) {
  return readBody(req).then((raw) => {
    if (!raw.length) return {};
    return JSON.parse(raw.toString("utf8"));
  });
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
  });
  res.end(payload);
}

function contentType(filePath) {
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "text/html; charset=utf-8";
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const filePath = path.resolve(PUBLIC_DIR, requested);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(res, 404, { error: "没有这个页面" });
    return;
  }
  const body = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": contentType(filePath), "Content-Length": body.length });
  res.end(body);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("文件超过 8MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function start() {
  const db = openDatabase();
  const seeded = seedStock(db);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/api/stock") {
        const meta = db.prepare("SELECT v FROM meta WHERE k = 'source'").get();
        sendJson(res, 200, {
          source: meta ? meta.v : "",
          count: seeded,
          parts: listStock(db),
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/inbound") {
        const part = inboundPart(db, await readJson(req));
        sendJson(res, 200, { part });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/ignore") {
        const body = await readJson(req);
        sendJson(res, 200, { ignored: setIgnored(db, body) });
        return;
      }
      const noteMatch = url.pathname.match(/^\/api\/parts\/(\d+)\/note$/);
      if (req.method === "PATCH" && noteMatch) {
        const note = cleanCell((await readJson(req)).note);
        const updated = db.prepare("UPDATE parts SET note = ? WHERE id = ?").run(note, Number(noteMatch[1]));
        if (!updated.changes) throw new Error("没有这颗库存");
        sendJson(res, 200, { id: Number(noteMatch[1]), note });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/check") {
        const raw = await readBody(req);
        if (!raw.length) {
          sendJson(res, 400, { error: "没有收到表格" });
          return;
        }
        const rows = checkBom(db, parseBom(decodeBuffer(raw)));
        const summary = {
          total: rows.length,
          match: rows.filter((row) => row.status === "match").length,
          param: rows.filter((row) => row.status === "param").length,
          missing: rows.filter((row) => row.status === "missing").length,
        };
        sendJson(res, 200, { summary, rows });
        return;
      }
      if (req.method === "GET") {
        serveStatic(req, res);
        return;
      }
      sendJson(res, 404, { error: "没有这个接口" });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "处理失败" });
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", (error) => {
      error.port = PORT;
      reject(error);
    });
    server.listen(PORT, "127.0.0.1", () => {
      console.log(`库存 ${seeded} 种零件`);
      console.log(`打开 http://127.0.0.1:${PORT}`);
      resolve({ port: PORT, server });
    });
  });
}

module.exports = { parseBom, decodeBuffer, norm, judge, start, PORT };

if (require.main === module) {
  start().catch((error) => {
    if (error.code === "EADDRINUSE") {
      console.log(`已经在运行，直接打开 http://127.0.0.1:${PORT}`);
      process.exit(0);
    }
    console.error(error);
    process.exit(1);
  });
}
