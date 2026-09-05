// ==UserScript==
// @name         AcFunReveal - A站网页版显示 IP 属地
// @namespace    http://acfun-reveal.local
// @version      5.6.1
// @description  可视区域优先：只查询可见评论的 IP，滚动时自动加载
// @author       name_xxl
// @match        https://www.acfun.cn/*
// @match        https://m.acfun.cn/*
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// @noframes
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';
  // ============================================================
  //  常量与配置：API 端点、DOM 选择器、各类阈值统一收拢于此
  //  A 站改版时只需调整本区块
  // ============================================================
  const VERSION = '5.6.1';

  const CONFIG = {
    API: {
      userInfo: (uid) => `https://www.acfun.cn/rest/pc-direct/user/userInfo?userId=${uid}`,
    },
    COMMENT_URL_PATTERNS: ['/comment/list', '/comment/sublist', '/comment/subComment', '/comment/reply'],
    // 通用选择器（两种模式共用）
    PROFILE_LINK: 'a[href*="/u/"]',
    // 默认模式选择器
    SELECTORS: {
      commentRoot: '[data-commentid]',
      commentFrom: '.area-comment-from',
      commentSkipSelf: '.area-sec-seemore',
      commentSkipParent: '.area-sec-more',
      userAttrLink: 'a[data-userid]',
      avatar: 'img.avatar',
      avatarUidPattern: /newUpload\/(\d+)_/,
      feedTime: '.feed-time',
      feedUpInfo: '.feed-up-info',
      feedUp: '.feed-up',
      upLink: 'a[href*="/u/"], a[href*="/live/"]',
      profileInfo: '#ac-space-info[data-uid]',
      profileTop: '.top',
    },
    // 盖楼模式选择器
    SELECTORS_FLOOR: {
      commentRoot: '.main-comment-item, .fc-comment-item',
      commentFrom: '.comment-item-footer-left',
      userAttrLink: 'a.name[data-uid]',
      avatar: 'img.fc-avatar',
      avatarUidPattern: /\/u\/(\d+)/,
    },
    OBSERVER: {
      rootMargin: '200px',   // 提前 200px 开始加载
      domDebounceMs: 300,    // MutationObserver 防抖
      urlChangeDelayMs: 500, // 路由切换后等 DOM 稳定
    },
    REQUEST: {
      minIntervalMs: 200,    // 相邻请求最小间隔（串行队列），防触发风控
      timeoutMs: 10000,
    },
    CACHE: {
      key: 'acr_cache',
      uidKey: 'acr_uids',
      enabledKey: 'acr_enabled',
      daysKey: 'acr_days',
      maxPages: 500,   // 页面级缓存上限，防止无限膨胀
      maxUids: 5000,   // 全局 uid 缓存上限
      uidTtlDays: 1,   // 全局属地缓存保鲜期：过期重查，兼顾 IP 变动的及时性与请求量
      failedTtlMs: 6 * 60 * 60 * 1000,  // 查询失败（无属地）的负缓存时长
      logLimit: 500,
    },
    PAGE_ID_PATTERN: /\/[av]\/(ac?\d+)/i,
  };
  // ============================================================
  //  日志
  // ============================================================
  const logs = [];
  const DEBUG = false; // 调试模式：设为 true 可输出详细日志

  const log = (...args) => console.log('%c[AcFunReveal]', 'color:#4caf50;font-weight:bold', ...args);

  const LOG_ICONS = { debug: '🔍', info: 'ℹ️', success: '✅', error: '❌', warn: '⚠️' };

  function addLog(level, ...args) {
    const message = args.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
    logs.push(`[${new Date().toLocaleTimeString()}] [${level}] ${message}`);
    if (logs.length > CONFIG.CACHE.logLimit) logs.shift();
    // debug 级别只在调试模式下输出
    if (level === 'debug' && !DEBUG) return;
    log(LOG_ICONS[level] || LOG_ICONS.info, ...args);
  }
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

  async function getIp(uid) {
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
    if (pageId) savePage();
    saveUids();
    return ip;
  }

  async function queryIpRemote(uid) {
    try {
      return applyUserInfo(uid, await fetchUserInfoViaPage(uid));
    } catch (e) {
      addLog('error', `📡 请求失败: userId=${uid}`, e.message);
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
  // ============================================================
  //  DOM 工具：UID 提取、IP 标签构造与注入
  // ============================================================
  function parseUidFromHref(href) {
    if (!href) return null;
    const match = href.match(/\/u\/(\d+)/) || href.match(/\/live\/(\d+)/);
    return match ? parseInt(match[1]) : null;
  }

  function extractUidFromComment(el) {
    // 尝试从用户属性链接提取（默认模式）
    const attrLink = el.querySelector(CONFIG.SELECTORS.userAttrLink);
    if (attrLink?.dataset.userid) return parseInt(attrLink.dataset.userid);

    // 尝试从用户属性链接提取（盖楼模式）
    const floorAttrLink = el.querySelector(CONFIG.SELECTORS_FLOOR.userAttrLink);
    if (floorAttrLink?.dataset.uid) return parseInt(floorAttrLink.dataset.uid);

    // 从个人主页链接提取
    const profileLink = el.querySelector(CONFIG.PROFILE_LINK);
    const uid = parseUidFromHref(profileLink?.href);
    if (uid) return uid;

    // 从头像提取
    return extractUidFromAvatar(el);
  }

  function extractUidFromAvatar(el) {
    // 尝试默认模式头像
    const avatar = el.querySelector(CONFIG.SELECTORS.avatar);
    const match = avatar?.src.match(CONFIG.SELECTORS.avatarUidPattern);
    if (match) return parseInt(match[1]);

    // 尝试盖楼模式头像
    const floorAvatar = el.querySelector(CONFIG.SELECTORS_FLOOR.avatar);
    const floorMatch = floorAvatar?.src.match(CONFIG.SELECTORS_FLOOR.avatarUidPattern);
    return floorMatch ? parseInt(floorMatch[1]) : null;
  }

  function makeIpSpan(ip, { text, style, queriedAt, uid } = {}) {
    const span = document.createElement('span');
    span.className = 'acr-ip';
    span.textContent = text ?? ` ${ip}`;
    span.style.cssText = 'margin-left:3px;cursor:pointer;transition:color .2s;';
    span.title = `IP属地：${ip}\n（基于用户主页实时资料，不代表发布时的IP）`;
    if (queriedAt) span.title += `\n查询于：${new Date(queriedAt).toLocaleString()}`;
    if (uid) span.dataset.acrUid = String(uid);
    return span;
  }

  function injectIntoComment(el, ip, { queriedAt, uid } = {}) {
    if (!ip || el.querySelector('.acr-ip')) return;
    
    // 尝试默认模式的注入点
    let anchor = el.querySelector(CONFIG.SELECTORS.commentFrom);
    let mode = '默认';
    
    // 如果默认模式找不到，尝试盖楼模式
    if (!anchor) {
      anchor = el.querySelector(CONFIG.SELECTORS_FLOOR.commentFrom);
      mode = '盖楼';
    }
    
    if (!anchor) {
      const commentId = el.getAttribute('data-commentid') || el.getAttribute('data-cid');
      addLog('warn', `⚠️ 注入点缺失: commentId=${commentId}`);
      return;
    }
    anchor.appendChild(makeIpSpan(ip, { queriedAt, uid }));
    addLog('debug', `🎉 ${ip} (${mode}模式)`);
  }

  // 节点被 A 站原地重渲染后不会再次进入 IntersectionObserver，从缓存直接补注入
  function injectFromCache(el) {
    // 支持两种模式：默认模式 data-commentid，盖楼模式 data-cid
    const commentId = el.getAttribute('data-commentid') || el.getAttribute('data-cid');
    if (!commentId) return;
    
    const uid = commentUserMap.get(commentId) || extractUidFromComment(el);
    if (!uid) return;
    const fresh = getFreshUidInfo(uid);
    if (fresh?.ip) injectIntoComment(el, fresh.ip, { queriedAt: fresh.t, uid });
  }
  // ============================================================
  //  拦截评论 API（只建立 commentId → userId 映射，不立即查询）
  // ============================================================
  const isCommentUrl = (url) => CONFIG.COMMENT_URL_PATTERNS.some(pattern => url.includes(pattern));
  const commentUserMap = new Map();
  let fieldLayoutLogged = false;

  function hookFetch() {
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
      const response = originalFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        if (isCommentUrl(url)) {
          response.clone().json()
            .then(data => onComments(extractCommentList(data)))
            .catch(() => {});
        }
      } catch (e) {
        addLog('warn', 'fetch 拦截异常', e.message);
      }
      return response;
    };
  }

  function hookXHR() {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._acrUrl = url;
      return originalOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', function () {
        try {
          if (isCommentUrl(this._acrUrl || '')) {
            onComments(extractCommentList(JSON.parse(this.responseText)));
          }
        } catch (e) {
          addLog('warn', 'XHR 拦截异常', e.message);
        }
      });
      return originalSend.apply(this, args);
    };
  }

  function extractCommentList(data) {
    return (data?.rootComments || []).concat(data?.subComments || data?.comments || []);
  }

  function onComments(list) {
    if (!list.length) {
      addLog('warn', '📋 评论列表为空');
      return;
    }
    for (const comment of list) {
      if (comment.commentId && comment.userId) {
        commentUserMap.set(String(comment.commentId), comment.userId);
      }
    }
    addLog('debug', `📋 ${list.length} 条评论，映射: ${commentUserMap.size}`);
    if (!fieldLayoutLogged) {
      fieldLayoutLogged = true;
      addLog('debug', `📋 首条评论字段: ${Object.keys(list[0]).join(', ')}`);
    }
    observeComments();
  }
  // ============================================================
  //  IntersectionObserver：可视区域优先
  // ============================================================
  const visibilityObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      visibilityObserver.unobserve(entry.target);
      processVisibleComment(entry.target);
    }
  }, { rootMargin: CONFIG.OBSERVER.rootMargin });

  function observeComments() {
    // 同时查询两种模式的评论元素
    const defaultElements = document.querySelectorAll(CONFIG.SELECTORS.commentRoot);
    const floorElements = document.querySelectorAll(CONFIG.SELECTORS_FLOOR.commentRoot);
    
    // 合并去重（使用 Set）
    const allElements = new Set([...defaultElements, ...floorElements]);
    
    let newlyObserved = 0;
    for (const el of allElements) {
      if (isSkippableComment(el)) continue;
      if (el.querySelector('.acr-ip')) continue;
      if (el._acrObserved) {
        injectFromCache(el);
        continue;
      }
      el._acrObserved = true;
      visibilityObserver.observe(el);
      newlyObserved++;
    }
    if (newlyObserved) addLog('debug', `👁️ 新增观察: ${newlyObserved} 个`);
  }

  function isSkippableComment(el) {
    // 默认模式的跳过逻辑
    const skipSelfClass = CONFIG.SELECTORS.commentSkipSelf.slice(1); // 去掉开头的 '.'
    const skipParentSelector = CONFIG.SELECTORS.commentSkipParent;
    
    // 检查是否是"查看更多"类型的评论（默认模式特有）
    if (el.classList.contains(skipSelfClass)) return true;
    if (el.closest(skipParentSelector)) return true;
    
    // 盖楼模式没有这些跳过条件，直接返回 false
    return false;
  }

  async function processVisibleComment(el) {
    if (el.querySelector('.acr-ip') || isSkippableComment(el)) return;

    // 支持两种模式：默认模式 data-commentid，盖楼模式 data-cid
    const commentId = el.getAttribute('data-commentid') || el.getAttribute('data-cid');
    const uid = commentUserMap.get(commentId) || extractUidFromComment(el);
    if (!uid) {
      addLog('warn', `⚠️ 无法提取 userId (commentId: ${commentId})`);
      return;
    }

    const fresh = getFreshUidInfo(uid);
    if (fresh) {
      if (fresh.ip) {
        addLog('debug', `📦 从缓存注入: ${uid} → ${fresh.ip}`);
        injectIntoComment(el, fresh.ip, { queriedAt: fresh.t, uid });
      }
      return;
    }

    addLog('debug', `🔍 处理评论: commentId=${commentId}, userId=${uid}`);
    const ip = await getIp(uid);
    if (ip) {
      addLog('debug', `🎉 查询注入: ${uid} → ${ip}`);
      injectIntoComment(el, ip, { queriedAt: uids[uid]?.t, uid });
    } else {
      addLog('warn', `❌ 查询失败: ${uid} (ipLocation 为空)`);
    }
  }

  // ============================================================
  //  场景一：个人空间动态页 UP 的 IP
  // ============================================================
  const processedFeedItems = new WeakSet();

  function injectUpIp() {
    for (const timeEl of document.querySelectorAll(CONFIG.SELECTORS.feedTime)) {
      if (timeEl.parentNode.querySelector('.acr-up-ip')) continue;
      if (processedFeedItems.has(timeEl)) continue;

      const wrap = timeEl.closest(CONFIG.SELECTORS.feedUpInfo)?.closest(CONFIG.SELECTORS.feedUp);
      const uid = parseUidFromHref(wrap?.querySelector(CONFIG.SELECTORS.upLink)?.href);
      // uid 尚未渲染出来时不标记，留待下次 DOM 变化重试
      if (!uid) continue;
      processedFeedItems.add(timeEl);

      getIp(uid).then(ip => {
        if (!ip || timeEl.parentNode.querySelector('.acr-up-ip')) return;
        timeEl.appendChild(makeIpSpan(ip, { queriedAt: uids[uid]?.t, uid }));
        addLog('success', `[UP] ${uid} → ${ip}`);
      });
    }
  }

  // ============================================================
  //  场景二：用户主页 IP
  // ============================================================
  function injectProfileIp() {
    const info = document.querySelector(CONFIG.SELECTORS.profileInfo);
    if (!info || info.querySelector('.acr-ip')) return;
    const uid = info.getAttribute('data-uid');
    if (!uid) return;

    getIp(uid).then(ip => {
      if (!ip || info.querySelector('.acr-ip')) return;
      const top = info.querySelector(CONFIG.SELECTORS.profileTop);
      if (!top) return;
      top.appendChild(makeIpSpan(ip, {
        text: `IP属地：${ip}`,
        style: 'font-size:12px;color:#999;',
        queriedAt: uids[uid]?.t,
        uid,
      }));
      addLog('success', `[主页] ${uid} → ${ip}`);
    });
  }

  // ============================================================
  //  Observer（DOM 变化）与 URL 变化
  // ============================================================
  let domObserver = null;

  function startObserver() {
    if (domObserver) return;
    let debounceTimer = null;
    domObserver = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(onDomChange, CONFIG.OBSERVER.domDebounceMs);
    });
    domObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function onDomChange() {
    observeComments();
    if (location.pathname.includes('/member')) injectUpIp();
    if (/\/u\/\d+/.test(location.pathname)) injectProfileIp();
  }

  let lastUrl = '';

  function checkUrl() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    // 旧页面的映射对新页面无效且会无限累积，路由切换时清空重新收集
    commentUserMap.clear();
    fieldLayoutLogged = false;
    loadPage();
    addLog('info', `🔄 ${lastUrl}`);
    setTimeout(onDomChange, CONFIG.OBSERVER.urlChangeDelayMs);
  }

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  history.pushState = function (...args) {
    originalPushState.apply(this, args);
    checkUrl();
  };
  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args);
    checkUrl();
  };
  window.addEventListener('popstate', checkUrl);
  // ============================================================
  //  设置面板：点击任意 IP 标签弹出
  //  样式仿 A 站原生弹窗（浅色主题，主色 #fd4c5d，规范与 danmaku-sender 一致）
  // ============================================================
  const ACR_Z_INDEX = 2147483000;

  function ensurePanelStyle() {
    if (document.getElementById('acr-panel-style')) return;
    const style = document.createElement('style');
    style.id = 'acr-panel-style';
    style.textContent = `
      /* —— 仿 A 站原生弹窗：浅色主题，主色 #fd4c5d —— */
      .acr-mask{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:${ACR_Z_INDEX};display:flex;align-items:center;justify-content:center}
      .acr-panel{width:340px;max-width:92vw;background:#fff;border-radius:6px;color:#666;
        font:12px/1.6 PingFangSC,-apple-system,Microsoft Yahei,sans-serif;
        box-shadow:0 6px 24px rgba(0,0,0,.25);overflow:hidden}
      .acr-panel-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px 4px}
      .acr-panel-title{font-size:14px;font-weight:600;color:#333}
      .acr-panel-close{cursor:pointer;font-size:20px;line-height:1;color:#999;transition:color .2s}
      .acr-panel-close:hover{color:#fd4c5d}
      .acr-panel-body{padding:4px 14px 8px}
      .acr-user-card{margin:8px 0 4px;padding:8px 12px;background:#fafafa;border:1px solid #e5e5e5;border-radius:4px;font-size:12px;color:#666}
      .acr-user-card div{display:flex;justify-content:space-between;padding:1px 0}
      .acr-user-card .acr-user-ip{color:#fd4c5d;font-weight:600;font-size:13px}
      .acr-row{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f0f0f0}
      .acr-row:last-child{border-bottom:none}
      .acr-switch{position:relative;width:40px;height:22px;border-radius:11px;background:#ddd;cursor:pointer;transition:background .2s;flex:none}
      .acr-switch::after{content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:left .2s}
      .acr-switch.on{background:#fd4c5d}
      .acr-switch.on::after{left:20px}
      .acr-days{display:flex;border:1px solid #e5e5e5;border-radius:3px;overflow:hidden}
      .acr-days button{border:none;background:#fff;color:#666;font-size:12px;padding:3px 10px;cursor:pointer;border-right:1px solid #e5e5e5;transition:.15s}
      .acr-days button:last-child{border-right:none}
      .acr-days button:hover{background:#f5f5f5}
      .acr-days button.acr-active{background:#fd4c5d;border-color:#fd4c5d;color:#fff}
      .acr-actions{display:flex;gap:6px}
      .acr-actions button{border:1px solid #999;background:#f4f4f4;color:#666;font-size:12px;padding:3px 12px;border-radius:3px;cursor:pointer;transition:.15s;line-height:16px}
      .acr-actions button:hover{background:#e5e5e5}
      .acr-actions button.acr-danger{background:#fff;border-color:#f5222d;color:#f5222d}
      .acr-actions button.acr-danger:hover{background:#fff1f0}
      .acr-panel-foot{padding:10px 14px;font-size:11px;color:#999;background:#fafafa;border-top:1px solid #f0f0f0}
      .acr-ip:hover{color:#fd4c5d !important}
      .acr-toast{background:rgba(0,0,0,.75);color:#fff;font:13px/1.4 PingFangSC,-apple-system,Microsoft Yahei,sans-serif;padding:8px 20px;border-radius:4px;box-shadow:0 2px 12px rgba(0,0,0,.2);animation:acr-toast-in .2s ease-out;white-space:nowrap}
      .acr-toast.out{opacity:0;transition:opacity .3s}
      @keyframes acr-toast-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
    `;
    document.head.appendChild(style);
  }

  function closePanel() {
    document.querySelectorAll('.acr-mask').forEach(el => el.remove());
  }

  function mkPanelBtn(text, onClick, extraClass) {
    const btn = document.createElement('button');
    btn.textContent = text;
    if (extraClass) btn.classList.add(extraClass);
    btn.addEventListener('click', onClick);
    return btn;
  }

  function addTextRow(container, label, value, valueClass) {
    const row = document.createElement('div');
    const key = document.createElement('span');
    key.textContent = label;
    const val = document.createElement('span');
    val.textContent = value;
    if (valueClass) val.classList.add(valueClass);
    row.append(key, val);
    container.appendChild(row);
  }

  function openPanel(uid) {
    ensurePanelStyle();
    closePanel();

    const mask = document.createElement('div');
    mask.className = 'acr-mask';
    mask.addEventListener('click', closePanel);

    const panel = document.createElement('div');
    panel.className = 'acr-panel';
    // 阻止面板内部的点击冒泡到遮罩导致误关
    panel.addEventListener('click', e => e.stopPropagation());

    // —— 头部
    const head = document.createElement('div');
    head.className = 'acr-panel-head';
    const title = document.createElement('span');
    title.className = 'acr-panel-title';
    title.textContent = 'AcFunReveal 设置';
    const close = document.createElement('span');
    close.className = 'acr-panel-close';
    close.textContent = '×';
    close.addEventListener('click', closePanel);
    head.append(title, close);

    const body = document.createElement('div');
    body.className = 'acr-panel-body';

    // —— 用户资料卡片（从 IP 标签进入时展示）
    if (uid) {
      const entry = uids[uid] || pageData[uid];
      const card = document.createElement('div');
      card.className = 'acr-user-card';
      addTextRow(card, '用户名', entry?.name || '未知');
      addTextRow(card, 'UID', String(uid));
      addTextRow(card, 'IP属地', entry?.ip ? entry.ip : (entry ? '无属地记录' : '暂无缓存'), 'acr-user-ip');
      if (entry?.t) addTextRow(card, '查询于', new Date(entry.t).toLocaleString());
      body.appendChild(card);
    }

    // —— 缓存开关
    const switchRow = document.createElement('div');
    switchRow.className = 'acr-row';
    const switchLabel = document.createElement('span');
    switchLabel.textContent = '缓存';
    const toggle = document.createElement('span');
    toggle.className = 'acr-switch' + (enabled ? ' on' : '');
    toggle.addEventListener('click', () => {
      setEnabled(!enabled);
      toggle.classList.toggle('on', enabled);
    });
    switchRow.append(switchLabel, toggle);
    body.appendChild(switchRow);

    // —— 页面缓存保留天数（即时生效，下次 loadPage 起作用）
    const daysRow = document.createElement('div');
    daysRow.className = 'acr-row';
    const daysLabel = document.createElement('span');
    daysLabel.textContent = '页面缓存保留';
    const daysGroup = document.createElement('span');
    daysGroup.className = 'acr-days';
    for (const option of [0, 1, 7, 30]) {
      const btn = document.createElement('button');
      btn.textContent = option === 0 ? '永久' : `${option}天`;
      if (days === option) btn.classList.add('acr-active');
      btn.addEventListener('click', () => {
        days = option;
        writeStorage(CONFIG.CACHE.daysKey, days);
        daysGroup.querySelectorAll('button').forEach(b => b.classList.remove('acr-active'));
        btn.classList.add('acr-active');
      });
      daysGroup.appendChild(btn);
    }
    daysRow.append(daysLabel, daysGroup);
    body.appendChild(daysRow);

    // —— 缓存管理：导出 / 导入 / 清空
    const actionRow = document.createElement('div');
    actionRow.className = 'acr-row';
    const actionLabel = document.createElement('span');
    actionLabel.textContent = '缓存管理';
    const actions = document.createElement('span');
    actions.className = 'acr-actions';
    actions.append(
      mkPanelBtn('导出', exportCache),
      mkPanelBtn('导入', importCache),
      mkPanelBtn('清空', function() { clearCacheWithConfirm(this); }, 'acr-danger'),
    );
    actionRow.append(actionLabel, actions);
    body.appendChild(actionRow);

    const foot = document.createElement('div');
    foot.className = 'acr-panel-foot';
    foot.textContent = `v${VERSION} · 属地基于用户主页实时资料，不代表发布时的IP`;

    panel.append(head, body, foot);
    mask.appendChild(panel);
    document.body.appendChild(mask);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePanel();
    }, { once: true });
  }

  // 点击任意 IP 标签打开面板；捕获阶段拦截，避免触发 A 站自身的评论点击逻辑
  document.addEventListener('click', (e) => {
    const span = e.target?.closest?.('.acr-ip');
    if (!span) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    openPanel(span.dataset.acrUid || null);
  }, true);
  // ============================================================
  //  缓存操作（面板与菜单共用）—— 静默操作，无 alert/confirm/prompt/reload
  // ============================================================
  function persist() {
    save();
    saveUids();
  }

  function setEnabled(next) {
    enabled = next;
    writeStorage(CONFIG.CACHE.enabledKey, enabled);
    if (!enabled) clearAllCache();
    persist();
    showToast(enabled ? '缓存已开启' : '缓存已关闭');
  }

  function describeDays() {
    return days === 0 ? '永久' : `${days}天`;
  }

  function copyLogs() {
    const text = [
      `=== AcFunReveal v${VERSION} ===`,
      `时间: ${new Date().toLocaleString()}`,
      `页面: ${location.href}`,
      `页面ID: ${pageId || '无(不缓存)'}`,
      `本页缓存: ${Object.keys(pageData).length} 条`,
      `页面数: ${Object.keys(cache).length} 个`,
      `uid缓存: ${Object.keys(uids).length} 条`,
      `=============================`,
      ...logs,
    ].join('\n');
    GM_setClipboard?.(text, 'text');
    showToast('日志已复制');
  }

  function copyPageCache() {
    const rows = Object.entries(pageData)
      .filter(([, data]) => data.ip)
      .map(([uid, data]) => ({ 用户ID: uid, 用户名: data.name, IP: data.ip }));
    console.table(rows);
    GM_setClipboard?.(JSON.stringify(rows, null, 2), 'text');
    showToast(`${rows.length} 条已复制`);
  }

  function exportCache() {
    const payload = { version: VERSION, pages: cache, uids };
    GM_setClipboard?.(JSON.stringify(payload, null, 2), 'text');
    showToast(`已复制：${Object.keys(cache).length} 个页面，${Object.keys(uids).length} 条 uid 缓存`);
  }

  function importCache() {
    const panel = document.querySelector('.acr-panel');
    if (!panel) return;
    const body = panel.querySelector('.acr-panel-body');
    const oldBody = body.innerHTML;
    body.innerHTML = `
      <div style="margin:8px 0 4px">
        <div style="font-size:13px;color:#333;margin-bottom:6px">粘贴缓存 JSON：</div>
        <textarea class="acr-import-input" placeholder='{"version":"...","pages":{},"uids":{}}'
          style="width:100%;height:100px;resize:vertical;border:1px solid #e5e5e5;border-radius:3px;padding:6px;font:12px/1.4 monospace;color:#333;box-sizing:border-box"></textarea>
      </div>
      <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:8px">
        <button class="acr-import-cancel" style="border:1px solid #999;background:#f4f4f4;color:#666;font-size:12px;padding:3px 12px;border-radius:3px;cursor:pointer">取消</button>
        <button class="acr-import-confirm" style="border:none;background:#fd4c5d;color:#fff;font-size:12px;padding:3px 12px;border-radius:3px;cursor:pointer">导入</button>
      </div>`;
    body.querySelector('.acr-import-cancel').addEventListener('click', () => openPanel());
    body.querySelector('.acr-import-confirm').addEventListener('click', () => {
      const input = body.querySelector('.acr-import-input').value.trim();
      if (!input) { showToast('请输入 JSON'); return; }
      let data;
      try { data = JSON.parse(input); } catch (e) { showToast('❌ ' + e.message); return; }
      const bundled = data && typeof data === 'object' && (data.pages || data.uids);
      let pageCount = 0;
      for (const [key, entry] of Object.entries(bundled ? (data.pages || {}) : data)) {
        if (entry?.d && !cache[key]) { cache[key] = entry; pageCount++; }
      }
      let uidCount = 0;
      if (bundled) {
        for (const [uid, entry] of Object.entries(data.uids || {})) {
          if (entry && !uids[uid]) { uids[uid] = entry; uidCount++; }
        }
      }
      persist();
      loadPage();
      showToast(`导入 ${pageCount} 个页面，${uidCount} 条 uid 缓存`);
      openPanel();
    });
  }

  function clearCacheWithConfirm(btn) {
    if (btn.dataset.acrConfirming) {
      delete btn.dataset.acrConfirming;
      clearAllCache();
      showToast('缓存已清空');
      btn.textContent = '清空';
      return;
    }
    btn.dataset.acrConfirming = '1';
    btn.textContent = '确认清空?';
    setTimeout(() => { delete btn.dataset.acrConfirming; if (btn.isConnected) btn.textContent = '清空'; }, 3000);
  }

  function showToast(message) {
    let container = document.getElementById('acr-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'acr-toast-container';
      container.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:2147483647;display:flex;flex-direction:column;gap:6px;pointer-events:none';
      document.body.appendChild(container);
    }
    if (!document.getElementById('acr-toast-style')) {
      const style = document.createElement('style');
      style.id = 'acr-toast-style';
      style.textContent = `
        .acr-toast{background:rgba(0,0,0,.75);color:#fff;font:13px/1.4 PingFangSC,-apple-system,Microsoft Yahei,sans-serif;padding:8px 20px;border-radius:4px;box-shadow:0 2px 12px rgba(0,0,0,.2);animation:acr-toast-in .2s ease-out;white-space:nowrap}
        .acr-toast.out{opacity:0;transition:opacity .3s}
        @keyframes acr-toast-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
      `;
      document.head.appendChild(style);
    }
    const toast = document.createElement('div');
    toast.className = 'acr-toast';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => { toast.classList.add('out'); setTimeout(() => toast.remove(), 300); }, 2000);
  }
  // ============================================================
  //  油猴菜单（只保留只读入口 + 面板兜底入口）
  // ============================================================
  function registerMenus() {
    if (typeof GM_registerMenuCommand === 'undefined') return;
    const commands = [
      { title: () => '⚙️ 设置面板', run: () => openPanel() },
      { title: () => '📋 复制全部日志', run: copyLogs },
      { title: () => '📊 查看本页缓存', run: copyPageCache },
    ];
    for (const command of commands) GM_registerMenuCommand(command.title(), command.run);
  }
  // ============================================================
  //  启动
  // ============================================================
  enabled = readStorage(CONFIG.CACHE.enabledKey, true);
  days = readStorage(CONFIG.CACHE.daysKey, 0);
  cache = readStorage(CONFIG.CACHE.key, {});
  uids = readStorage(CONFIG.CACHE.uidKey, {});

  pruneExpiredPages();
  save();
  loadPage();

  hookFetch();
  hookXHR();
  startObserver();
  registerMenus();
  setTimeout(onDomChange, CONFIG.OBSERVER.urlChangeDelayMs);
  setTimeout(checkUrl, 100);

  // 暴露纯函数与内部状态，供控制台调试和单元测试使用
  window.ACFunReveal = {
    version: VERSION,
    config: CONFIG,
    // 纯函数（可直接单测）
    extractCommentList,
    extractUidFromComment,
    parseUidFromHref,
    isCommentUrl,
    isFailureCacheFresh,
    // 内部状态（只读调试用）
    getState: () => ({
      enabled,
      days,
      pageId,
      cachePages: Object.keys(cache).length,
      pageDataSize: Object.keys(pageData).length,
      uidCacheSize: Object.keys(uids).length,
    }),
    getLogs: () => logs.slice(),
  };

  log(`🚀 AcFunReveal v${VERSION} | ${pageId || '无缓存'} | ${enabled ? describeDays() : '关闭'} | ${Object.keys(pageData).length}条`);
})();
