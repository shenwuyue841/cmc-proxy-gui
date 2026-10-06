#!/usr/bin/env node
/**
 * cmc-gui —— cmc-proxy 的本地控制台（一期 MVP）
 * ==============================================
 * 设计原则：**完全不修改 proxy.js**。独立进程、独立端口、只读为主。
 *
 * 用法:
 *   node gui.js                 # 监听 127.0.0.1:5419
 *   node gui.js --port 5419     # 自定义端口
 *
 * 安全边界:
 *   1. 仅绑定 127.0.0.1（config.json 含 apiKey，绝不出网）
 *   2. 停止代理时**只允许停止本进程自己启动的那个**；外部启动的实例一律不动
 *   3. 写 config.json 前自动备份到 backups/
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawn, spawnSync } = require("child_process");

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, "config.json");
const GUI_CONFIG_PATH = path.join(ROOT, "gui.config.json");
const PRICES_PATH = path.join(ROOT, "goat-prices.json");
const BACKUP_DIR = path.join(ROOT, "backups");

// ---------------------------------------------------------------------------
// 控制台自己的配置（与上游 config.json 分开存，避免改动上游的配置契约）
//   优先级：命令行 > 环境变量 > gui.config.json > 内置默认
// ---------------------------------------------------------------------------
const GUI_DEFAULTS = {
  port: 5419,                          // 控制台监听端口
  proxy: "",                           // 出网代理，如 http://127.0.0.1:10809；空 = 直连
  officialApi: true,                   // 是否启用「官方额度」查询
  title: "cmc 控制台",                  // 侧边栏标题
};

function readGuiConfigRaw() {
  try {
    return JSON.parse(fs.readFileSync(GUI_CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function readGuiConfig() {
  const raw = readGuiConfigRaw();
  const out = { ...GUI_DEFAULTS };
  for (const k of Object.keys(GUI_DEFAULTS)) {
    if (raw[k] !== undefined && raw[k] !== null) out[k] = raw[k];
  }
  out.port = parseInt(out.port, 10) || GUI_DEFAULTS.port;
  return out;
}

/** 首次运行时把默认配置落盘，用户能直接看到有哪些可调项 */
function ensureGuiConfig() {
  if (fs.existsSync(GUI_CONFIG_PATH)) return;
  try {
    fs.writeFileSync(GUI_CONFIG_PATH, JSON.stringify(GUI_DEFAULTS, null, 2) + "\n", "utf8");
  } catch { /* 只读目录就跳过 */ }
}

const args = process.argv.slice(2);
const argVal = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

ensureGuiConfig();
const GUI_CFG = readGuiConfig();

// ---------------------------------------------------------------------------
// 出网代理自配置
// Node 的 fetch(undici) 默认不读 HTTP_PROXY/HTTPS_PROXY，必须靠 NODE_USE_ENV_PROXY=1 打开。
// undici 是**懒加载**的 —— 只要在第一次 fetch 之前把变量设好就有效，
// 所以即使不用 start-gui.bat 启动、直接 `node gui.js` 也能出网。
//
// ⚠️ 一旦发生过第一次 fetch，undici 就建好了全局 dispatcher，之后再改变量不生效。
//    「设置」页里改代理会提示需要重启控制台，原因就在这。
// ---------------------------------------------------------------------------
const PROXY_URL =
  process.env.CMC_PROXY ||
  argVal("--proxy", null) ||
  GUI_CFG.proxy ||
  "";

if (PROXY_URL && PROXY_URL !== "none") {
  if (!process.env.NODE_USE_ENV_PROXY) process.env.NODE_USE_ENV_PROXY = "1";
  if (!process.env.HTTPS_PROXY && !process.env.https_proxy) {
    process.env.HTTPS_PROXY = PROXY_URL;
    process.env.HTTP_PROXY = PROXY_URL;
  }
  if (!process.env.NO_PROXY && !process.env.no_proxy) {
    process.env.NO_PROXY = "localhost,127.0.0.1,::1";
  }
}

const GUI_PORT = parseInt(argVal("--port", String(GUI_CFG.port)), 10);
const GUI_HOST = "127.0.0.1";
/** --auto-start: 控制台启动时若代理端口空闲，就顺手把它拉起来（一步到位） */
const AUTO_START = args.includes("--auto-start");
/** --open: 启动后自动打开默认浏览器（由 launcher 传入） */
const OPEN_BROWSER = args.includes("--open");
/** --no-open: 明确不要打开浏览器（优先级高于 --open，方便自动化） */
const NO_OPEN = args.includes("--no-open");
/** --stop-all: 停掉监听「代理端口 / 控制台端口」的进程后退出（给 stop-all.bat 用） */
const STOP_ALL = args.includes("--stop-all");

// 窗口标题（Windows 下会作用到运行本程序的 cmd 窗口）
try { process.title = `cmc 控制台 - ${GUI_HOST}:${GUI_PORT}`; } catch { /* 忽略 */ }

// ---------------------------------------------------------------------------
// 配置读写
// ---------------------------------------------------------------------------

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

// ---------------------------------------------------------------------------
// apiKey 掩码
// 前端永远看不到明文 Key：出参一律掩码成 `user_****abcd`（保留末 4 位便于辨认"换没换"），
// 入参若带掩码特征（含 ****）则保留原值 —— 这样「原始配置」页把整份 config 原样 PUT 回来
// 也不会把掩码写进磁盘。**这是本地安全边界的一部分，改动前先想清楚。**
// ---------------------------------------------------------------------------
const MASK_RE = /\*{4,}/;

