  // ============================================================
  //  存储：启用开关、TTL、页面级缓存、全局 uid 缓存
  //  页面缓存结构: cache[pageId] = { d: { [uid]: { ip, name, failedAt? } }, t }
  //  全局缓存结构: uids[uid] = { ip, name, t }（正面）或 { ip: null, failedAt }（负面）
  //  ip 为 null 且带 failedAt 的是"负缓存"（该用户查不到属地，短 TTL 内不再重试）
  // ============================================================
  let enabled = true;
  let days = 0;
  let cache = {};
  let uids = {};
  let pageId = null;
  let pageData = {};

  function readStorage(key, fallback) {
    try {
      return GM_getValue(key, fallback);
    } catch (e) {
      addLog('warn', `读取存储失败: ${key}`, e.message);
      return fallback;
    }
  }

  function writeStorage(key, value) {
    try {
      GM_setValue(key, value);
      return true;
    } catch (e) {
      addLog('warn', `写入存储失败: ${key}`, e.message);
      return false;
    }
  }

  function isFailureCacheFresh(entry) {
    return entry?.failedAt && Date.now() - entry.failedAt < CONFIG.CACHE.failedTtlMs;
  }

  function pruneExpiredPages() {
    if (days <= 0) return;
    const ttl = days * 864e5;
    const now = Date.now();
    for (const [key, entry] of Object.entries(cache)) {
      if (entry.t && now - entry.t > ttl) delete cache[key];
    }
  }

  function pruneOversizedPages() {
    const keys = Object.keys(cache);
    if (keys.length <= CONFIG.CACHE.maxPages) return;
    keys.sort((a, b) => (cache[a].t || 0) - (cache[b].t || 0));
    const excess = keys.length - CONFIG.CACHE.maxPages;
    for (const key of keys.slice(0, excess)) delete cache[key];
    addLog('warn', `缓存超上限，清理最旧的 ${excess} 个页面`);
  }

  function save() {
    pruneOversizedPages();
    writeStorage(CONFIG.CACHE.key, cache);
  }

  function saveUids() {
    const now = Date.now();
    const uidTtlMs = CONFIG.CACHE.uidTtlDays * 864e5;
    for (const [uid, entry] of Object.entries(uids)) {
      const positiveExpired = entry.ip && entry.t && now - entry.t > uidTtlMs;
      const negativeExpired = !entry.ip && entry.failedAt && now - entry.failedAt > CONFIG.CACHE.failedTtlMs;
      if (positiveExpired || negativeExpired) delete uids[uid];
    }
    const keys = Object.keys(uids);
    if (keys.length > CONFIG.CACHE.maxUids) {
      keys.sort((a, b) => (uids[a].t || uids[a].failedAt || 0) - (uids[b].t || uids[b].failedAt || 0));
      const excess = keys.length - CONFIG.CACHE.maxUids;
      for (const key of keys.slice(0, excess)) delete uids[key];
      addLog('warn', `uid 缓存超上限，清理最旧的 ${excess} 条`);
    }
    writeStorage(CONFIG.CACHE.uidKey, uids);
  }

  // 全局缓存新鲜度判断：正面按 uidTtlDays 过期（用户可能换 IP 属地），
  // 负面按 failedTtlMs 过期；旧版页面缓存里没有时间戳的正面数据视为新鲜
  function getFreshUidInfo(uid) {
    const entry = uids[uid] || pageData[uid];
    if (!entry) return null;
    if (entry.ip) {
      if (!entry.t || Date.now() - entry.t < CONFIG.CACHE.uidTtlDays * 864e5) return entry;
      return null;
    }
    return isFailureCacheFresh(entry) ? entry : null;
  }

  // 旧版只有页面缓存：把其中的正面数据迁移进全局缓存，时间戳沿用页面的
  function migratePageCache() {
    if (!pageId) return;
    const pageT = cache[pageId]?.t || Date.now();
    let changed = false;
    for (const [uid, info] of Object.entries(pageData)) {
      if (info?.ip && !uids[uid]) {
        uids[uid] = { ip: info.ip, name: info.name || '', t: pageT };
        changed = true;
      }
    }
    if (changed) saveUids();
  }

  function loadPage() {
    const match = location.href.match(CONFIG.PAGE_ID_PATTERN);
    pageId = match ? match[1] : null;
    pageData = {};
    if (!pageId || !enabled) return;
    const entry = cache[pageId];
    const expired = entry && days > 0 && Date.now() - entry.t >= days * 864e5;
    if (expired) delete cache[pageId];
    pageData = (cache[pageId] || {}).d || {};
    migratePageCache();
  }

  function savePage() {
    if (!enabled || !pageId) return;
    cache[pageId] = { d: pageData, t: Date.now() };
    save();
  }

  function clearAllCache() {
    cache = {};
    uids = {};
    pageData = {};
    save();
    saveUids();
  }
