  // ============================================================
  //  IP 查询（全局 uid 缓存 + 串行限流队列 + 负缓存）
  // ============================================================
  const pendingIpQueries = new Map();

  // 串行队列：相邻请求强制间隔，避免滚动一屏并发几十个请求触发风控
  let requestQueueTail = Promise.resolve();

  function scheduleRequest(job) {
    const result = requestQueueTail.then(job);
    requestQueueTail = result
      .catch(() => {})
      .then(() => new Promise(resolve => setTimeout(resolve, CONFIG.REQUEST.minIntervalMs)));
    return result;
  }

  // 防抖存储写入：连续查询时合并为一次序列化，避免 200ms 间隔下反复全量 JSON.stringify
  let saveTimer = null;
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; savePage(); saveUids(); }, 2000);
  }

  async function getIp(uid) {
    if (!enabled) return null;
    const fresh = getFreshUidInfo(uid);
    if (fresh) return fresh.ip;
    if (pendingIpQueries.has(uid)) return pendingIpQueries.get(uid);

    const promise = scheduleRequest(() => queryIpRemote(uid));
    pendingIpQueries.set(uid, promise);
    const ip = await promise;
    pendingIpQueries.delete(uid);
    return ip;
  }

  // ipLocation 字段需要请求方登录态，游客一律返回空字符串。
  // 用页面上下文 fetch（同源自动携带全部 cookie，含 HttpOnly），不依赖脚本管理器的 cookie 行为
  function applyUserInfo(uid, data) {
    if (!enabled) return data.profile?.ipLocation || null;
    const ip = data.profile?.ipLocation || null;
    addLog('debug', `📡 API响应: userId=${uid}, ipLocation="${data.profile?.ipLocation || ''}", result=${data.result}`);
    const now = Date.now();
    if (ip) {
      uids[uid] = { ip, name: data.profile?.name || '', t: now };
      if (pageId) pageData[uid] = { ip: uids[uid].ip, name: uids[uid].name };
    } else {
      // 查不到属地的用户也记录，避免每次滚动重复请求
      uids[uid] = { ip: null, failedAt: now };
      if (pageId) pageData[uid] = { ip: null, failedAt: now };
    }
    scheduleSave();
    return ip;
  }

  async function queryIpRemote(uid) {
    try {
      return applyUserInfo(uid, await fetchUserInfoViaPage(uid));
    } catch (e) {
      addLog('error', `📡 请求失败: userId=${uid}`, e.message);
      const now = Date.now();
      uids[uid] = { ip: null, failedAt: now, transient: true };
      if (pageId) pageData[uid] = { ip: null, failedAt: now, transient: true };
      scheduleSave();
      return null;
    }
  }

  async function fetchUserInfoViaPage(uid) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST.timeoutMs);
    try {
      const response = await fetch(CONFIG.API.userInfo(uid), {
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