function maskKey(k) {
  if (typeof k !== "string" || !k) return k;
  if (k.length <= 4) return "****";
  return k.slice(0, k.indexOf("_") >= 0 ? k.indexOf("_") + 1 : 0) + "****" + k.slice(-4);
}

function isMasked(v) {
  return typeof v === "string" && MASK_RE.test(v);
}

/** 出参：把 config 里所有敏感字段换成掩码 */
function configForClient(cfg) {
  const out = { ...cfg };
  if (out.apiKey !== undefined) out.apiKey = maskKey(out.apiKey);
  return out;
}

/** 入参：把掩码还原成磁盘上的真实值（其它字段原样采纳） */
function mergeConfigFromClient(next, current) {
  const merged = { ...next };
  if (isMasked(merged.apiKey)) merged.apiKey = current.apiKey;
  return merged;
}

/** 原子写 + 备份（备份目录已在 .gitignore 里） */
function writeConfigAtomic(next) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(CONFIG_PATH, path.join(BACKUP_DIR, `config-${stamp}.json`));
  const tmp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, CONFIG_PATH);
}

function writeGuiConfig(next) {
  const merged = { ...readGuiConfigRaw(), ...next };
  // 只保留已知键，避免把垃圾写进去
  const out = {};
  for (const k of Object.keys(GUI_DEFAULTS)) {
    if (merged[k] !== undefined) out[k] = merged[k];
  }
  const tmp = GUI_CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, GUI_CONFIG_PATH);
  return readGuiConfig();
}

/** 解析 jsonlLog 配置 -> 绝对路径 (与 proxy.js 同口径) */
function resolveJsonlPath(config) {
  const v = config.jsonlLog;
  if (v === false || v == null) return null;
  return typeof v === "string"
    ? path.resolve(ROOT, v)
    : path.join(ROOT, "logs", "requests.jsonl");
}

function loadPrices() {
  try {
    return JSON.parse(fs.readFileSync(PRICES_PATH, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 端口 / 进程探测
// ---------------------------------------------------------------------------

/** 端口是否被占用（TCP 连接测试） */
function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.setTimeout(1200, () => {
      s.destroy();
      resolve(false);
    });
  });
}

/** 取监听某端口的 PID（Windows netstat，直接调 exe 不经 shell）
 *  返回 number    —— 找到了
 *  返回 null      —— netstat 正常执行，该端口确实没有监听
 *  返回 undefined —— 探测本身失败（netstat 不可用/被拦），**调用方必须区别对待**，
 *                    否则会把"查不到"误报成"没有进程"
 */
function pidOnPort(port) {
  let r;
  try {
    r = spawnSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true });
  } catch {
    return undefined;
  }
  if (r.error || !r.stdout) return undefined;
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.includes("LISTENING")) continue;
    const f = line.trim().split(/\s+/);
    if (f.length >= 5 && f[1].endsWith(":" + port)) return parseInt(f[4], 10);
  }
  return null;
}

const PROBE_FAIL_MSG = "无法探测端口占用（netstat 不可用）。可用任务管理器结束对应进程，或检查是否被安全软件拦截。";

// ---------------------------------------------------------------------------
// 代理子进程管理（只管理自己启动的那个）
// ---------------------------------------------------------------------------

let child = null;
const childLog = [];
const CHILD_LOG_MAX = 400;

