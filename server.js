const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { isSea } = require("node:sea");
const { spawn } = require("node:child_process");
const { createRequire } = require("node:module");

const HOST = "127.0.0.1";
const PORT = Number(process.env.CAREER_STUDIO_PORT || 8765);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("端口号无效。");
const APP_URL = `http://${HOST}:${PORT}`;
const ROOT = __dirname;
const requireLocal = createRequire(path.join(ROOT, "server.js"));
const { OCR_LIMIT, readJobPage, recognizeScreenshot } = requireLocal("./job-import.js");
const { listBundles, readBundle, applyBundle, fingerprint } = requireLocal("./conversation-records.js");
const DATA_DIR = path.join(ROOT, "data");
const INBOX_DIR = path.join(DATA_DIR, "对话收件箱");
const DATABASE_FILE = path.join(DATA_DIR, "求职工作台.db");
const LEGACY_JSON_FILE = path.join(DATA_DIR, "求职数据.json");
const MAX_BODY_SIZE = 20 * 1024 * 1024;
const COLLECTIONS = ["jobs", "experiences", "todos", "activities", "resumes"];
const staticFiles = new Map([
  ["/", ["index.html", "text/html"]], ["/index.html", ["index.html", "text/html"]],
  ...["job-fields.js", "resume-model.js", "resume-designer.js", "conversation-ui.js"].map(file => [`/${file}`, [file, "text/javascript"]]),
  ...["resume-designer.css", "resume-paper.css"].map(file => [`/${file}`, [file, "text/css"]])
]);
let writeQueue = Promise.resolve();

function emptyState() {
  return {
    profile: { name: "朋友", target: "", city: "", salary: "" },
    jobs: [],
    experiences: [],
    todos: [],
    activities: [],
    analyses: {},
    resumes: [],
    inboxReceipts: {}
  };
}

function openBrowser() {
  if (process.env.CAREER_STUDIO_NO_BROWSER === "1") return;
  const command = process.env.ComSpec || "cmd.exe";
  const child = spawn(command, ["/d", "/c", "start", "", APP_URL], {
    stdio: "ignore",
    windowsHide: true
  });
  child.on("error", error => {
    console.error("无法自动打开浏览器，请手动访问：" + APP_URL, error.message);
  });
  child.unref();
}

function isLocalOrigin(origin) {
  return origin === "null" || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin || "");
}