function pushChildLog(s) {
  for (const line of String(s).split(/\r?\n/)) {
    if (!line.trim()) continue;
    childLog.push(line.replace(/\x1b\[[0-9;]*m/g, ""));
    if (childLog.length > CHILD_LOG_MAX) childLog.shift();
  }
}

async function startProxy() {
  if (child) return { ok: false, message: "本控制台已经启动了一个实例" };
  if (!fs.existsSync(path.join(ROOT, "proxy.js"))) {
    return {
      ok: false,
      message: "本目录里没有 proxy.js —— 控制台只是界面，代理本体要放在同一个目录。"
        + "请把 cmc-proxy 的 proxy.js / config.json 放到这里，或把本仓库的文件复制进你的 cmc-proxy 目录。",
    };
  }
  const cfg = readConfig();
  const proxyPort = cfg.port || 5411;
  if (await portInUse(proxyPort)) {
    return {
      ok: false,
      message: `端口 ${proxyPort} 已被占用（可能是你手动启动的实例）。本控制台不会重复启动，也不会去动它。`,
    };
  }
  let spawnErr = null;
  const p = spawn(process.execPath, ["proxy.js"], {
    cwd: ROOT,
    env: process.env,
    windowsHide: true,
  });
  p.on("error", (e) => {
    spawnErr = e;
    pushChildLog("[gui] 启动失败: " + e.message);
    child = null;
  });
  p.stdout.on("data", (d) => pushChildLog(d));
  p.stderr.on("data", (d) => pushChildLog(d));
  p.on("exit", (code) => {
    pushChildLog(`[gui] 代理进程已退出 (code=${code})`);
    child = null;
  });
  child = p;
  await new Promise((r) => setTimeout(r, 1500));
  if (spawnErr) return { ok: false, message: "启动失败: " + spawnErr.message };
  if (!(await portInUse(proxyPort))) {
    return { ok: false, message: `已拉起进程（PID ${p.pid}）但端口 ${proxyPort} 还没监听，请看下方输出排查。` };
  }
  return { ok: true, message: `已启动（PID ${p.pid}）` };
}

/**
 * 强制停止：停掉"监听该端口的那个进程"，不管是谁启动的。
 * 用于收拾孤儿进程（比如控制台窗口被关掉、但代理还在跑）。
 * 需要显式 force=true 才走这里，不会误伤。
 */
async function forceStopProxy(port) {
  // 1) 若是本控制台启动的实例 —— 直接用句柄结束，不必依赖 netstat
  if (child) {
    const pid = child.pid;
    try {
      child.kill();
    } catch { /* 落到下面的兜底 */ }
    await new Promise((res) => setTimeout(res, 900));
    if (!(await portInUse(port))) {
      child = null;
      return { ok: true, message: `已停止 PID ${pid}（端口 ${port} 已释放）` };
    }
    // 句柄杀不掉，继续走 taskkill
  }

  // 2) 外部实例（或句柄失效）—— 找监听该端口的进程再结束
  const pid = pidOnPort(port);
  if (pid === undefined) return { ok: false, message: PROBE_FAIL_MSG };
  if (pid === null) {
    child = null;
    return { ok: false, message: `端口 ${port} 上没有监听进程（可能已经停了）。` };
  }
  const r = spawnSync("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true });
  await new Promise((res) => setTimeout(res, 800));
  if (await portInUse(port)) {
    const why =
      (r.stderr || r.stdout || "").toString().trim().split(/\r?\n/)[0] ||
      (r.error ? r.error.code : `taskkill 退出码 ${r.status}`);
    return { ok: false, message: `停止 PID ${pid} 失败：${why}。试试用管理员身份运行。` };
  }
  if (child && child.pid === pid) child = null;
  return { ok: true, message: `已强制停止 PID ${pid}（端口 ${port} 已释放）` };
}

function stopProxy() {
  if (!child) {
    return {
      ok: false,
      message: "本控制台没有自己启动的实例。外部启动的实例不会被停止（避免打断你正在用的会话）。",
    };
  }
  const pid = child.pid;
  try {
    // 优先用 Node 自带的 kill（不经 shell，Windows 下走 TerminateProcess）
    child.kill();
    return { ok: true, message: `已停止（PID ${pid}）` };
  } catch (e) {
    // 兜底：直接调 taskkill.exe（不经 cmd.exe）
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true });
      return { ok: true, message: `已停止（PID ${pid}，经 taskkill）` };
    } catch (e2) {
      return { ok: false, message: `停止失败：${e.message} / ${e2.message}。可手动关闭它的窗口。` };
    }
  }
}

// ---------------------------------------------------------------------------
// 用量汇总（从 JSONL 读，跨进程有效 —— 不依赖谁启动的代理）
// ---------------------------------------------------------------------------

function jsonlFilesFor(days) {
  const cfg = readConfig();
  const hot = resolveJsonlPath(cfg);
  if (!hot) return [];
  const dir = path.dirname(hot);
  const files = [];
  if (fs.existsSync(hot)) files.push(hot);
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^requests-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) files.push(path.join(dir, f));
    }
  } catch { /* 忽略 */ }
  const cutoff = Date.now() - days * 86400e3;
  return files.filter((f) => {
    try { return fs.statSync(f).mtimeMs >= cutoff - 86400e3; } catch { return false; }
  });
}

function aggregateUsage(days) {
  const files = jsonlFilesFor(days);
  const cutoff = Date.now() - days * 86400e3;
  const t = {
    requests: 0, ok: 0, fail: 0, cost: 0, credit: 0,
    in: 0, out: 0, rt: 0, cr: 0, cw: 0,
    msSum: 0, msCount: 0, ttfbSum: 0, ttfbCount: 0,
  };
  const byModel = new Map();
  const byDay = new Map();
  const recent = [];

  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.event !== "request") continue;
      const ts = Date.parse(r.ts);
      if (!Number.isFinite(ts) || ts < cutoff) continue;

      const u = (r.res && r.res.usage) || null;
      const cost = (r.res && r.res.cost) || 0;
      const credit = (r.res && r.res.credit) || 0;
      const status = (r.http && r.http.status) || 0;
      const model = (r.res && r.res.model) || (r.req && r.req.model) || "-";

      t.requests++;
      status >= 200 && status < 300 ? t.ok++ : t.fail++;
      t.cost += cost; t.credit += credit;
      if (u) { t.in += u.in || 0; t.out += u.out || 0; t.rt += u.rt || 0; t.cr += u.cr || 0; t.cw += u.cw || 0; }
      if (r.res && r.res.ms != null) { t.msSum += r.res.ms; t.msCount++; }
      if (r.res && r.res.ttfb != null) { t.ttfbSum += r.res.ttfb; t.ttfbCount++; }

      const m = byModel.get(model) || { model, n: 0, cost: 0, credit: 0, in: 0, out: 0, cr: 0, fail: 0 };
      m.n++; m.cost += cost; m.credit += credit;
      if (u) { m.in += u.in || 0; m.out += u.out || 0; m.cr += u.cr || 0; }
      if (!(status >= 200 && status < 300)) m.fail++;
      byModel.set(model, m);

      const day = new Date(ts).toISOString().slice(0, 10);
      const d = byDay.get(day) || { day, n: 0, cost: 0, credit: 0, in: 0, out: 0, cr: 0 };
      d.n++; d.cost += cost; d.credit += credit;
      if (u) { d.in += u.in || 0; d.out += u.out || 0; d.cr += u.cr || 0; }
      byDay.set(day, d);

      recent.push({
        ts: r.ts, status, model,
        reqModel: (r.req && r.req.model) || null,
        path: (r.http && r.http.path) || null,
        ms: (r.res && r.res.ms) ?? null,
        usage: u, cost, credit,
        stream: r.req && r.req.stream,
      });
    }
  }

  recent.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const totalIn = t.in + t.cr;

  return {
    days,
    files: files.map((f) => path.basename(f)),
    totals: {
      ...t,
      cost: +t.cost.toFixed(6),
      credit: +t.credit.toFixed(6),
      cacheHit: totalIn > 0 ? Math.round((t.cr / totalIn) * 1000) / 10 : 0,
      avgMs: t.msCount ? Math.round(t.msSum / t.msCount) : null,
      avgTtfb: t.ttfbCount ? Math.round(t.ttfbSum / t.ttfbCount) : null,
      totalTokens: t.in + t.out + t.cr + t.cw,
    },
    byModel: [...byModel.values()].sort((a, b) => b.cost - a.cost),
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    recent: recent.slice(0, 200),
  };
}

// ---------------------------------------------------------------------------
// 官方额度（Command Code alpha API）
//   四个只读 GET，不消耗额度：
//     /alpha/whoami                  账号
//     /alpha/billing/credits         余额 + 5 小时 / 周 滚动窗口（含 resetAt）
//     /alpha/billing/subscriptions   套餐、订阅状态、计费周期
//     /alpha/usage/summary           计费周期内的费用 / 请求数 / token
//   注意：这几个接口**不接受时间区间参数**，只给固定口径，
//   所以要跟本地对比，得反过来用 resetAt 推出窗口起点，再把本地日志按同一区间切。
// ---------------------------------------------------------------------------

const OFFICIAL_BASE = "https://api.commandcode.ai";
const OFFICIAL_TTL = 45e3;      // 成功结果的缓存时长
const OFFICIAL_FAIL_TTL = 8e3;  // 失败只短暂记住 —— 否则一次网络抖动会把界面锁住 45 秒
let officialCache = { at: 0, data: null };

async function getOfficial(force) {
  if (!GUI_CFG.officialApi) {
    return { ok: false, disabled: true, error: "官方额度查询已在「设置」页关闭。", proxy: PROXY_URL || null };
  }
  if (!force && officialCache.data) {
    const ttl = officialCache.data.ok ? OFFICIAL_TTL : OFFICIAL_FAIL_TTL;
    if (Date.now() - officialCache.at < ttl) return officialCache.data;
  }
  const cfg = readConfig();
  const key = cfg.apiKey;
  if (!key) {
    return { ok: false, error: "config.json 里没有 apiKey，无法查询官方额度。" };
  }

  const ask = async (p) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(OFFICIAL_BASE + p, {
        headers: { Authorization: "Bearer " + key, Accept: "application/json" },
        signal: ctl.signal,
      });
      const text = await r.text();
      if (!r.ok) {
        const err = new Error(`HTTP ${r.status} ${text.slice(0, 120)}`);
        err.httpStatus = r.status;
        throw err;
      }
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  };

  // 网络层抖动重试一次（HTTP 4xx/5xx 不重试，那是真错误）
  const askWithRetry = async (p) => {
    try {
      return await ask(p);
    } catch (e) {
      if (e.httpStatus) throw e;
      await new Promise((r) => setTimeout(r, 700));
      return ask(p);
    }
  };

  try {
    const [who, cred, subs, summ] = await Promise.all([
      askWithRetry("/alpha/whoami"),
      askWithRetry("/alpha/billing/credits"),
      askWithRetry("/alpha/billing/subscriptions"),
      askWithRetry("/alpha/usage/summary"),
    ]);

    const c = cred.credits || {};
    const w = cred.windowLimits || {};
    const five = w.fiveHour || null;
    const week = w.weekly || null;
    const step = (x) => ({
      used: x.used, cap: x.cap, exceeded: x.exceeded,
      resetAt: x.resetAt,
      startAt: x.resetAt - (x === five ? 5 * 3600e3 : 7 * 86400e3),
    });

    const data = {
      ok: true,
      fetchedAt: new Date().toISOString(),
      base: OFFICIAL_BASE,
      proxy: PROXY_URL,
      account: (who && who.user) || null,
      org: (who && who.org) || null,
      plan: subs && subs.data
        ? {
            planId: subs.data.planId,
            status: subs.data.status,
            periodStart: Date.parse(subs.data.currentPeriodStart),
            periodEnd: Date.parse(subs.data.currentPeriodEnd),
            cancelAtPeriodEnd: subs.data.cancelAtPeriodEnd,
          }
        : null,
      credits: {
        monthlyRemaining: c.monthlyCredits ?? null,
        purchased: c.purchasedCredits ?? null,
        free: c.freeCredits ?? null,
        // 授予额是"推"出来的：剩余 + 本期已用（官方不直接给 grant）
        monthlyGranted:
          c.monthlyCredits != null && summ && summ.totalCost != null
            ? +(c.monthlyCredits + summ.totalCost).toFixed(6)
            : null,
      },
      windows: {
        limited: w.limited ?? null,
        fiveHour: five ? step(five) : null,
        weekly: week ? step(week) : null,
      },
      summary: summ
        ? {
            totalCount: summ.totalCount,
            completed: summ.completedCount,
            failed: summ.failedCount,
            successRate: summ.successRate,
            totalCost: summ.totalCost,
            tokensIn: summ.totalTokensIn,
            tokensOut: summ.totalTokensOut,
            tokensTotal: summ.totalTokens,
            periodBasis: summ.periodBasis,
          }
        : null,
    };

    officialCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    let msg;
    if (e.name === "AbortError") {
      msg = `请求官方接口超时（20s）。检查 v2rayN 是否在跑、代理端口是否为 ${PROXY_URL}`;
    } else if (e.httpStatus) {
      msg = e.message;
      if (e.httpStatus === 401 || e.httpStatus === 403) {
        msg += "　（Key 无效或套餐不支持 API，请确认 config.json 里是 user_ 开头的 GOAT Key）";
      }
    } else {
      const code = (e.cause && (e.cause.code || e.cause.message)) || e.code || "";
      msg = `网络请求失败：${e.message}${code ? " / " + code : ""}
        。若本机需要代理才能出网，请到「设置」页填出网代理（当前：${PROXY_URL || "未设置（直连）"}）。`;
    }
    const data = { ok: false, error: msg, base: OFFICIAL_BASE, proxy: PROXY_URL, fetchedAt: new Date().toISOString() };
    officialCache = { at: Date.now(), data };
    return data;
  }
}