function setCommonHeaders(req, res) {
  const origin = req.headers.origin;
  if (isLocalOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function validData(data) {
  return data && !Array.isArray(data) && data.profile && typeof data.profile === "object" &&
    !Array.isArray(data.profile) && Array.isArray(data.jobs) && Array.isArray(data.experiences) &&
    Array.isArray(data.todos) && Array.isArray(data.activities) && Array.isArray(data.resumes) &&
    data.analyses && typeof data.analyses === "object" && !Array.isArray(data.analyses);
}

function readBody(req, limit = MAX_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) {
        const sizeLabel = limit >= 1024 * 1024 ? `${limit / 1024 / 1024} MB` : `${limit / 1024} KB`;
        reject(new Error(`请求数据超过 ${sizeLabel} 限制`));
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJson(text, label) {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object") throw new Error(label + "格式不正确");
  return value;
}

function initializeDatabase() {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  const database = new DatabaseSync(DATABASE_FILE);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analyses (
      job_id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
  `);
  for (const table of COLLECTIONS) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id TEXT PRIMARY KEY,
        row_order INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
  }

  const initialized = database.prepare("SELECT value FROM metadata WHERE key = 'initialized'").get();
  if (!initialized) {
    let initialState = emptyState();
    let migrationSource = "empty";
    if (fs.existsSync(LEGACY_JSON_FILE)) {
      try {
        const legacyData = parseJson(fs.readFileSync(LEGACY_JSON_FILE, "utf8"), "旧 JSON 数据");
        if (!validData(legacyData)) throw new Error("旧 JSON 数据结构不完整");
        initialState = legacyData;
        migrationSource = "求职数据.json";
      } catch (error) {
        throw new Error("数据库首次初始化失败，旧 JSON 无法迁移：" + error.message);
      }
    }
    writeStateSync(database, initialState);
    database.prepare("INSERT INTO metadata(key, value) VALUES ('initialized', ?)").run(new Date().toISOString());
    database.prepare("INSERT INTO metadata(key, value) VALUES ('migration_source', ?)").run(migrationSource);
    console.log(migrationSource === "empty" ? "已创建空数据库" : "已将现有 JSON 数据迁移到 SQLite 数据库");
  }
  return database;
}

function readStateSync(database) {
  const state = emptyState();
  const profileRow = database.prepare("SELECT data FROM profile WHERE id = 1").get();
  if (profileRow) state.profile = parseJson(profileRow.data, "个人资料");
  for (const table of COLLECTIONS) {
    state[table] = database.prepare(`SELECT data FROM ${table} ORDER BY row_order`).all()
      .map(row => parseJson(row.data, table));
  }
  state.analyses = Object.create(null);
  for (const row of database.prepare("SELECT job_id, data FROM analyses ORDER BY job_id").all()) {
    state.analyses[row.job_id] = parseJson(row.data, "岗位分析");
  }
  state.inboxReceipts = readInboxReceipts(database);
  return state;
}

function readInboxReceipts(database) {
  const row = database.prepare("SELECT value FROM metadata WHERE key = 'inbox_receipts'").get();
  return row ? parseJson(row.value, "对话记录收录清单") : {};
}

function readRevision(database) {
  return Number(database.prepare("SELECT value FROM metadata WHERE key = 'state_revision'").get()?.value || 0);
}

function writeStateSync(database, data, expectedRevision) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const revision = readRevision(database);
    if (expectedRevision !== undefined && expectedRevision !== revision) {
      const error = new Error("数据已在其他窗口更新。请重新读取数据库再保存。");
      error.status = 409;
      throw error;
    }
    database.prepare(`
      INSERT INTO profile(id, data) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data
    `).run(JSON.stringify(data.profile));

    for (const table of COLLECTIONS) {
      database.prepare(`DELETE FROM ${table}`).run();
      const insert = database.prepare(`INSERT INTO ${table}(id, row_order, data) VALUES (?, ?, ?)`);
      const ids = new Set();
      data[table].forEach((record, index) => {
        if (!record || typeof record !== "object" || Array.isArray(record)) {
          throw new Error(`${table} 中存在无效记录`);
        }
        const id = String(record.id || `${table}-${index + 1}`);
        if (ids.has(id)) throw new Error(`${table} 中存在重复 ID：${id}`);
        ids.add(id);
        insert.run(id, index, JSON.stringify(record));
      });
    }

    database.prepare("DELETE FROM analyses").run();
    const insertAnalysis = database.prepare("INSERT INTO analyses(job_id, data) VALUES (?, ?)");
    for (const [jobId, analysis] of Object.entries(data.analyses)) {
      if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
        throw new Error("岗位分析中存在无效记录");
      }
      insertAnalysis.run(jobId, JSON.stringify(analysis));
    }
    const metadata = database.prepare(`
      INSERT INTO metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    metadata.run("updated_at", new Date().toISOString());
    metadata.run("state_revision", String(revision + 1));
    if (data.inboxReceipts && typeof data.inboxReceipts === "object" && !Array.isArray(data.inboxReceipts)) {
      metadata.run("inbox_receipts", JSON.stringify(data.inboxReceipts));
    }
    database.exec("COMMIT");
    return revision + 1;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function queueWrite(action) {
  const operation = writeQueue.then(action);
  writeQueue = operation.catch(() => {});
  return operation;
}

const db = initializeDatabase();

function isWorkbenchRequest(req) {
  const host = req.headers.host;
  return [`${HOST}:${PORT}`, `localhost:${PORT}`].includes(host) &&
    (!req.headers.origin || req.headers.origin === `http://${host}`);
}

async function handleJobImport(req, res, endpoint, query) {
  if (!isWorkbenchRequest(req)) {
    sendJson(res, 403, { ok: false, message: "请从工作台页面发起岗位录入。" });
    return;
  }
  const type = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  try {
    if (endpoint === "/api/jobs/ocr") {
      const image = await readBody(req, OCR_LIMIT);
      const language = new URLSearchParams(query).get("language") || "zh-Hans-CN";
      sendJson(res, 200, await recognizeScreenshot(image, type, language));
      return;
    }
    if (type !== "application/json") throw new Error("请输入有效的岗位链接。");
    const data = parseJson((await readBody(req, 16 * 1024)).toString("utf8"), "岗位链接");
    sendJson(res, 200, await readJobPage(data.url));
  } catch (error) {
    sendJson(res, 400, { ok: false, message: error.message });
  }
}

async function handleInbox(req, res, endpoint) {
  if (!isWorkbenchRequest(req)) {
    sendJson(res, 403, { ok: false, message: "请在本机工作台查看对话记录。" });
    return;
  }
  try {
    if (endpoint === "/api/inbox" && req.method === "GET") {
      sendJson(res, 200, { items: await listBundles(INBOX_DIR, readInboxReceipts(db)) });
      return;
    }
    if (endpoint === "/api/inbox/accept" && req.method === "POST") {
      if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new Error("请选择有效的对话记录。");
      const input = parseJson((await readBody(req, 16 * 1024)).toString("utf8"), "收录记录");
      const bundle = await readBundle(INBOX_DIR, input.file);
      if (input.fingerprint !== fingerprint(bundle)) throw new Error("记录内容已更新，请返回列表重新预览。");
      const accepted = await queueWrite(() => {
        const revision = readRevision(db);
        const { state, result } = applyBundle(readStateSync(db), bundle);
        return { state, result, revision: writeStateSync(db, state, revision) };
      });
      sendJson(res, 200, accepted);
      return;
    }
    sendJson(res, 404, { ok: false, message: "接口不存在" });
  } catch (error) {
    sendJson(res, error.status || 400, { ok: false, message: error.message });
  }
}

async function handleApi(req, res) {
  if (req.method === "OPTIONS") {
    if (!isLocalOrigin(req.headers.origin)) {
      sendJson(res, 403, { ok: false, message: "仅允许本机页面访问" });
      return;
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/api/health" && req.method === "GET") {
    const counts = {};
    for (const table of COLLECTIONS) {
      counts[table] = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
    }
    sendJson(res, 200, { ok: true, app: "career-studio", storage: "sqlite", databaseFile: DATABASE_FILE, counts });
    return;
  }

  const [endpoint, query] = req.url.split("?", 2);
  if (["/api/inbox", "/api/inbox/accept"].includes(endpoint)) {
    await handleInbox(req, res, endpoint);
    return;
  }
  if (req.method === "POST" && ["/api/jobs/link", "/api/jobs/ocr"].includes(endpoint)) {
    await handleJobImport(req, res, endpoint, query);
    return;
  }

  if (req.url === "/api/data" && req.method === "GET") {
    try {
      sendJson(res, 200, { ...readStateSync(db), revision: readRevision(db) });
    } catch (error) {
      sendJson(res, 500, { ok: false, message: "无法读取 SQLite 数据库：" + error.message });
    }
    return;
  }

  if (req.url === "/api/data" && req.method === "PUT") {
    if (req.headers.origin && !isLocalOrigin(req.headers.origin)) {
      sendJson(res, 403, { ok: false, message: "仅允许本机页面修改数据" });
      return;
    }
    try {
      const body = await readBody(req);
      const data = parseJson(body.toString("utf8"), "请求数据");
      if (!validData(data)) {
        sendJson(res, 400, { ok: false, message: "数据格式不完整，已拒绝写入" });
        return;
      }
      const revision = await queueWrite(() => writeStateSync(db, data, data.revision));
      sendJson(res, 200, { ok: true, revision, savedAt: new Date().toISOString(), databaseFile: DATABASE_FILE });
    } catch (error) {
      sendJson(res, error.status || 400, { ok: false, message: "数据库保存失败：" + error.message });
    }
    return;
  }

  sendJson(res, 404, { ok: false, message: "接口不存在" });
}

const server = http.createServer(async (req, res) => {
  setCommonHeaders(req, res);
  if (req.url.startsWith("/api/")) {
    await handleApi(req, res);
    return;
  }

  const asset = staticFiles.get(req.url);
  if (req.method === "GET" && asset) {
    try {
      const [file, contentType] = asset;
      const content = await fsp.readFile(path.join(ROOT, file));
      res.writeHead(200, { "Content-Type": `${contentType}; charset=utf-8` });
      res.end(content);
    } catch (error) {
      sendJson(res, 500, { ok: false, message: "无法读取网页：" + error.message });
    }
    return;
  }

  if (req.url === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  sendJson(res, 404, { ok: false, message: "页面不存在" });
});

server.on("error", error => {
  if (error.code === "EADDRINUSE") {
    const occupied = () => {
      console.error("端口 " + PORT + " 已被其他程序占用，请关闭该程序后重试。");
      process.exitCode = 1;
    };
    http.get(`${APP_URL}/api/health`, { signal: AbortSignal.timeout(2000) }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("error", occupied);
      response.on("data", chunk => {
        body += chunk;
        if (body.length > 8192) response.destroy(new Error("响应过大"));
      });
      response.on("end", () => {
        try {
          const health = JSON.parse(body);
          if (response.statusCode === 200 && health.app === "career-studio" && health.databaseFile === DATABASE_FILE) {
            console.log("工作台已经启动，正在复用现有服务。");
            openBrowser();
            return;
          }
        } catch {}
        occupied();
      });
    }).on("error", occupied);
  } else {
    console.error("本地服务启动失败：", error.message);
    process.exitCode = 1;
  }
});

server.listen(PORT, HOST, () => {
  console.log("拾阶求职工作台已启动");
  console.log("网页地址：" + APP_URL);
  console.log("SQLite 数据库：" + DATABASE_FILE);
  console.log("浏览器将自动打开。使用期间请不要关闭本窗口，关闭即停止本地服务。");
  openBrowser();
  if (!isSea()) console.log("也可以按 Ctrl+C 停止本地服务");
});

function shutdown() {
  try { db.close(); } catch (error) {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