/** 只读 JSONL，聚合 "起始时间之后" 的记录（给官方窗口对齐用） */
function aggregateSince(sinceMs) {
  const cfg = readConfig();
  const hot = resolveJsonlPath(cfg);
  const out = {
    since: sinceMs, n: 0, ok: 0, fail: 0,
    cost: 0, credit: 0, in: 0, out: 0, cr: 0, cw: 0,
    firstTs: null, lastTs: null,
  };
  if (!hot) return { ...out, noLog: true };

  const dir = path.dirname(hot);
  const files = [];
  if (fs.existsSync(hot)) files.push(hot);
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^requests-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) files.push(path.join(dir, f));
    }
  } catch { /* 忽略 */ }

  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.event !== "request") continue;
      const ts = Date.parse(r.ts);
      if (!Number.isFinite(ts) || ts < sinceMs) continue;

      const u = (r.res && r.res.usage) || null;
      const status = (r.http && r.http.status) || 0;
      out.n++;
      status >= 200 && status < 300 ? out.ok++ : out.fail++;
      out.cost += (r.res && r.res.cost) || 0;
      out.credit += (r.res && r.res.credit) || 0;
      if (u) {
        out.in += u.in || 0; out.out += u.out || 0;
        out.cr += u.cr || 0; out.cw += u.cw || 0;
      }
      if (out.firstTs == null || ts < out.firstTs) out.firstTs = ts;
      if (out.lastTs == null || ts > out.lastTs) out.lastTs = ts;
    }
  }
  out.cost = +out.cost.toFixed(6);
  out.credit = +out.credit.toFixed(6);
  return out;
}

/** 本地日志能覆盖到的最早时刻（用于判断"这个窗口本地到底统计得全不全"） */
function logEarliestTs() {
  const cfg = readConfig();
  const hot = resolveJsonlPath(cfg);
  if (!hot) return null;
  const dir = path.dirname(hot);
  const files = [];
  if (fs.existsSync(hot)) files.push(hot);
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^requests-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) files.push(path.join(dir, f));
    }
  } catch { /* 忽略 */ }

  let min = null;
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.event !== "request") continue;
      const ts = Date.parse(r.ts);
      if (Number.isFinite(ts) && (min == null || ts < min)) min = ts;
    }
  }
  return min;
}

/** 官方 vs 本地：按官方窗口起点切本地日志，做同口径对比 */
function buildComparison(official) {
  const rows = [];
  if (!official || !official.ok) return rows;

  const logStart = logEarliestTs();
  const now = Date.now();

  const add = (key, label, cap, officialUsed, startMs, note) => {
    const local = aggregateSince(startMs);
    // 覆盖率：本地日志真正能看到的时长 / 窗口总时长。
    // 关键：用"日志起点"而不是"窗口内第一条请求" —— 日志开着但当时没请求，也是被覆盖到了。
    const effectiveStart = logStart == null ? null : Math.max(startMs, logStart);
    const windowMs = now - startMs;
    const coveredMs = effectiveStart == null ? 0 : now - effectiveStart;
    const coverPct = windowMs > 0 ? Math.max(0, Math.min(100, Math.round((coveredMs / windowMs) * 100))) : null;
    // 只有覆盖够全，两个数字才具备可比性
    const comparable = coverPct != null && coverPct >= 99;

    rows.push({
      key, label, cap,
      official: officialUsed,
      local: local.credit,
      localCost: local.cost,
      localRequests: local.n,
      officialWindowStart: startMs,
      logStart,
      diff: officialUsed != null ? +(officialUsed - local.credit).toFixed(6) : null,
      diffPct:
        officialUsed && officialUsed > 0
          ? +(((officialUsed - local.credit) / officialUsed) * 100).toFixed(2)
          : null,
      coveredMs, windowMs, coverPct, comparable,
      localFirstTs: local.firstTs,
      note,
    });
  };

  const w = official.windows || {};
  if (w.fiveHour) {
    add("fiveHour", "5 小时窗口", w.fiveHour.cap, w.fiveHour.used, w.fiveHour.startAt,
        "滚动窗口，起点 = 重置时刻 − 5h");
  }
  if (w.weekly) {
    add("weekly", "本周窗口", w.weekly.cap, w.weekly.used, w.weekly.startAt,
        "滚动窗口，起点 = 重置时刻 − 7d");
  }
  if (official.plan && official.summary) {
    add("period", "计费周期", null, official.summary.totalCost, official.plan.periodStart,
        "订阅周期内累计");
  }
  return rows;
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------

function send(res, code, obj, type) {
  const ctype = type || "application/json; charset=utf-8";
  // 字符串体一律原样发送（HTML / CSS / 纯文本），对象才做 JSON 序列化。
  // 注意：不要用 `type === "html"` 这种判断 —— 调用方传的是完整 MIME，
  // 一个写死的短名匹配不上就会把 HTML 当 JSON 序列化，整页变成满屏 \n。
  const body = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    "Content-Type": ctype,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 2e6) reject(new Error("请求体过大"));
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
  });
}

async function handleApi(req, res, url) {
  const p = url.pathname;

  // gui.config.json 是本控制台自己的，先处理掉不依赖 config.json 的路由
  if (p === "/api/gui-config" && req.method === "GET") {
    return send(res, 200, {
      config: readGuiConfig(),
      defaults: GUI_DEFAULTS,
      path: GUI_CONFIG_PATH,
      effective: { port: GUI_PORT, proxy: PROXY_URL || null },
    });
  }

  let cfg;
  try {
    cfg = readConfig();
  } catch (e) {
    return send(res, 500, {
      error: "读不到 config.json。本控制台需要和 cmc-proxy 放在同一个目录"
        + "（要先读它的 config.json 才知道代理端口和 apiKey）。",
    });
  }
  const proxyPort = cfg.port || 5411;

  if (p === "/api/status" && req.method === "GET") {
    const running = await portInUse(proxyPort);
    const jsonlPath = resolveJsonlPath(cfg);
    const probe = pidOnPort(proxyPort);
    return send(res, 200, {
      proxyPort,
      proxyRunning: running,
      proxyPid: running ? (probe || (child ? child.pid : null)) : null,
      // netstat 探测失败时 pid 会是 null，前端应说明"未知"而不是显示 "?"
      pidProbeFailed: probe === undefined,
      managedByGui: !!child,
      managedPid: child ? child.pid : null,
      guiPort: GUI_PORT,
      root: ROOT,
      configPath: CONFIG_PATH,
      jsonlEnabled: !!jsonlPath,
      jsonlPath: jsonlPath || null,
      jsonlExists: !!(jsonlPath && fs.existsSync(jsonlPath)),
      pricesLoaded: fs.existsSync(PRICES_PATH),
      guiConfigPath: GUI_CONFIG_PATH,
      proxyUrl: PROXY_URL || null,
      officialEnabled: !!GUI_CFG.officialApi,
      proxyJsPresent: fs.existsSync(path.join(ROOT, "proxy.js")),
    });
  }

  if (p === "/api/config" && req.method === "GET") {
    // ⚠️ 绝不能把明文 apiKey 交给前端
    return send(res, 200, configForClient(cfg));
  }

  if (p === "/api/config" && req.method === "PUT") {
    const body = await readBody(req);
    if (!body || typeof body !== "object") return send(res, 400, { error: "非法配置" });
    // 前端传回来的 apiKey 是掩码（或空）时，保留磁盘上的真实值
    const next = mergeConfigFromClient(body, cfg);
    if (!next.apiKey) {
      return send(res, 400, { error: "apiKey 不能为空。请在「设置」页填入你的 Command Code Key（user_ 开头）。" });
    }
    try {
      writeConfigAtomic(next);
    } catch (e) {
      return send(res, 500, { error: "写入失败: " + e.message });
    }
    return send(res, 200, {
      ok: true,
      message: "已保存。配置在 cmc-proxy 启动时读取 —— 需要重启代理才会生效。",
    });
  }

  // ---------- 控制台自己的设置（gui.config.json）----------
  // GET 已在 handleApi 顶部处理（它不依赖 config.json）
  if (p === "/api/gui-config" && req.method === "PUT") {
    const body = await readBody(req);
    if (!body || typeof body !== "object") return send(res, 400, { error: "非法配置" });
    let saved;
    try {
      saved = writeGuiConfig(body);
    } catch (e) {
      return send(res, 500, { error: "写入失败: " + e.message });
    }
    const restartNeeded = [];
    if (parseInt(saved.port, 10) !== GUI_PORT) restartNeeded.push("控制台端口");
    if ((saved.proxy || "") !== (PROXY_URL || "")) restartNeeded.push("出网代理");
    return send(res, 200, {
      ok: true,
      config: saved,
      restartNeeded,
      message: restartNeeded.length
        ? `已保存。${restartNeeded.join("、")}需要重启控制台才生效。`
        : "已保存。",
    });
  }

  // ---------- 连接测试 ----------
  if (p === "/api/test/upstream" && req.method === "POST") {
    const base = String(cfg.upstream || "").replace(/\/+$/, "");
    if (!base) return send(res, 200, { ok: false, message: "config.json 里没填 upstream。" });
    const key = cfg.apiKey;
    if (!key) return send(res, 200, { ok: false, message: "还没填 apiKey。" });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(`${base}/v1/models`, {
        headers: { Authorization: "Bearer " + key, Accept: "application/json" },
        signal: ctl.signal,
      });
      const text = await r.text();
      if (!r.ok) {
        return send(res, 200, { ok: false, message: `上游返回 HTTP ${r.status}：${text.slice(0, 160)}` });
      }
      let n = null;
      try { n = (JSON.parse(text).data || []).length; } catch { /* 忽略 */ }
      return send(res, 200, {
        ok: true,
        message: n != null ? `Key 有效 · 上游返回 ${n} 个模型` : "Key 有效（响应不是标准模型列表）",
        models: n,
      });
    } catch (e) {
      const code = (e.cause && (e.cause.code || e.cause.message)) || "";
      return send(res, 200, {
        ok: false,
        message: e.name === "AbortError"
          ? "超时（20s）。检查网络，或到「设置」页配一个出网代理。"
          : `连不上：${e.message}${code ? " / " + code : ""}`,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  if (p === "/api/test/official" && req.method === "POST") {
    const o = await getOfficial(true);
    if (!o.ok) return send(res, 200, { ok: false, message: o.error });
    const a = o.account || {};
    return send(res, 200, {
      ok: true,
      message: `官方接口通 · 账号 ${a.userName || "?"}`,
      account: a.userName || null,
      plan: o.plan ? o.plan.planId : null,
      proxy: o.proxy || "直连",
    });
  }

  if (p === "/api/models" && req.method === "GET") {
    const prices = loadPrices();
    const out = { prices: null, upstream: null, upstreamError: null };
    if (prices) {
      out.prices = prices.models.map((m) => ({
        id: m.id, name: m.name, vendor: m.vendor,
        contextTokens: m.contextTokens,
        vision: !!m.vision, reasoning: !!m.reasoning,
        input: m.priceUsdPerMTok && m.priceUsdPerMTok.input,
        output: m.priceUsdPerMTok && m.priceUsdPerMTok.output,
        cacheRead: m.priceUsdPerMTok && m.priceUsdPerMTok.cacheRead,
        monthlyCredits: m.monthlyCredits ?? null,
      }));
    }
    try {
      const up = await httpGetJson(`http://127.0.0.1:${proxyPort}/v1/models`, 6000);
      out.upstream = (up.data || []).map((m) => m.id);
    } catch (e) {
      out.upstreamError = "读不到 /v1/models（代理未运行？）：" + e.message;
    }
    return send(res, 200, out);
  }

  if (p === "/api/usage" && req.method === "GET") {
    const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get("days") || "7", 10)));
    if (!resolveJsonlPath(cfg)) {
      return send(res, 200, {
        disabled: true,
        message: "config.json 里 jsonlLog 是关闭的，没有结构化日志可读。把它改成 true 并重启 cmc-proxy 即可开始记录。",
      });
    }
    return send(res, 200, aggregateUsage(days));
  }

  if (p === "/api/official" && req.method === "GET") {
    const force = url.searchParams.get("force") === "1";
    const official = await getOfficial(force);
    const localCfg = resolveJsonlPath(cfg);
    return send(res, 200, {
      official,
      comparison: buildComparison(official),
      jsonlEnabled: !!localCfg,
      jsonlPath: localCfg || null,
      localCacheHit: officialCache.at,
    });
  }

  if (p === "/api/proxy/start" && req.method === "POST") {
    return send(res, 200, await startProxy());
  }

  if (p === "/api/proxy/stop" && req.method === "POST") {
    const b = await readBody(req).catch(() => ({}));
    if (b && b.force) return send(res, 200, await forceStopProxy(proxyPort));
    return send(res, 200, stopProxy());
  }

  if (p === "/api/logs" && req.method === "GET") {
    return send(res, 200, {
      managed: !!child,
      lines: childLog.slice(-250),
      note: child ? null : "本控制台没有自己启动的实例，看不到它的实时输出。外部实例的数据请看「概览」里的请求记录（来自 JSONL 日志）。",
    });
  }

  if (p === "/api/cost" && req.method === "POST") {
    const b = await readBody(req);
    const prices = loadPrices();
    if (!prices) return send(res, 200, { error: "goat-prices.json 不存在，先跑 node goat-prices.js" });
    const m = prices.models.find((x) => x.id === b.model || x.name === b.model || x.slug === b.model);
    if (!m) return send(res, 200, { error: "未收录模型: " + b.model });
    const pr = m.priceUsdPerMTok || {};
    const M = 1e6;
    const parts = [
      ["input", b.input || 0, pr.input],
      ["output", b.output || 0, pr.output],
      ["cacheRead", b.cacheRead || 0, pr.cacheRead],
      ["cacheWrite", b.cacheWrite || 0, pr.cacheWrite],
    ];
    let total = 0;
    const breakdown = parts.map(([k, tok, rate]) => {
      const usd = rate == null ? 0 : (tok * rate) / M;
      total += usd;
      return { key: k, tokens: tok, rateUsdPerMTok: rate ?? null, usd: +usd.toFixed(6) };
    });
    return send(res, 200, {
      model: m.name, id: m.id,
      totalUsd: +total.toFixed(6),
      credit: +total.toFixed(6),
      breakdown,
      monthlyCredits: m.monthlyCredits ?? null,
    });
  }

  return send(res, 404, { error: "未知接口: " + p });
}

function httpGetJson(url, timeout) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error("响应不是 JSON")); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("超时")); });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// CLI: node gui.js --stop-all
//   停掉监听「代理端口 / 控制台端口」的进程然后退出。端口从配置读，
//   所以改了端口也不会失效 —— stop-all.bat 只是个双击壳。
// ---------------------------------------------------------------------------
if (STOP_ALL) {
  const cfg = (() => { try { return readConfig(); } catch { return {}; } })();
  const targets = [["代理", cfg.port || 5411], ["控制台", GUI_PORT]];
  let stopped = 0, probeFailed = 0;
  for (const [name, port] of targets) {
    const pid = pidOnPort(port);
    if (pid === undefined) {
      console.log(`  ${name} 端口 ${port} —— ${PROBE_FAIL_MSG}`);
      probeFailed++;
      continue;
    }
    if (pid === null) {
      console.log(`  ${name} 端口 ${port} —— 空闲，无需处理`);
      continue;
    }
    spawnSync("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true });
    const still = pidOnPort(port);
    const gone = still === null;
    console.log(`  ${name} 端口 ${port} (PID ${pid}) —— ${gone ? "已停止" : "停止失败（可能需要管理员权限）"}`);
    if (gone) stopped++;
  }
  if (probeFailed) {
    console.log(`\n  有 ${probeFailed} 个端口没能探测成功 —— 结果不可信，请用任务管理器确认。`);
  } else {
    console.log(stopped ? `\n  完成，共停止 ${stopped} 个进程。` : "\n  没有需要停止的进程。");
  }
  process.exit(0);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${GUI_HOST}:${GUI_PORT}`);
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = fs.readFileSync(path.join(ROOT, "gui.html"), "utf8");
      return send(res, 200, html, "text/html; charset=utf-8");
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

server.listen(GUI_PORT, GUI_HOST, async () => {
  const cfg = (() => { try { return readConfig(); } catch { return {}; } })();
  const jsonl = resolveJsonlPath(cfg);
  const proxyPort = cfg.port || 5411;
  const url = `http://${GUI_HOST}:${GUI_PORT}`;
  console.log("");
  console.log("  ══════════════════════════════════════════");
  console.log("   cmc 控制台 已启动");
  console.log("  ══════════════════════════════════════════");
  console.log(`   控制台   ${url}`);
  console.log(`   代理     http://127.0.0.1:${proxyPort}`);
  console.log(`   配置文件 ${CONFIG_PATH}`);
  console.log(`   用量日志 ${jsonl || "(jsonlLog 未开启 — 概览页没有数据源)"}`);
  console.log(`   模型牌价 ${fs.existsSync(PRICES_PATH) ? "已加载" : "缺失 (跑 node goat-prices.js)"}`);
  console.log("  ──────────────────────────────────────────");
  if (!fs.existsSync(path.join(ROOT, "proxy.js"))) {
    console.log("   ⚠ 本目录里没有 proxy.js —— 控制台只是界面。");
    console.log("     请把 cmc-proxy 的 proxy.js / config.json 放到本目录。");
  }
  console.log("   关闭本窗口 = 停止控制台（及其启动的代理）");
  console.log("   若想只关代理、留着界面：用界面里的「停止」");
  console.log("");

  // 一步到位：控制台起来时顺手把代理也拉起来（只在自己没跑的时候）
  if (AUTO_START) {
    if (await portInUse(proxyPort)) {
      console.log(`   [auto-start] 代理已在 ${proxyPort} 上运行（外部实例，本控制台只读不管）`);
    } else {
      const r = await startProxy();
      console.log(`   [auto-start] ${r.message}`);
    }
    console.log("");
  }

  if (OPEN_BROWSER && !NO_OPEN) {
    const ok = openBrowser(url);
    console.log(`   [open] ${ok ? "已请求打开默认浏览器" : "无法自动打开，请手动访问上面地址"}`);
    console.log("");
  }
});

// ---------------------------------------------------------------------------
// 打开默认浏览器
// ---------------------------------------------------------------------------

function openBrowser(url) {
  const tries = process.platform === "win32"
    ? [["cmd", ["/c", "start", "", url]], ["rundll32", ["url.dll,FileProtocolHandler", url]]]
    : process.platform === "darwin"
      ? [["open", [url]]]
      : [["xdg-open", [url]]];
  for (const [cmd, a] of tries) {
    try {
      const p = spawn(cmd, a, { detached: true, stdio: "ignore", windowsHide: true });
      p.on("error", () => {});
      p.unref();
      return true;
    } catch { /* 试下一种 */ }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 退出清理：控制台正常退出时，把"它自己启动的"代理一起带走
// （外部启动的实例不受影响；窗口被强杀的极端情况用「强制停止」或 stop-all.bat）
// ---------------------------------------------------------------------------

let exiting = false;
function gracefulExit() {
  if (exiting) return;
  exiting = true;
  try {
    if (child) {
      console.log(`\n  [gui] 关闭中 —— 一并停止本控制台启动的代理 (PID ${child.pid})`);
      child.kill();
    }
  } catch { /* 忽略 */ }
  process.exit(0);
}
process.on("SIGINT", gracefulExit);
process.on("SIGTERM", gracefulExit);
process.on("SIGHUP", gracefulExit);

