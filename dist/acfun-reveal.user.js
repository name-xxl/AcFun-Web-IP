// ==UserScript==
// @name         AcFunReveal - A站网页版显示 IP 属地
// @namespace    http://acfun-reveal.local
// @version      5.8.1
// @description  显示评论 IP 属地（可视区域优先），并将设备型号代号替换为友好名称
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
  const VERSION = '5.8.1';

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
    // 设备型号美化（56-device.js）
    DEVICE: {
      selector: '.deviceModel',
      processedAttr: 'data-acr-done',
      manualAttr: 'data-acr-manual',
      storageKey: 'acr_device_models',
      metaKey: 'acr_device_models_meta',
      settingsKey: 'acr_device_settings',
      cacheMaxSize: 500,
    },
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

  // 导入数据的键可能来自外部 JSON/文本：__proto__ 这类键走原型链 setter，
  // 赋值不会写入自身属性，静默丢失，必须跳过
  function isSafeKey(key) {
    return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
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
    if (style) span.style.cssText += style;
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
//  设备型号内置数据 — 由 tools/gen-device-data.js 自动生成，勿手改
//  数据来源:
//  - KHwang9883/MobileModels (CC BY-NC-SA 4.0) — 安卓各品牌国行数据
//  - adamawolf/Apple_mobile_device_types — Apple 全系型号
//  更新数据: node tools/gen-device-data.js <MobileModels 数据目录>
// ============================================================
const DEVICE_BUILTIN = {
  "2014616": "小米 Note 双网通版",
  "2014617": "小米 Note 联通合约版",
  "2014618": "小米 Note 移动合约版",
  "2014619": "小米 Note 全网通版",
  "2015021": "小米 Note 顶配版 双网通版",
  "2015022": "小米 Note 顶配版 全网通版",
  "2015211": "小米 Note 2 全网通版",
  "2015212": "小米 Note 2 移动 4G+ 版",
  "2015213": "小米 Note 2 (全球频段)",
  "2015501": "小米 Note 顶配版 移动合约版",
  "iPhone1,1": "iPhone",
  "iPhone1,2": "iPhone 3G",
  "iPhone2,1": "iPhone 3GS",
  "iPhone3,1": "iPhone 4",
  "iPhone3,2": "iPhone 4 GSM Rev A",
  "iPhone3,3": "iPhone 4 CDMA",
  "iPhone4,1": "iPhone 4S",
  "iPhone5,1": "iPhone 5 (GSM)",
  "iPhone5,2": "iPhone 5 (GSM+CDMA)",
  "iPhone5,3": "iPhone 5C (GSM)",
  "iPhone5,4": "iPhone 5C (Global)",
  "iPhone6,1": "iPhone 5S (GSM)",
  "iPhone6,2": "iPhone 5S (Global)",
  "iPhone7,1": "iPhone 6 Plus",
  "iPhone7,2": "iPhone 6",
  "iPhone8,1": "iPhone 6s",
  "iPhone8,2": "iPhone 6s Plus",
  "iPhone8,4": "iPhone SE (GSM)",
  "iPhone9,1": "iPhone 7",
  "iPhone9,2": "iPhone 7 Plus",
  "iPhone9,3": "iPhone 7",
  "iPhone9,4": "iPhone 7 Plus",
  "iPhone10,1": "iPhone 8",
  "iPhone10,2": "iPhone 8 Plus",
  "iPhone10,3": "iPhone X Global",
  "iPhone10,4": "iPhone 8",
  "iPhone10,5": "iPhone 8 Plus",
  "iPhone10,6": "iPhone X GSM",
  "iPhone11,2": "iPhone XS",
  "iPhone11,4": "iPhone XS Max",
  "iPhone11,6": "iPhone XS Max Global",
  "iPhone11,8": "iPhone XR",
  "iPhone12,1": "iPhone 11",
  "iPhone12,3": "iPhone 11 Pro",
  "iPhone12,5": "iPhone 11 Pro Max",
  "iPhone12,8": "iPhone SE 2nd Gen",
  "iPhone13,1": "iPhone 12 Mini",
  "iPhone13,2": "iPhone 12",
  "iPhone13,3": "iPhone 12 Pro",
  "iPhone13,4": "iPhone 12 Pro Max",
  "iPhone14,2": "iPhone 13 Pro",
  "iPhone14,3": "iPhone 13 Pro Max",
  "iPhone14,4": "iPhone 13 Mini",
  "iPhone14,5": "iPhone 13",
  "iPhone14,6": "iPhone SE 3rd Gen",
  "iPhone14,7": "iPhone 14",
  "iPhone14,8": "iPhone 14 Plus",
  "iPhone15,2": "iPhone 14 Pro",
  "iPhone15,3": "iPhone 14 Pro Max",
  "iPhone15,4": "iPhone 15",
  "iPhone15,5": "iPhone 15 Plus",
  "iPhone16,1": "iPhone 15 Pro",
  "iPhone16,2": "iPhone 15 Pro Max",
  "iPhone17,1": "iPhone 16 Pro",
  "iPhone17,2": "iPhone 16 Pro Max",
  "iPhone17,3": "iPhone 16",
  "iPhone17,4": "iPhone 16 Plus",
  "iPhone17,5": "iPhone 16e",
  "iPhone18,1": "iPhone 17 Pro",
  "iPhone18,2": "iPhone 17 Pro Max",
  "iPhone18,3": "iPhone 17",
  "iPhone18,4": "iPhone Air",
  "iPhone18,5": "iPhone 17e",
  "iPod1,1": "1st Gen iPod",
  "iPod2,1": "2nd Gen iPod",
  "iPod3,1": "3rd Gen iPod",
  "iPod4,1": "4th Gen iPod",
  "iPod5,1": "5th Gen iPod",
  "iPod7,1": "6th Gen iPod",
  "iPod9,1": "7th Gen iPod",
  "iPad1,1": "iPad",
  "iPad1,2": "iPad 3G",
  "iPad2,1": "2nd Gen iPad",
  "iPad2,2": "2nd Gen iPad GSM",
  "iPad2,3": "2nd Gen iPad CDMA",
  "iPad2,4": "2nd Gen iPad New Revision",
  "iPad3,1": "3rd Gen iPad",
  "iPad3,2": "3rd Gen iPad CDMA",
  "iPad3,3": "3rd Gen iPad GSM",
  "iPad2,5": "iPad mini",
  "iPad2,6": "iPad mini GSM+LTE",
  "iPad2,7": "iPad mini CDMA+LTE",
  "iPad3,4": "4th Gen iPad",
  "iPad3,5": "4th Gen iPad GSM+LTE",
  "iPad3,6": "4th Gen iPad CDMA+LTE",
  "iPad4,1": "iPad Air (WiFi)",
  "iPad4,2": "iPad Air (GSM+CDMA)",
  "iPad4,3": "1st Gen iPad Air (China)",
  "iPad4,4": "iPad mini Retina (WiFi)",
  "iPad4,5": "iPad mini Retina (GSM+CDMA)",
  "iPad4,6": "iPad mini Retina (China)",
  "iPad4,7": "iPad mini 3 (WiFi)",
  "iPad4,8": "iPad mini 3 (GSM+CDMA)",
  "iPad4,9": "iPad Mini 3 (China)",
  "iPad5,1": "iPad mini 4 (WiFi)",
  "iPad5,2": "iPad mini 4 (WiFi+Cellular)",
  "iPad5,3": "iPad Air 2 (WiFi)",
  "iPad5,4": "iPad Air 2 (Cellular)",
  "iPad6,3": "iPad Pro (9.7 inch, WiFi)",
  "iPad6,4": "iPad Pro (9.7 inch, WiFi+LTE)",
  "iPad6,7": "iPad Pro (12.9 inch, WiFi)",
  "iPad6,8": "iPad Pro (12.9 inch, WiFi+LTE)",
  "iPad6,11": "iPad (2017)",
  "iPad6,12": "iPad (2017)",
  "iPad7,1": "iPad Pro 2nd Gen (WiFi)",
  "iPad7,2": "iPad Pro 2nd Gen (WiFi+Cellular)",
  "iPad7,3": "iPad Pro 10.5-inch 2nd Gen (WiFi)",
  "iPad7,4": "iPad Pro 10.5-inch 2nd Gen (WiFi+Cellular)",
  "iPad7,5": "iPad 6th Gen (WiFi)",
  "iPad7,6": "iPad 6th Gen (WiFi+Cellular)",
  "iPad7,11": "iPad 7th Gen 10.2-inch (WiFi)",
  "iPad7,12": "iPad 7th Gen 10.2-inch (WiFi+Cellular)",
  "iPad8,1": "iPad Pro 11 inch 3rd Gen (WiFi)",
  "iPad8,2": "iPad Pro 11 inch 3rd Gen (1TB, WiFi)",
  "iPad8,3": "iPad Pro 11 inch 3rd Gen (WiFi+Cellular)",
  "iPad8,4": "iPad Pro 11 inch 3rd Gen (1TB, WiFi+Cellular)",
  "iPad8,5": "iPad Pro 12.9 inch 3rd Gen (WiFi)",
  "iPad8,6": "iPad Pro 12.9 inch 3rd Gen (1TB, WiFi)",
  "iPad8,7": "iPad Pro 12.9 inch 3rd Gen (WiFi+Cellular)",
  "iPad8,8": "iPad Pro 12.9 inch 3rd Gen (1TB, WiFi+Cellular)",
  "iPad8,9": "iPad Pro 11 inch 4th Gen (WiFi)",
  "iPad8,10": "iPad Pro 11 inch 4th Gen (WiFi+Cellular)",
  "iPad8,11": "iPad Pro 12.9 inch 4th Gen (WiFi)",
  "iPad8,12": "iPad Pro 12.9 inch 4th Gen (WiFi+Cellular)",
  "iPad11,1": "iPad mini 5th Gen (WiFi)",
  "iPad11,2": "iPad mini 5th Gen (WiFi+Cellular)",
  "iPad11,3": "iPad Air 3rd Gen (WiFi)",
  "iPad11,4": "iPad Air 3rd Gen (WiFi+Cellular)",
  "iPad11,6": "iPad 8th Gen (WiFi)",
  "iPad11,7": "iPad 8th Gen (WiFi+Cellular)",
  "iPad12,1": "iPad 9th Gen (WiFi)",
  "iPad12,2": "iPad 9th Gen (WiFi+Cellular)",
  "iPad14,1": "iPad mini 6th Gen (WiFi)",
  "iPad14,2": "iPad mini 6th Gen (WiFi+Cellular)",
  "iPad13,1": "iPad Air 4th Gen (WiFi)",
  "iPad13,2": "iPad Air 4th Gen (WiFi+Cellular)",
  "iPad13,4": "iPad Pro 11 inch 5th Gen",
  "iPad13,5": "iPad Pro 11 inch 5th Gen",
  "iPad13,6": "iPad Pro 11 inch 5th Gen",
  "iPad13,7": "iPad Pro 11 inch 5th Gen",
  "iPad13,8": "iPad Pro 12.9 inch 5th Gen",
  "iPad13,9": "iPad Pro 12.9 inch 5th Gen",
  "iPad13,10": "iPad Pro 12.9 inch 5th Gen",
  "iPad13,11": "iPad Pro 12.9 inch 5th Gen",
  "iPad13,16": "iPad Air 5th Gen (WiFi)",
  "iPad13,17": "iPad Air 5th Gen (WiFi+Cellular)",
  "iPad13,18": "iPad 10th Gen (WiFi)",
  "iPad13,19": "iPad 10th Gen (WiFi+Cellular)",
  "iPad14,3": "iPad Pro 11 inch 4th Gen (WiFi)",
  "iPad14,4": "iPad Pro 11 inch 4th Gen (WiFi+Cellular)",
  "iPad14,5": "iPad Pro 12.9 inch 6th Gen (WiFi)",
  "iPad14,6": "iPad Pro 12.9 inch 6th Gen (WiFi+Cellular)",
  "iPad14,8": "iPad Air 11 inch 6th Gen (WiFi)",
  "iPad14,9": "iPad Air 11 inch 6th Gen (WiFi+Cellular)",
  "iPad14,10": "iPad Air 13 inch 6th Gen (WiFi)",
  "iPad14,11": "iPad Air 13 inch 6th Gen (WiFi+Cellular)",
  "iPad15,3": "iPad Air 11-inch 7th Gen (WiFi)",
  "iPad15,4": "iPad Air 11-inch 7th Gen (WiFi+Cellular)",
  "iPad15,5": "iPad Air 13-inch 7th Gen (WiFi)",
  "iPad15,6": "iPad Air 13-inch 7th Gen (WiFi+Cellular)",
  "iPad15,7": "iPad 11th Gen (WiFi)",
  "iPad15,8": "iPad 11th Gen (WiFi+Cellular)",
  "iPad16,1": "iPad mini 7th Gen (WiFi)",
  "iPad16,2": "iPad mini 7th Gen (WiFi+Cellular)",
  "iPad16,3": "iPad Pro 11 inch 5th Gen (WiFi)",
  "iPad16,4": "iPad Pro 11 inch 5th Gen (WiFi+Cellular)",
  "iPad16,5": "iPad Pro 12.9 inch 7th Gen (WiFi)",
  "iPad16,6": "iPad Pro 12.9 inch 7th Gen (WiFi+Cellular)",
  "iPad16,8": "iPad Air 11-inch 8th Gen (WiFi)",
  "iPad16,9": "iPad Air 11-inch 8th Gen (WiFi+Cellular)",
  "iPad16,10": "iPad Air 13-inch 8th Gen (WiFi)",
  "iPad16,11": "iPad Air 13-inch 8th Gen (WiFi+Cellular)",
  "Watch1,1": "Apple Watch 38mm case",
  "Watch1,2": "Apple Watch 42mm case",
  "Watch2,6": "Apple Watch Series 1 38mm case",
  "Watch2,7": "Apple Watch Series 1 42mm case",
  "Watch2,3": "Apple Watch Series 2 38mm case",
  "Watch2,4": "Apple Watch Series 2 42mm case",
  "Watch3,1": "Apple Watch Series 3 38mm case (GPS+Cellular)",
  "Watch3,2": "Apple Watch Series 3 42mm case (GPS+Cellular)",
  "Watch3,3": "Apple Watch Series 3 38mm case (GPS)",
  "Watch3,4": "Apple Watch Series 3 42mm case (GPS)",
  "Watch4,1": "Apple Watch Series 4 40mm case (GPS)",
  "Watch4,2": "Apple Watch Series 4 44mm case (GPS)",
  "Watch4,3": "Apple Watch Series 4 40mm case (GPS+Cellular)",
  "Watch4,4": "Apple Watch Series 4 44mm case (GPS+Cellular)",
  "Watch5,1": "Apple Watch Series 5 40mm case (GPS)",
  "Watch5,2": "Apple Watch Series 5 44mm case (GPS)",
  "Watch5,3": "Apple Watch Series 5 40mm case (GPS+Cellular)",
  "Watch5,4": "Apple Watch Series 5 44mm case (GPS+Cellular)",
  "Watch5,9": "Apple Watch SE 40mm case (GPS)",
  "Watch5,10": "Apple Watch SE 44mm case (GPS)",
  "Watch5,11": "Apple Watch SE 40mm case (GPS+Cellular)",
  "Watch5,12": "Apple Watch SE 44mm case (GPS+Cellular)",
  "Watch6,1": "Apple Watch Series 6 40mm case (GPS)",
  "Watch6,2": "Apple Watch Series 6 44mm case (GPS)",
  "Watch6,3": "Apple Watch Series 6 40mm case (GPS+Cellular)",
  "Watch6,4": "Apple Watch Series 6 44mm case (GPS+Cellular)",
  "Watch6,6": "Apple Watch Series 7 41mm case (GPS)",
  "Watch6,7": "Apple Watch Series 7 45mm case (GPS)",
  "Watch6,8": "Apple Watch Series 7 41mm case (GPS+Cellular)",
  "Watch6,9": "Apple Watch Series 7 45mm case (GPS+Cellular)",
  "Watch6,10": "Apple Watch SE 40mm case (GPS)",
  "Watch6,11": "Apple Watch SE 44mm case (GPS)",
  "Watch6,12": "Apple Watch SE 40mm case (GPS+Cellular)",
  "Watch6,13": "Apple Watch SE 44mm case (GPS+Cellular)",
  "Watch6,14": "Apple Watch Series 8 41mm case (GPS)",
  "Watch6,15": "Apple Watch Series 8 45mm case (GPS)",
  "Watch6,16": "Apple Watch Series 8 41mm case (GPS+Cellular)",
  "Watch6,17": "Apple Watch Series 8 45mm case (GPS+Cellular)",
  "Watch6,18": "Apple Watch Ultra",
  "Watch7,1": "Apple Watch Series 9 41mm case (GPS)",
  "Watch7,2": "Apple Watch Series 9 45mm case (GPS)",
  "Watch7,3": "Apple Watch Series 9 41mm case (GPS+Cellular)",
  "Watch7,4": "Apple Watch Series 9 45mm case (GPS+Cellular)",
  "Watch7,5": "Apple Watch Ultra 2",
  "Watch7,8": "Apple Watch Series 10 42mm case (GPS)",
  "Watch7,9": "Apple Watch Series 10 46mm case (GPS)",
  "Watch7,10": "Apple Watch Series 10 42mm case (GPS+Cellular)",
  "Watch7,11": "Apple Watch Series 10 46mm case (GPS+Cellular)",
  "Watch7,12": "Apple Watch Ultra 3 49mm case",
  "Watch7,13": "Apple Watch SE 3 40mm case",
  "Watch7,14": "Apple Watch SE 3 44mm case",
  "Watch7,15": "Apple Watch SE 3 40mm case (GPS+Cellular)",
  "Watch7,16": "Apple Watch SE 3 44mm case (GPS+Cellular)",
  "Watch7,17": "Apple Watch Series 11 42mm case",
  "Watch7,18": "Apple Watch Series 11 46mm case",
  "Watch7,19": "Apple Watch Series 11 42mm case (GPS+Celllular)",
  "Watch7,20": "Apple Watch Series 11 46mm case (GPS+Celllular)",
  "23116PN5BC": "Xiaomi 14 Pro / Xiaomi 14 Pro 钛金属版",
  "2311BPN23C": "Xiaomi 14 Pro 钛金属版 (卫星通讯)",
  "24031PN0DC": "Xiaomi 14 Ultra",
  "24129PN74C": "Xiaomi 15",
  "2410DPN6CC": "Xiaomi 15 Pro",
  "25019PNF3C": "Xiaomi 15 Ultra",
  "25010PN30C": "Xiaomi 15 Ultra 双卫星版",
  "25042PN24C": "Xiaomi 15S Pro",
  "25113PN0EC": "Xiaomi 17",
  "25098PN5AC": "Xiaomi 17 Pro",
  "2509FPN0BC": "Xiaomi 17 Pro Max",
  "2512BPNDAC": "Xiaomi 17 Ultra / Xiaomi 17 Ultra by Leica (非卫星)",
  "25128PNA1C": "Xiaomi 17 Ultra by Leica (卫星通讯)",
  "2605EPN8EC": "Xiaomi 17 Max",
  "M531DA": "Xiaomi 17T",
  "M025EC": "Xiaomi 17T Pro",
  "MCE8": "小米 Note 3 全网通版",
  "MCT8": "小米 Note 3 移动 4G+ 版",
  "MDE5": "小米 MIX 2 黑色陶瓷版 全网通版",
  "MDT5": "小米 MIX 2 黑色陶瓷版 移动 4G+ 版",
  "MDE5S": "小米 MIX 2 全陶瓷尊享版",
  "M1803D5XE": "小米 MIX 2S 全网通版",
  "M1803D5XA": "小米 MIX 2S 尊享版 (全球频段)",
  "M1803D5XT": "小米 MIX 2S 移动 4G+ 版",
  "M1810E5E": "小米 MIX 3",
  "M1810E5A": "小米 MIX 3 (全球频段)",
  "M1810E5GG": "小米 MIX 3 5G",
  "2106118C": "Xiaomi MIX 4",
  "M2011J18C": "MIX FOLD 小米折叠屏手机",
  "22061218C": "Xiaomi MIX Fold 2",
  "2308CPXD0C": "Xiaomi MIX Fold 3",
  "24072PX77C": "Xiaomi MIX Fold 4",
  "2405CPX3DC": "Xiaomi MIX Flip",
  "2505APX7BC": "Xiaomi MIX Flip 2",
  "MDE40": "小米 Max 2 全网通版",
  "MDT4": "小米 Max 2 移动 4G+ 版",
  "M1804E4A": "小米 Max 3 全网通版",
  "M1804E4T": "小米 Max 3 移动 4G+ 版",
  "M1904F3BC": "小米 CC9",
  "M1906F9SC": "小米 CC9e",
  "M1910F4E": "小米 CC9 Pro",
  "2109119BC": "Xiaomi Civi",
  "2209129SC": "Xiaomi Civi 2",
  "23046PNC9C": "Xiaomi Civi 3",
  "24053PY09C": "Xiaomi Civi 4 Pro",
  "25067PYE3C": "Xiaomi Civi 5 Pro",
  "M1901F9E": "小米 Play 全网通版",
  "M1901F9T": "小米 Play 移动 4G+ 版",
  "M1903C3EE": "Redmi 7A 全网通版",
  "M1903C3ET": "Redmi 7A 移动 4G+ 版",
  "M1908C3IE": "Redmi 8 全网通版",
  "M1908C3IC": "Redmi 8 运营商全网通版",
  "M1908C3KE": "Redmi 8A",
  "M2004J19C": "Redmi 9",
  "M2006C3LC": "Redmi 9A",
  "220233L2C": "Redmi 10A",
  "23077RABDC": "Redmi 12 5G",
  "23076RA4BC": "Redmi 12R",
  "22120RN86C": "Redmi 12C",
  "23124RN87C": "Redmi 13C 5G / Redmi 13R 5G",
  "2409BRN2CC": "Redmi 14C / REDMI 17C",
  "2411DRN47C": "Redmi 14R 5G",
  "25082RNC1C": "REDMI 15R 5G",
  "2602BRNA4C": "REDMI 17 5G",
  "2312DRAABC": "Redmi Note 13 5G",
  "2312DRA50C": "Redmi Note 13 Pro (LPDDR4x + UFS 2.2)",
  "2312CRAD3C": "Redmi Note 13 Pro (LPDDR5 + UFS 3.1)",
  "23090RA98C": "Redmi Note 13 Pro+",
  "2406ERN9CC": "Redmi Note 13R",
  "2311FRAFDC": "Redmi Note 13R Pro",
  "24094RAD4C": "Redmi Note 14 5G / REDMI Note 15R Pro",
  "24090RA29C": "Redmi Note 14 Pro",
  "24115RA8EC": "Redmi Note 14 Pro+",
  "25098RA98C": "REDMI Note 15",
  "25080RABDC": "REDMI Note 15 Pro",
  "2510ERA8BC": "REDMI Note 15 Pro+",
  "25104RADAC": "REDMI Note 15 Pro+ 卫星消息版",
  "25057RA09C": "REDMI Note 15R",
  "26021RN18C": "REDMI Note 17",
  "2607DRA18C": "REDMI Note 17 Pro",
  "M2004J7AC": "Redmi 10X 5G",
  "M2004J7BC": "Redmi 10X Pro 5G",
  "M2003J15SC": "Redmi 10X 4G",
  "24069RA21C": "Redmi Turbo 3",
  "24129RT7CC": "REDMI Turbo 4",
  "25053RT47C": "REDMI Turbo 4 Pro",
  "2511FRT34C": "REDMI Turbo 5",
  "2602BRT18C": "REDMI Turbo 5 Max",
  "23078RKD5C": "Redmi K60 至尊版",
  "23113RKC6C": "Redmi K70",
  "23117RK66C": "Redmi K70 Pro",
  "2311DRK48C": "Redmi K70E",
  "2407FRK8EC": "Redmi K70 至尊版",
  "24117RK2CC": "REDMI K80",
  "24122RKC7C": "REDMI K80 Pro",
  "24127RK2CC": "REDMI K80 Pro 冠军版",
  "25060RK16C": "REDMI K80 至尊版",
  "2510DRK44C": "REDMI K90",
  "25102RKBEC": "REDMI K90 Pro Max",
  "25102RK69C": "REDMI K90 Pro Max 冠军版",
  "2604FRK1EC": "REDMI K90 Max",
  "M332BF": "REDMI K90 至尊版",
  "M511CD": "REDMI K100 Pro",
  "M098FE": "REDMI K100 Pro Max",
  "M1803E6E": "红米 S2 全网通版",
  "M1803E6T": "红米 S2 移动 4G+ 版",
  "26020RN1AC": "REDMI R70 5G / REDMI R70m 5G",
  "26062RN92C": "REDMI M100",
  "21051191C": "CyberDog 仿生四足机器人",
  "2405AVPB7C": "小米澎湃智能座舱 (第一代 SU7/SU7 Ultra)",
  "25033VP3FC": "小米澎湃智能座舱 (YU7/新一代 SU7)",
  "2503CVPC6C": "小米汽车后排移动控制屏",
  "CET-AL60": "HUAWEI Mate 50E",
  "DCO-AL00": "HUAWEI Mate 50 Pro",
  "BRA-AL00": "HUAWEI Mate 60",
  "ALN-AL00": "HUAWEI Mate 60 Pro",
  "ALN-AL80": "HUAWEI Mate 60 Pro",
  "ALN-AL10": "HUAWEI Mate 60 Pro+",
  "CLS-AL00": "HUAWEI Mate 70",
  "CLS-AL30": "HUAWEI Mate 70",
  "PLR-AL00": "HUAWEI Mate 70 Pro",
  "PLR-AL30": "HUAWEI Mate 70 Pro",
  "PLR-AL50": "HUAWEI Mate 70 Pro 优享版",
  "PLA-AL10": "HUAWEI Mate 70 Pro+",
  "PLU-AL10": "HUAWEI Mate 70 RS 非凡大师",
  "SUP-AL90": "HUAWEI Mate 70 Air",
  "VYG-AL00": "HUAWEI Mate 80",
  "SGT-AL50": "HUAWEI Mate 80 Pro (麒麟 9030)",
  "SGT-AL00": "HUAWEI Mate 80 Pro (麒麟 9030 Pro)",
  "SGT-AL10": "HUAWEI Mate 80 Pro Max / HUAWEI Mate 80 Pro Max 风驰版",
  "SGU-AL10": "HUAWEI Mate 80 RS 非凡大师",
  "TAH-AN00": "HUAWEI Mate X",
  "TAH-AN00m": "HUAWEI Mate Xs",
  "TET-AN00": "HUAWEI Mate X2 5G",
  "TET-AN10": "HUAWEI Mate X2 5G",
  "TET-AN50": "HUAWEI Mate X2 典藏版 5G",
  "TET-AL00": "HUAWEI Mate X2 4G",
  "PAL-AL00": "HUAWEI Mate Xs 2",
  "PAL-AL10": "HUAWEI Mate Xs 2",
  "ALT-AL00": "HUAWEI Mate X3",
  "ALT-AL10": "HUAWEI Mate X5",
  "GRL-AL10": "HUAWEI Mate XT 非凡大师",
  "ICL-AL10": "HUAWEI Mate X6",
  "ICL-AL20": "HUAWEI Mate X6 典藏版",
  "GRL-AL20": "HUAWEI Mate XTs 非凡大师",
  "DEL-AL10": "HUAWEI Mate X7",
  "DEL-AL20": "HUAWEI Mate X7 典藏版",
  "VOG-TL00": "HUAWEI P30 Pro 移动 4G+ 版",
  "ANA-AL00": "HUAWEI P40 4G 全网通版",
  "ANA-AN00": "HUAWEI P40 5G 全网通版",
  "ANA-TN00": "HUAWEI P40 5G 移动版",
  "ELS-AN00": "HUAWEI P40 Pro 5G 全网通版",
  "ELS-TN00": "HUAWEI P40 Pro 5G 移动版",
  "ELS-AN10": "HUAWEI P40 Pro+ 5G 全网通版",
  "ELS-TN10": "HUAWEI P40 Pro+ 5G 移动版",
  "ABR-AL00": "HUAWEI P50",
  "ABR-AL80": "HUAWEI P50",
  "ABR-AL60": "HUAWEI P50E",
  "ABR-AL90": "HUAWEI P50E",
  "JAD-AL00": "HUAWEI P50 Pro (骁龙 888)",
  "JAD-AL80": "HUAWEI P50 Pro (骁龙 888)",
  "JAD-AL50": "HUAWEI P50 Pro (麒麟 9000)",
  "JAD-AL60": "HUAWEI P50 Pro (麒麟 9000)",
  "BAL-AL00": "HUAWEI P50 Pocket",
  "BAL-AL80": "HUAWEI P50 Pocket",
  "LNA-AL00": "HUAWEI P60",
  "MNA-AL00": "HUAWEI P60 Pro",
  "ADY-AL00": "HUAWEI Pura 70",
  "ADY-AL10": "HUAWEI Pura 70 北斗卫星消息版",
  "HBN-AL00": "HUAWEI Pura 70 Pro",
  "HBN-AL10": "HUAWEI Pura 70 Pro+",
  "HBN-AL80": "HUAWEI Pura 70 Pro+",
  "HBP-AL00": "HUAWEI Pura 70 Ultra",
  "HED-AL00": "HUAWEI Pura 80",
  "LMR-AL00": "HUAWEI Pura 80 Pro",
  "LMR-AL10": "HUAWEI Pura 80 Pro+",
  "KEE-AL00": "HUAWEI Pura 90",
  "MLN-AL00": "HUAWEI Pura 90 Pro",
  "SCA-AL00": "HUAWEI Pura 90 Pro Max",
  "VDE-AL00": "HUAWEI Pura X",
  "VDE-AL10": "HUAWEI Pura X 典藏版",
  "HOP-AL00": "HUAWEI Pura X Max",
  "HOP-AL10": "HUAWEI Pura X Max 典藏版",
  "BAL-AL60": "HUAWEI Pocket S",
  "LEM-AL00": "HUAWEI Pocket 2",
  "LEM-AL50": "HUAWEI Pocket 2 优享版",
  "RTE-AL00": "HUAWEI nova 9 Pro",
  "JLN-AL00": "HUAWEI nova 9 SE",
  "NCO-AL00": "HUAWEI nova 10",
  "GLA-AL00": "HUAWEI nova 10 Pro",
  "CHA-AL80": "HUAWEI nova 10z",
  "BNE-AL00": "HUAWEI nova 10 SE",
  "FOA-AL00": "HUAWEI nova 11",
  "GOA-AL80": "HUAWEI nova 11 Pro",
  "GOA-AL80U": "HUAWEI nova 11 Ultra",
  "BON-AL00": "HUAWEI nova 11 SE",
  "BLK-AL00": "HUAWEI nova 12",
  "FIN-AL60": "HUAWEI nova 12 活力版",
  "FIN-AL60a": "HUAWEI nova 12 活力版",
  "ADA-AL00": "HUAWEI nova 12 Pro",
  "ADA-AL00U": "HUAWEI nova 12 Ultra",
  "ADA-AL10U": "HUAWEI nova 12 Ultra 星耀版",
  "PSD-AL00": "HUAWEI nova Flip",
  "BLK-AL80": "HUAWEI nova 13",
  "MIS-AL00": "HUAWEI nova 13 Pro",
  "TLR-AL00": "HUAWEI nova 14",
  "MIA-AL00": "HUAWEI nova 14 Pro",
  "MRT-AL10": "HUAWEI nova 14 Ultra",
  "TYR-AL00": "HUAWEI nova 14 活力版",
  "PSD-AL80": "HUAWEI nova Flip S",
  "PSN-AL00": "HUAWEI nova 15",
  "KLE-AL00U": "HUAWEI nova 15 Pro",
  "SLY-AL00": "HUAWEI nova 15 Ultra",
  "EMA-AL00U": "HUAWEI nova 16",
  "CRS-AL00": "HUAWEI nova 16 Pro",
  "HIP-AL00": "HUAWEI nova 16 Ultra",
  "PKN-AL00": "HUAWEI nova 16z",
  "CAS-AL50": "HUAWEI nova 16 SE",
  "HUAWEI VNS-CL00": "HUAWEI G9 青春版 电信版",
  "HUAWEI MLA-TL00": "HUAWEI G9 Plus 移动 4G 版",
  "HUAWEI MLA-TL10": "HUAWEI G9 Plus 移动版",
  "HUAWEI MLA-UL00": "HUAWEI G9 Plus 双 4G 版",
  "RNE-AL00": "HUAWEI 麦芒 6",
  "SNE-AL00": "HUAWEI 麦芒 7",
  "POT-AL00": "HUAWEI 麦芒 8",
  "POT-AL10": "HUAWEI 麦芒 8",
  "TNN-AN00": "华为麦芒 9 5G",
  "JUY-AL00": "华为畅享 80",
  "JUY-AL80": "华为畅享 90",
  "JUY-AL50": "华为畅享 90 Plus / 华为畅享 90m Plus",
  "CHZ-AL00": "华为畅享 90 Pro Max",
  "GEM-W10": "HUAWEI MatePad Pro Max 13.2 英寸 Wi-Fi 版 (20GB+1TB)",
  "GEM-W40": "HUAWEI MatePad Pro Max 13.2 英寸 悦享款 Wi-Fi 版",
  "DAL-W00": "HUAWEI MatePad Pro 12 英寸 Wi-Fi 版",
  "DAL-W20": "HUAWEI MatePad Pro 12 英寸 悦享款 Wi-Fi 版",
  "QXS-W00": "HUAWEI MatePad Edge",
  "QXS-W10": "HUAWEI MatePad Edge (24GB+1TB)",
  "QXS-W20": "HUAWEI MatePad Edge 液冷版",
  "BKY-W20": "HUAWEI MatePad Air 12 英寸 Wi-Fi 柔光版",
  "BKY-W21": "HUAWEI MatePad Air 12 英寸 Wi-Fi 柔光版",
  "LRT-W00": "HUAWEI MatePad Air 12 英寸 2025 Wi-Fi 版 (8GB+256GB)",
  "LRT-W20": "HUAWEI MatePad Air 12 英寸 2025 Wi-Fi 版",
  "LRT-W30": "HUAWEI MatePad Air 12 英寸 2025 Wi-Fi 柔光版",
  "TXZ-W20": "HUAWEI MatePad 11.5 英寸 2026 Wi-Fi 柔光版",
  "TXZ-AL10": "HUAWEI MatePad 11.5 英寸 2026 SIM 卡版",
  "MLR-AL00": "HUAWEI MatePad Mini 悦读版 8.8 英寸",
  "MLR-AL10": "HUAWEI MatePad Mini 8.8 英寸",
  "FLC-AN00": "荣耀 Magic Vs3",
  "PTP-AN00": "荣耀 Magic7",
  "PTP-AN60": "荣耀 Magic7 (16GB+1TB)",
  "PTP-AN10": "荣耀 Magic7 Pro",
  "PTP-AN70": "荣耀 Magic7 Pro 卫星通信版",
  "PTP-AN20": "荣耀 Magic7 RSR 保时捷设计",
  "MBH-AN10": "荣耀 Magic V5",
  "CLE-AN00": "荣耀 Magic V Flip2",
  "BKQ-AN00": "荣耀 Magic8",
  "BKQ-AN80": "荣耀 Magic8 (16GB+1TB)",
  "BKQ-AN10": "荣耀 Magic8 Pro",
  "BKQ-AN90": "荣耀 Magic8 Pro (16GB+1TB)",
  "LDY-AN00": "荣耀 Magic8 Pro Air",
  "BKQ-AN20": "荣耀 Magic8 RSR 保时捷设计",
  "PNM-AN10": "荣耀 Magic V6",
  "PNM-AN20": "荣耀 Magic V6 (16GB+1TB)",
  "APH-AN00": "荣耀 Robot Phone",
  "REP-AN00": "荣耀 90 Pro",
  "MAG-AN00": "荣耀 90 GT",
  "MAA-AN00": "荣耀 100",
  "MAA-AN10": "荣耀 100 Pro",
  "ELI-AN00": "荣耀 200",
  "ELP-AN00": "荣耀 200 Pro",
  "AMM-AN00": "荣耀 300",
  "AMP-AN00": "荣耀 300 Pro",
  "AMP-AN10": "荣耀 300 Ultra",
  "DNN-AN00": "荣耀 400",
  "DNP-AN00": "荣耀 400 Pro",
  "MEY-AN00": "荣耀 500",
  "MEP-AN00": "荣耀 500 Pro",
  "VKJ-AN00": "荣耀 600 超级版",
  "VKJ-AN90": "荣耀 600 元气版",
  "VKI-AN00": "荣耀 600 Pro",
  "KNT-AL10": "荣耀 V8 全网通版",
  "KNT-AL20": "荣耀 V8 全网通版 (麒麟 955, 2K 显示屏)",
  "KNT-TL10": "荣耀 V8 移动版",
  "KNT-UL10": "荣耀 V8 移动/联通版",
  "DUK-AL20": "荣耀 V9 全网通版",
  "BKL-AL00": "荣耀 V10 全网通标配版",
  "BKL-AL10": "荣耀 V10 全网通高配版",
  "BKL-AL20": "荣耀 V10 全网通尊享版",
  "BKL-TL10": "荣耀 V10 移动 4G+ 版",
  "PCT-AL10": "荣耀 V20 全网通版",
  "PCT-TL10": "荣耀 V20 移动 4G+ 版",
  "OXF-AN00": "荣耀 V30 5G",
  "OXF-AN10": "荣耀 V30 PRO 5G",
  "YOK-AN10": "荣耀 V40 5G",
  "ALA-AN70": "荣耀 V40 轻奢版 5G",
  "VCA-AN00": "荣耀 V Purse",
  "AMG-AN00": "荣耀 GT",
  "PPG-AN00": "荣耀 GT Pro",
  "AAP-AN00": "荣耀 WIN",
  "AAK-AN00": "荣耀 WIN RT",
  "SER-AN00": "荣耀 WIN Turbo",
  "ADT-AN00": "荣耀 X40 GT / 荣耀 X40 GT 竞速版",
  "ALI-AN00": "荣耀 X50",
  "ALP-AN00": "荣耀 X50 Pro / 荣耀 X50 GT",
  "CRT-AN00": "荣耀 X50i",
  "LLY-AN00": "荣耀 X50i+",
  "BRC-AN00": "荣耀 X60",
  "BRP-AN00": "荣耀 X60 Pro",
  "BRP-AN80": "荣耀 X60 Pro 卫星版",
  "LYN-AN00": "荣耀 X60i",
  "AGI-AN00": "荣耀 X60 GT",
  "MTN-AN00": "荣耀 X70",
  "MTN-AN80": "荣耀 X70 (12GB+512GB)",
  "ABR-AN00": "荣耀 X70i",
  "BSN-AN00": "荣耀 X80 Pro Max",
  "LNA-AN00": "荣耀 X80i",
  "NIC-AN00": "荣耀 Play10C 5G",
  "NLA-AN00": "荣耀 Play10A 5G / 荣耀 Play11C 5G",
  "LAB-AN00": "荣耀 Play11T 5G",
  "DVD-AN00": "荣耀 Power",
  "DVD-AN80": "荣耀 Power 卫星版",
  "EDI-AL10": "荣耀 Note8 全网通版",
  "EDI-DL00": "荣耀 Note8 移动/联通版",
  "RVL-AL09": "荣耀 Note10",
  "LOG-AN00": "荣耀畅玩 70 Plus 5G / 荣耀畅玩 70m Plus 5G",
  "NLA-AL00": "荣耀畅玩 70C",
  "LOG-AN10": "荣耀畅玩 80 Pro 5G",
  "HYM-W56": "荣耀 MagicBook 16 2021 R5",
  "HYM-W76": "荣耀 MagicBook 16 2021 R7",
  "JGC-N": "荣耀 MagicBook 16 2026",
  "DRA-54": "荣耀 MagicBook Pro 16 Ultra 5 (24GB 内存)",
  "DRA-72": "荣耀 MagicBook Pro 16 Ultra 7 (32GB 内存)",
  "DRB-P": "荣耀 MagicBook Pro 16 2025",
  "XWC-P": "荣耀 MagicBook 16 2026",
  "MRA-521": "荣耀 MagicBook Art 14 Ultra 5 (32GB+1TB)",
  "MRA-721": "荣耀 MagicBook Art 14 Ultra 7 (32GB+1TB)",
  "MRO-521": "荣耀 MagicBook Art 14 骁龙 X Elite (32GB+1TB)",
  "MRB-A": "荣耀 MagicBook Art 14 2025",
  "FRR-WFG9": "荣耀猎人游戏本 V700 i5 (16GB+512GB) (荣耀终端)",
  "FRR-WFD9": "荣耀猎人游戏本 V700 i7 (16GB+512GB) (荣耀终端)",
  "NWB-G": "荣耀 WIN 游戏本 H7",
  "NWC2-G": "荣耀 WIN 游戏本 H9",
  "PHZ110": "OPPO Find X7",
  "PHY110": "OPPO Find X7 Ultra",
  "PHY120": "OPPO Find X7 Ultra 卫星通信版",
  "PKB110": "OPPO Find X8",
  "PKC110": "OPPO Find X8 Pro",
  "PKC130": "OPPO Find X8 Pro 卫星通信版",
  "PKT110": "OPPO Find X8s",
  "PLB110": "OPPO Find X8s+",
  "PKJ110": "OPPO Find X8 Ultra",
  "PKU110": "OPPO Find X8 Ultra 卫星通信版",
  "PLJ110": "OPPO Find X9",
  "PLG110": "OPPO Find X9 Pro",
  "PLG120": "OPPO Find X9 Pro 卫星通信版",
  "PME110": "OPPO Find X9s Pro",
  "PMA110": "OPPO Find X9 Ultra",
  "PMA120": "OPPO Find X9 Ultra 卫星通信版",
  "PEUM00": "OPPO Find N",
  "PGU110": "OPPO Find N2",
  "PGT110": "OPPO Find N2 Flip",
  "PHN110": "OPPO Find N3 / OPPO Find N3 典藏版",
  "PHT110": "OPPO Find N3 Flip",
  "PKH110": "OPPO Find N5",
  "PKH120": "OPPO Find N5 卫星通信版",
  "PLP110": "OPPO Find N6",
  "PLP120": "OPPO Find N6 卫星通信版",
  "PHW110": "OPPO Reno10",
  "PHV110": "OPPO Reno10 Pro",
  "PHU110": "OPPO Reno10 Pro+",
  "PJH110": "OPPO Reno11",
  "PJJ110": "OPPO Reno11 Pro",
  "PJV110": "OPPO Reno12",
  "PJW110": "OPPO Reno12 Pro",
  "PKM110": "OPPO Reno13",
  "PKK110": "OPPO Reno13 Pro",
  "PLA110": "OPPO Reno14",
  "PKZ110": "OPPO Reno14 Pro",
  "PLW110": "OPPO Reno15",
  "PLV110": "OPPO Reno15 Pro",
  "PMD110": "OPPO Reno15c",
  "PMM110": "OPPO Reno16",
  "PMK110": "OPPO Reno16 Pro",
  "PCLM10": "OPPO Reno Ace",
  "PDHM00": "OPPO Ace2",
  "PBEM00": "OPPO R17 全网通版",
  "PBET00": "OPPO R17 移动版",
  "PBDM00": "OPPO R17 Pro 全网通版",
  "PBDT00": "OPPO R17 Pro 移动版",
  "PLT130": "OPPO A6v",
  "PLT140": "OPPO A6x / OPPO A6m",
  "PMC110": "OPPO A6c",
  "PYC110": "OPPO A7 Pro Max",
  "PLE110": "OPPO K13 Turbo Pro",
  "PYD110": "OPPO K15",
  "PMH110": "OPPO K15 Pro",
  "PMG110": "OPPO K15 Pro+",
  "V1821A": "vivo NEX 双屏版 全网通版",
  "V1821T": "vivo NEX 双屏版 移动全网通版",
  "V1923A": "vivo NEX 3 全网通版",
  "V1923T": "vivo NEX 3 移动全网通版",
  "V1924A": "vivo NEX 3 5G 全网通版",
  "V1924T": "vivo NEX 3 5G 移动全网通版",
  "V1950A": "vivo NEX 3S 5G",
  "V2266A": "vivo X Fold2",
  "V2256A": "vivo X Flip",
  "V2309A": "vivo X100",
  "V2324A": "vivo X100 Pro",
  "V2303A": "vivo X Fold3",
  "V2337A": "vivo X Fold3 Pro",
  "V2359A": "vivo X100s",
  "V2324HA": "vivo X100s Pro",
  "V2366GA": "vivo X100 Ultra",
  "V2366HA": "vivo X100 Ultra 卫星通信版",
  "V2415A": "vivo X200",
  "V2405A": "vivo X200 Pro",
  "V2405DA": "vivo X200 Pro 卫星通信版",
  "V2419A": "vivo X200 Pro mini",
  "V2458A": "vivo X200s",
  "V2454A": "vivo X200 Ultra",
  "V2454DA": "vivo X200 Ultra 卫星通信版",
  "V2436A": "vivo X Fold5",
  "V2509A": "vivo X300",
  "V2502A": "vivo X300 Pro",
  "V2502DA": "vivo X300 Pro 卫星通信版",
  "V2548A": "vivo X300s",
  "V2547A": "vivo X300 Ultra",
  "V2547DA": "vivo X300 Ultra 卫星通信版",
  "V2612A": "vivo X300 E",
  "V2545A": "vivo X Fold6",
  "V2528A": "vivo S50 / vivo S50t / vivo S50t 元气版",
  "V2527A": "vivo S50 Pro mini",
  "V2571A": "vivo S60",
  "V2572A": "vivo S60 元气版",
  "V2516A": "vivo Y500 Pro",
  "V2531A": "vivo Y500i / vivo Y500s / vivo Y6 / vivo Y6a",
  "V2561A": "vivo Y600 Pro",
  "V2553A": "vivo Y600 Turbo",
  "V2115A": "vivo T1",
  "V2123A": "vivo T1x",
  "V2199GA": "vivo T2",
  "V2188A": "vivo T2x",
  "V1990A": "vivo Z5x 712 版",
  "V1941A": "vivo Z5i 全网通版",
  "V1941T": "vivo Z5i 移动全网通版",
  "V1963A": "vivo Z6 5G",
  "V1928A": "vivo U3x 全网通版",
  "V1928T": "vivo U3x 移动全网通版",
  "V1962BA": "vivo G1",
  "V2318A": "vivo G2",
  "V2443A": "vivo G3",
  "V1824BA": "iQOO (6GB+128GB)",
  "V1824A": "iQOO (8GB+128GB/8GB+256GB/12GB+128GB/12GB+256GB)",
  "V1922A": "iQOO Pro 全网通版",
  "V1922T": "iQOO Pro 移动全网通版",
  "V1916A": "iQOO Pro 5G 全网通版",
  "V1916T": "iQOO Pro 5G 移动全网通版",
  "V1955A": "iQOO 3",
  "V2024A": "iQOO 5",
  "V2025A": "iQOO 5 Pro",
  "V2049A": "iQOO 7",
  "V2136A": "iQOO 8",
  "V2141A": "iQOO 8 Pro",
  "V2171A": "iQOO 9",
  "V2172A": "iQOO 9 Pro",
  "V2217A": "iQOO 10",
  "V2218A": "iQOO 10 Pro",
  "V2243A": "iQOO 11",
  "V2254A": "iQOO 11 Pro",
  "V2304A": "iQOO 11S",
  "V2307A": "iQOO 12",
  "V2329A": "iQOO 12 Pro",
  "V2408A": "iQOO 13",
  "V2505A": "iQOO 15",
  "V2546A": "iQOO 15 Ultra",
  "V2564A": "iQOO 15T",
  "V1914T": "iQOO Neo 移动全网通版",
  "V1936A": "iQOO Neo 855 版 全网通版",
  "V1936T": "iQOO Neo 855 版 移动全网通版",
  "V1936AL": "iQOO Neo 855 竞速版 全网通版",
  "V1936TL": "iQOO Neo 855 竞速版 移动全网通版",
  "V1981A": "iQOO Neo3",
  "V2055A": "iQOO Neo5",
  "V2118A": "iQOO Neo5 活力版",
  "V2154A": "iQOO Neo5S",
  "V2157A": "iQOO Neo5 SE",
  "V2196A": "iQOO Neo6",
  "V2199A": "iQOO Neo6 SE",
  "V2231A": "iQOO Neo7",
  "V2232A": "iQOO Neo7 竞速版",
  "V2238A": "iQOO Neo7 SE",
  "V2301A": "iQOO Neo8",
  "V2302A": "iQOO Neo8 Pro",
  "V2338A": "iQOO Neo9",
  "V2339A": "iQOO Neo9 Pro",
  "V2339FA": "iQOO Neo9S Pro",
  "V2403A": "iQOO Neo9S Pro+",
  "V2425A": "iQOO Neo10",
  "V2426A": "iQOO Neo10 Pro",
  "V2463A": "iQOO Neo10 Pro+",
  "V2520A": "iQOO Neo11",
  "V2573A": "iQOO Neo11 至尊版",
  "V2551A": "iQOO Z11",
  "V2532A": "iQOO Z11x",
  "V2559UA": "iQOO Z11i",
  "V2603A": "iQOO Z11S",
  "V2143A": "iQOO U3x 标准版",
  "V2165A": "iQOO U5 5G",
  "V2180GA": "iQOO U5x",
  "V2197A": "iQOO U5e 5G",
  "KB2000": "一加 8T",
  "LE2100": "一加 9R",
  "LE2110": "一加 9",
  "LE2119": "一加 9 Verzion 版",
  "LE2120": "一加 9 Pro",
  "MT2110": "一加 9RT",
  "NE2210": "一加 10 Pro",
  "PGKM10": "一加 Ace",
  "PGZ110": "一加 Ace 竞速版",
  "PGP110": "一加 Ace Pro 国行版 / 原神限定版",
  "PHB110": "一加 11",
  "PHK110": "一加 Ace 2 国行版 / 原神定制礼盒",
  "PHP110": "一加 Ace 2V",
  "PJA110": "一加 Ace 2 Pro 国行版 / 原神派蒙主题礼盒",
  "PJD110": "一加 12",
  "PJE110": "一加 Ace 3 国行版 / 原神刻晴定制机",
  "PJF110": "一加 Ace 3V",
  "PJX110": "一加 Ace 3 Pro",
  "PJZ110": "一加 13",
  "PKG110": "一加 Ace 5",
  "PKR110": "一加 Ace 5 Pro",
  "PKX110": "一加 13T",
  "PLC110": "一加 Ace 5 至尊版",
  "PLF110": "一加 Ace 5 竞速版",
  "PLK110": "一加 15",
  "PLQ110": "一加 Ace 6",
  "PLR110": "一加 Ace 6T",
  "PLZ110": "一加 15T",
  "PMB110": "一加 Ace 6 至尊版",
  "PLU110": "一加 Turbo 6",
  "PLY110": "一加 Turbo 6V",
  "PYS110": "一加 Turbo 6X",
  "PYR110": "一加 Turbo 6X Pro",
  "BE2025": "一加 Nord N10 Metro 版",
  "BE2015": "一加 Nord N100 Metro 版",
  "GN2200": "一加 Nord N20",
  "CPH2459": "一加 Nord N20",
  "CPH2469": "一加 Nord N20 SE",
  "CPH2389": "一加 Nord N300",
  "CPH2551": "一加 Open",
  "RMX1901": "真我 X",
  "RMX1851": "真我 X 青春版",
  "RMX1991": "真我 X2",
  "RMX1931": "真我 X2 Pro",
  "RMX2051": "真我 X50 5G 全网通版",
  "RMX2025": "真我 X50 5G 移动版",
  "RMX2071": "真我 X50 Pro 5G",
  "RMX2072": "真我 X50 Pro 玩家版",
  "RMX2141": "真我 X50m 5G",
  "RMX2052": "真我 X50t 5G 电信合作版",
  "RMX2176": "真我 X7 5G",
  "RMX2121": "真我 X7 Pro 5G",
  "RMX3115": "真我 X7 Pro 至尊版 5G 全网通版",
  "RMX2202": "真我 GT 5G",
  "RMX3361": "真我 GT 大师版",
  "RMX3366": "真我 GT 大师探索版",
  "RMX3310": "真我 GT2",
  "RMX3300": "真我 GT2 Pro",
  "RMX3551": "真我 GT2 大师探索版",
  "RMX3820": "真我 GT5",
  "RMX3823": "真我 GT5 240W",
  "RMX3888": "真我 GT5 Pro",
  "RMX3800": "真我 GT6",
  "RMX6688": "真我 GT7 / 真我 GT7 阿斯顿马丁 F1 限量版",
  "RMX5010": "真我 GT7 Pro",
  "RMX5090": "真我 GT7 Pro 竞速版",
  "RMX6699": "真我 GT8",
  "RMX5200": "真我 GT8 Pro / 真我 GT8 Pro 阿斯顿马丁 F1 限量版",
  "RMX3031": "真我 GT Neo 5G",
  "RMX3350": "真我 GT Neo 闪速版",
  "RMX3357": "真我 GT Neo2T",
  "RMX3560": "真我 GT Neo3",
  "RMX3562": "真我 GT Neo3 150W / 真我 GT Neo3 火影限定版",
  "RMX3706": "真我 GT Neo5",
  "RMX3708": "真我 GT Neo5 240W",
  "RMX3700": "真我 GT Neo5 SE",
  "RMX3852": "真我 GT Neo6 / 真我 GT Neo6 《完美世界》动画云曦限定礼盒",
  "RMX3850": "真我 GT Neo6 SE",
  "RMX5060": "真我 Neo7 / 真我 Neo7 《画江湖之不良人》限定礼盒",
  "RMX5062": "真我 Neo7 Turbo / 真我 Neo7 Turbo AI版",
  "RMX5080": "真我 Neo7 SE",
  "RMX5071": "真我 Neo7x",
  "RMX8899": "真我 Neo8",
  "RMX1971": "真我 Q",
  "RMX2117": "真我 Q2 5G",
  "RMX2173": "真我 Q2 Pro 5G",
  "RMX2200": "真我 Q2i 5G",
  "RMX3161": "真我 Q3 5G",
  "RMX2205": "真我 Q3 Pro 5G",
  "RMX3142": "真我 Q3 Pro 狂欢版",
  "RMX3042": "真我 Q3i 5G",
  "RMX3461": "真我 Q3s",
  "RMX3462": "真我 Q3t",
  "RMX3478": "真我 Q5",
  "RMX3372": "真我 Q5 Pro",
  "RMX3574": "真我 Q5i",
  "RMX3616": "真我 Q5x",
  "RMX3770": "真我 11 Pro",
  "RMX3740": "真我 11 Pro+",
  "RMX3992": "真我 12",
  "RMX3993": "真我 12x",
  "RMX3843": "真我 12 Pro / 真我 12 Pro 至尊版",
  "RMX3841": "真我 12 Pro+",
  "RMX3952": "真我 13",
  "RMX5002": "真我 13 Pro",
  "RMX3989": "真我 13 Pro 至尊版",
  "RMX3920": "真我 13 Pro+",
  "RMX5075": "真我 14",
  "RMX5055": "真我 14 Pro",
  "RMX5050": "真我 14 Pro+",
  "RMX5105": "真我 15",
  "RMX5100": "真我 15 Pro / 真我 15 Pro 《权力的游戏》限定版",
  "RMX5112": "真我 15T",
  "RMX3125": "真我 V11s 5G",
  "RMX3041": "真我 V13 5G 全网通版",
  "RMX3092": "真我 V15 5G 全网通版",
  "RMX3610": "真我 V20",
  "RMX3611": "真我 V20",
  "RMX3571": "真我 V23",
  "RMX3576": "真我 V23i",
  "RMX3475": "真我 V25",
  "RMX3619": "真我 V30",
  "RMX3618": "真我 V30t",
  "RMX3783": "真我 V50",
  "RMX3781": "真我 V50s",
  "RMX3995": "真我 V60",
  "RMX3996": "真我 V60s",
  "RMX3953": "真我 V60 Pro",
  "RMX3946": "真我 V70",
  "RMX3948": "真我 V70s",
  "SM-S9060": "Galaxy S22+",
  "SM-S9080": "Galaxy S22 Ultra",
  "SM-S9110": "Galaxy S23",
  "SM-S9160": "Galaxy S23+",
  "SM-S9180": "Galaxy S23 Ultra",
  "SM-S7110": "Galaxy S23 FE",
  "SM-S9210": "Galaxy S24",
  "SM-S9260": "Galaxy S24+",
  "SM-S9280": "Galaxy S24 Ultra",
  "SM-S9310": "Galaxy S25",
  "SM-S9360": "Galaxy S25+",
  "SM-S9370": "Galaxy S25 Edge",
  "SM-S9380": "Galaxy S25 Ultra",
  "SM-S9420": "Galaxy S26",
  "SM-S9470": "Galaxy S26+",
  "SM-S9480": "Galaxy S26 Ultra",
  "GT-I9220": "Galaxy Note 公开版",
  "GT-N7100": "Galaxy Note2 公开版",
  "SM-N9006": "Galaxy Note3 公开版",
  "SM-N9008S": "Galaxy Note3 4G 公开版",
  "SM-N9100": "Galaxy Note4 公开版",
  "SM-N9150": "Galaxy Note Edge",
  "SM-N9200": "Galaxy Note5 全网通版",
  "SM-N9300": "Galaxy Note7",
  "SM-N9500": "Galaxy Note8 全网通版",
  "SM-N9508": "Galaxy Note8 4G+",
  "SM-N9600": "Galaxy Note9 全网通版",
  "SM-N9608": "Galaxy Note9 4G+",
  "SM-N9700": "Galaxy Note10",
  "SM-N9760": "Galaxy Note10+ 5G",
  "SM-N9810": "Galaxy Note20 5G",
  "SM-N9860": "Galaxy Note20 Ultra 5G",
  "SM-F9360": "Galaxy Z Fold4",
  "SM-F9460": "Galaxy Z Fold5",
  "SM-F9560": "Galaxy Z Fold6",
  "SM-F9660": "Galaxy Z Fold7",
  "SM-F9680": "Galaxy Z TriFold",
  "SM-F9710": "Galaxy Z Fold8",
  "SM-F9760": "Galaxy Z Fold8 Ultra",
  "SM-F7000": "Galaxy Z Flip",
  "SM-F7070": "Galaxy Z Flip 5G",
  "SM-F7110": "Galaxy Z Flip3 5G",
  "SM-F7210": "Galaxy Z Flip4",
  "SM-F7310": "Galaxy Z Flip5",
  "SM-F7410": "Galaxy Z Flip6",
  "SM-F7660": "Galaxy Z Flip7",
  "SM-F7610": "Galaxy Z Flip7 FE",
  "SM-F7760": "Galaxy Z Flip8",
  "SM-A5460": "Galaxy A54 5G",
  "SM-A5560": "Galaxy A55 5G",
  "SM-A5660": "Galaxy A56 5G",
  "SM-A5760": "Galaxy A57 5G",
  "SM-E5260": "Galaxy F52 5G",
  "SM-M3070": "Galaxy M30s",
  "SM-C7108": "Galaxy C8 4G+",
  "SM-C9000": "Galaxy C9 Pro 全网通版",
  "SM-C9008": "Galaxy C9 Pro 4G+",
  "SM-C5560": "Galaxy C55 5G",
  "SM-J3110": "Galaxy J3 Pro 公开版",
  "SM-J3300": "Galaxy J3 (2017) 全网通版",
  "SM-J3308": "Galaxy J3 (2017) 4G+",
  "SM-G5700": "Galaxy On5 (2016) 全网通版",
  "SM-G5510": "Galaxy On5 (2016) 青春版 全网通版",
  "SM-G5520": "Galaxy On5 (2016) 时尚版 全网通版",
  "SM-G6100": "Galaxy On7 (2016)",
  "SM-W2014": "三星 W2014",
  "SM-W2015": "三星 W2015",
  "SM-W2016": "三星 W2016",
  "SM-W2017": "三星 W2017",
  "SM-W2018": "三星 W2018",
  "SM-W2019": "三星 W2019",
  "SM-W2020": "三星 W20 5G",
  "SM-W2021": "三星 W21 5G",
  "SM-W2022": "三星 W22 5G",
  "SM-W9023": "三星 W23",
  "SM-W7023": "三星 W23 Flip",
  "SM-W9024": "三星 W24",
  "SM-W7024": "三星 W24 Flip",
  "SM-W9025": "三星 W25",
  "SM-W7025": "三星 W25 Flip",
  "SM-W9026": "三星 W26",
  "SM-G1600": "Galaxy Folder",
  "SM-G1650": "Galaxy Folder 2",
  "SM-G8508S": "Galaxy Alpha",
  "SM-E7000": "Galaxy E7 公开版",
  "SM-X730": "Galaxy Tab S11 WLAN",
  "SM-X736C": "Galaxy Tab S11 5G",
  "SM-X930": "Galaxy Tab S11 Ultra WLAN",
  "SM-X936C": "Galaxy Tab S11 Ultra 5G",
  "SM-X210": "Galaxy Tab A9+ WLAN",
  "SM-X216C": "Galaxy Tab A9+ 5G",
  "SM-X230": "Galaxy Tab A11+ WLAN",
  "SM-X236C": "Galaxy Tab A11+ 5H",
  "SM-T320": "Galaxy Tab PRO 8.4 WLAN",
  "SM-T321": "Galaxy Tab PRO 8.4 3G",
  "SM-T520": "Galaxy Tab PRO 10.1 WLAN",
  "SM-W700": "Galaxy TabPro S WLAN",
  "M391Q": "魅族 20 PRO",
  "M392Q": "魅族 20 INFINITY 无界版",
  "M461Q": "魅族 21 公开版",
  "M481Q": "魅族 21 PRO",
  "M481S": "魅族 21 PRO Flyme 钛好用版",
  "M468Q": "魅族 21 Note 公开版",
  "M582Q": "魅族 22",
  "M582V": "魅族 22 (16GB+1TB)",
  "M431Q": "魅族 Lucky 08 公开版",
  "M852Q": "魅族 X8 公开版",
  "M813Q": "魅族 V8 高配版",
  "M816Q": "魅族 V8 标配版",
  "M822Q": "魅族 Note8 公开版",
  "M923Q": "魅族 Note9 公开版",
  "M521Q": "魅族 Note 16",
  "M531Q": "魅族 Note 16 Pro",
  "M57A": "魅蓝 metal 公开版",
  "M57AM": "魅蓝 metal 移动版",
  "M57AU": "魅蓝 metal 联通版",
  "M57AC": "魅蓝 metal 电信版"
};
  // ============================================================
  //  设备型号美化：把评论设备标签里的内部代号换成友好名称
  //  A 站会显示 RMX3619 / iPhone3,1 等代号，这里查表转换为"真我 V30"等
  //  内置表见 55-device-data.js（由 tools/gen-device-data.js 生成），
  //  用户可在面板导入 MobileModels 的 .md / Apple 表 .txt 扩充
  // ============================================================
  let deviceDB = {};
  let deviceSettings = { enabled: true, clickToToggle: true };

  const deviceIndexExact = new Map();   // 精确索引: code → name
  const deviceIndexUpper = new Map();   // 大写索引: CODE → name
  const deviceIndexBase = new Map();    // 去尾字母索引: V1821A → V1821
  const deviceIndexPrefix = new Map();  // 前缀索引: prefix → [{code, name}]
  const deviceSearchCache = new Map();  // 查找结果缓存（含未命中的 null）

  function loadDeviceDB() {
    deviceSettings = { ...deviceSettings, ...readStorage(CONFIG.DEVICE.settingsKey, {}) };
    const saved = readStorage(CONFIG.DEVICE.storageKey, null);
    deviceDB = (saved && typeof saved === 'object' && Object.keys(saved).length > 0)
      ? saved
      : { ...DEVICE_BUILTIN };
    buildDeviceIndexes();
    addLog('info', `📱 设备型号库: ${Object.keys(deviceDB).length} 条`);
  }

  function saveDeviceDB() {
    writeStorage(CONFIG.DEVICE.storageKey, deviceDB);
    writeStorage(CONFIG.DEVICE.metaKey, {
      count: Object.keys(deviceDB).length,
      lastUpdate: new Date().toISOString(),
    });
    buildDeviceIndexes();
  }

  function buildDeviceIndexes() {
    deviceIndexExact.clear();
    deviceIndexUpper.clear();
    deviceIndexBase.clear();
    deviceIndexPrefix.clear();
    deviceSearchCache.clear();

    for (const [code, name] of Object.entries(deviceDB)) {
      deviceIndexExact.set(code, name);
      const upper = code.toUpperCase();
      if (!deviceIndexUpper.has(upper)) deviceIndexUpper.set(upper, name);
      // 去掉末尾单个字母：V1821A → V1821（覆盖 A/B 区分的市场变体）
      const base = code.replace(/[A-Za-z]$/, '');
      if (base.length >= 3 && base !== code && !deviceIndexBase.has(base)) {
        deviceIndexBase.set(base, name);
        const baseUpper = base.toUpperCase();
        if (!deviceIndexBase.has(baseUpper)) deviceIndexBase.set(baseUpper, name);
      }
      for (let len = 4; len <= Math.min(6, code.length); len++) {
        const prefix = code.substring(0, len).toUpperCase();
        if (!deviceIndexPrefix.has(prefix)) deviceIndexPrefix.set(prefix, []);
        deviceIndexPrefix.get(prefix).push({ code, name });
      }
    }
  }

  function cacheDeviceResult(code, result) {
    if (deviceSearchCache.size >= CONFIG.DEVICE.cacheMaxSize) {
      // 淘汰最早写入的 20%，避免每次全量清理
      const drop = Math.floor(CONFIG.DEVICE.cacheMaxSize * 0.2);
      const keys = deviceSearchCache.keys();
      for (let i = 0; i < drop; i++) deviceSearchCache.delete(keys.next().value);
    }
    deviceSearchCache.set(code, result);
  }

  // 四级匹配：精确 → 大小写不敏感 → 去尾字母 → 前缀包含
  function findFriendlyName(code) {
    if (!code || code.length < 3) return null;
    if (deviceSearchCache.has(code)) return deviceSearchCache.get(code);

    let result = deviceIndexExact.get(code);
    if (!result) result = deviceIndexUpper.get(code.toUpperCase());
    if (!result) {
      const base = code.replace(/[A-Za-z]$/, '');
      if (base.length >= 3 && base !== code) {
        result = deviceIndexBase.get(base) || deviceIndexBase.get(base.toUpperCase());
      }
    }
    if (!result) {
      for (let len = Math.min(6, code.length); len >= 4 && !result; len--) {
        const candidates = deviceIndexPrefix.get(code.substring(0, len).toUpperCase());
        if (!candidates) continue;
        for (const { code: k, name: v } of candidates) {
          if (k.includes(code) || code.includes(k)) { result = v; break; }
        }
      }
    }
    cacheDeviceResult(code, result || null);
    return result || null;
  }

  // 解析导入文本，支持三种格式：
  // ① MobileModels: `RMX3700`: 真我 GT Neo5 SE（可一行多个代码）
  // ② Apple gist:   iPhone3,1 : iPhone 4
  // ③ Apple 无冒号:  iPhone3,1 iPhone 4（仅 Apple 前缀行）
  function parseDeviceModelsText(text) {
    const models = {};
    for (const raw of String(text).split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) continue;

      let m = line.match(/^((?:`[^`]+`\s*)+):\s*(.+?)\s*$/);
      if (m) {
        const name = m[2].trim();
        for (const code of [...m[1].matchAll(/`([^`]+)`/g)].map(x => x[1])) {
          if (code && name) models[code] = name;
        }
        continue;
      }

      m = line.match(/^([A-Za-z0-9_,.\-]+(?:\s+[A-Za-z0-9_,.\-]+)*)\s*:\s*(.+?)\s*$/);
      if (m) {
        const code = m[1].trim();
        const name = m[2].trim();
        if (code && name && code.length >= 2) models[code] = name;
        continue;
      }

      if (/^(iPhone|iPad|iPod|Watch|Mac|Apple)[\d,]/i.test(line)) {
        const spaceIdx = line.indexOf(' ');
        if (spaceIdx > 0) {
          const code = line.substring(0, spaceIdx).trim();
          const name = line.substring(spaceIdx + 1).trim();
          if (code && name) models[code] = name;
        }
      }
    }
    return models;
  }

  // 导入合并。skipExisting=true 时已存在的代号不覆盖
  function importDeviceModels(entries, skipExisting) {
    let added = 0;
    let skipped = 0;
    for (const [code, name] of Object.entries(entries)) {
      if (!code || !name || !isSafeKey(code)) continue;
      if (deviceDB[code] && skipExisting) { skipped++; continue; }
      deviceDB[code] = name;
      added++;
    }
    if (added) saveDeviceDB();
    return { added, skipped };
  }

  function exportDeviceDB() {
    GM_setClipboard?.(JSON.stringify(deviceDB, null, 2), 'text');
    showToast(`已复制 ${Object.keys(deviceDB).length} 条设备型号数据`);
  }

  // 重置为内置表（导入的数据清掉，避免误操作不可恢复）
  function resetDeviceDB(btn) {
    if (btn.dataset.acrConfirming) {
      delete btn.dataset.acrConfirming;
      deviceDB = { ...DEVICE_BUILTIN };
      saveDeviceDB();
      btn.textContent = '重置';
      processDeviceModels();
      showToast(`已重置为内置数据（${Object.keys(deviceDB).length} 条）`);
      return;
    }
    btn.dataset.acrConfirming = '1';
    btn.textContent = '确认重置?';
    setTimeout(() => { delete btn.dataset.acrConfirming; if (btn.isConnected) btn.textContent = '重置'; }, 3000);
  }

  // ============================================================
  //  DOM 处理：替换 .deviceModel 文本，点击可切换回原始显示
  //  A 站可能原地重渲染（元素保留、文本被重置回代号），所以不能只靠
  //  "处理过就跳过"：文本不再等于替换后的名称时需要重新替换；
  //  用户手动点击切换的（manual 标记）尊重其选择不再动
  // ============================================================
  function handleDeviceToggleClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const showingFriendly = el.textContent === (el.dataset.friendly || '');
    el.textContent = showingFriendly ? (el.dataset.original || '') : (el.dataset.friendly || '');
    el.setAttribute(CONFIG.DEVICE.manualAttr, '1');
    el.title = showingFriendly
      ? `原始型号: ${el.dataset.original || ''}\n点击可切换显示`
      : `${el.dataset.friendly || ''}\n点击可切换显示`;
  }

  function processDeviceModels() {
    if (!deviceSettings.enabled) return;
    const elements = document.querySelectorAll(CONFIG.DEVICE.selector);
    if (!elements.length) return;

    let replaced = 0;
    for (const el of elements) {
      if (el.hasAttribute(CONFIG.DEVICE.manualAttr)) continue;
      const text = (el.textContent || '').trim();
      if (!text) continue;
      if (el.dataset.friendly && text === el.dataset.friendly) continue;
      // 设备标签形如 "realme RMX3619"，取最后一段作为代号
      const code = text.split(/\s+/).pop();
      const friendly = findFriendlyName(code);
      if (!friendly) continue;

      el.setAttribute(CONFIG.DEVICE.processedAttr, '1');
      el.dataset.original = text;
      el.dataset.friendly = friendly;
      el.title = `原始型号: ${text}\n点击可切换显示`;
      el.textContent = friendly;
      el.style.cursor = 'pointer';
      if (deviceSettings.clickToToggle && !el._acrDeviceBound) {
        el._acrDeviceBound = true;
        el.addEventListener('click', handleDeviceToggleClick);
      }
      replaced++;
      addLog('debug', `📱 ${text} → ${friendly}`);
    }
    if (replaced) addLog('debug', `📱 设备型号替换 ${replaced} 个`);
  }

  // 清除替换与手动切换标记，全部按当前文本重新匹配
  function forceReprocessDevices() {
    document.querySelectorAll(`[${CONFIG.DEVICE.processedAttr}], [${CONFIG.DEVICE.manualAttr}]`).forEach(el => {
      el.removeAttribute(CONFIG.DEVICE.processedAttr);
      el.removeAttribute(CONFIG.DEVICE.manualAttr);
      delete el.dataset.friendly;
      delete el.dataset.original;
    });
    deviceSearchCache.clear();
    processDeviceModels();
    showToast('设备型号已重新处理');
  }

  // ============================================================
  //  面板：设备型号区块（开关 + 数据管理 + 导入视图）
  // ============================================================
  function buildDeviceRows(body) {
    const row = document.createElement('div');
    row.className = 'acr-row';
    const label = document.createElement('span');
    label.textContent = '设备型号美化';
    const toggle = document.createElement('span');
    toggle.className = 'acr-switch' + (deviceSettings.enabled ? ' on' : '');
    toggle.addEventListener('click', () => {
      deviceSettings.enabled = !deviceSettings.enabled;
      writeStorage(CONFIG.DEVICE.settingsKey, deviceSettings);
      toggle.classList.toggle('on', deviceSettings.enabled);
      showToast(deviceSettings.enabled ? '设备型号美化已开启' : '设备型号美化已关闭');
      if (deviceSettings.enabled) processDeviceModels();
    });
    row.append(label, toggle);
    body.appendChild(row);

    const dataRow = document.createElement('div');
    dataRow.className = 'acr-row';
    const dataLabel = document.createElement('span');
    dataLabel.textContent = `设备数据 ${Object.keys(deviceDB).length} 条`;
    const dataActions = document.createElement('span');
    dataActions.className = 'acr-actions';
    dataActions.append(
      mkPanelBtn('导入', openDeviceImport),
      mkPanelBtn('导出', exportDeviceDB),
      mkPanelBtn('重置', function () { resetDeviceDB(this); }, 'acr-danger'),
    );
    dataRow.append(dataLabel, dataActions);
    body.appendChild(dataRow);
  }

  // 与 IP 缓存导入同一套交互：临时替换面板内容，完成后重建面板
  function openDeviceImport() {
    const panel = document.querySelector('.acr-panel');
    if (!panel) return;
    const body = panel.querySelector('.acr-panel-body');
    body.innerHTML = `
      <div style="margin:8px 0 4px">
        <div style="font-size:13px;color:#333;margin-bottom:6px">选择文件（.md / .txt，可多选）或粘贴文本：</div>
        <input type="file" accept=".md,.txt" multiple class="acr-device-file"
          style="width:100%;padding:6px;border:1px dashed #e5e5e5;border-radius:3px;font-size:12px;box-sizing:border-box">
        <textarea class="acr-device-input" rows="5" placeholder='支持格式：
① \`RMX3700\`: 真我 GT Neo5 SE
② iPhone3,1 : iPhone 4'
          style="width:100%;margin-top:6px;resize:vertical;border:1px solid #e5e5e5;border-radius:3px;padding:6px;font:12px/1.4 monospace;color:#333;box-sizing:border-box"></textarea>
        <label style="display:flex;align-items:center;gap:6px;margin-top:6px;cursor:pointer">
          <input type="checkbox" class="acr-device-skip" checked>
          <span style="font-size:12px">跳过已存在的型号（不覆盖）</span>
        </label>
      </div>
      <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:8px">
        <button class="acr-device-cancel" style="border:1px solid #999;background:#f4f4f4;color:#666;font-size:12px;padding:3px 12px;border-radius:3px;cursor:pointer">取消</button>
        <button class="acr-device-confirm" style="border:none;background:#fd4c5d;color:#fff;font-size:12px;padding:3px 12px;border-radius:3px;cursor:pointer">导入</button>
      </div>`;

    body.querySelector('.acr-device-cancel').addEventListener('click', () => openPanel());
    body.querySelector('.acr-device-confirm').addEventListener('click', async () => {
      const entries = {};
      for (const file of body.querySelector('.acr-device-file').files) {
        try {
          Object.assign(entries, parseDeviceModelsText(await file.text()));
        } catch (e) {
          addLog('warn', `读取文件失败: ${file.name}`, e.message);
        }
      }
      const pasted = body.querySelector('.acr-device-input').value.trim();
      if (pasted) Object.assign(entries, parseDeviceModelsText(pasted));

      const total = Object.keys(entries).length;
      if (!total) { showToast('❌ 未解析出有效数据，请检查文件格式'); return; }

      const skip = body.querySelector('.acr-device-skip').checked;
      const { added, skipped } = importDeviceModels(entries, skip);
      addLog('info', `📱 设备数据导入: 新增 ${added}，跳过 ${skipped}`);
      showToast(`导入 ${added} 条，跳过 ${skipped} 条，共 ${Object.keys(deviceDB).length} 条`);
      processDeviceModels();
      openPanel();
    });
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
      if (timeEl.parentNode.querySelector('.acr-ip')) continue;
      if (processedFeedItems.has(timeEl)) continue;

      const wrap = timeEl.closest(CONFIG.SELECTORS.feedUpInfo)?.closest(CONFIG.SELECTORS.feedUp);
      const uid = parseUidFromHref(wrap?.querySelector(CONFIG.SELECTORS.upLink)?.href);
      // uid 尚未渲染出来时不标记，留待下次 DOM 变化重试
      if (!uid) continue;
      processedFeedItems.add(timeEl);

      getIp(uid).then(ip => {
        if (!ip || timeEl.parentNode.querySelector('.acr-ip')) return;
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
    processDeviceModels();
    observeComments();
    if (location.pathname.includes('/member')) injectUpIp();
    if (/\/u\/\d+/.test(location.pathname)) injectProfileIp();
  }

  let lastUrl = '';
  let lastPath = '';

  function checkUrl() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    // 路径没变（同页面 replaceState 改写查询参数）不算换页，映射保留；
    // 路径变了才清空，旧页面的映射对新页面无效且会无限累积
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      commentUserMap.clear();
      fieldLayoutLogged = false;
    }
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
    toggle.title = '关闭缓存会同时清空已有的缓存数据';
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

    // —— 设备型号美化：开关 + 数据管理（56-device.js）
    buildDeviceRows(body);

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
    showToast(enabled ? '缓存已开启' : '缓存已关闭，已清空全部缓存');
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
        if (isSafeKey(key) && entry?.d && !cache[key]) { cache[key] = entry; pageCount++; }
      }
      let uidCount = 0;
      if (bundled) {
        for (const [uid, entry] of Object.entries(data.uids || {})) {
          if (isSafeKey(uid) && entry && !uids[uid]) { uids[uid] = entry; uidCount++; }
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
  loadDeviceDB();
  processDeviceModels();

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
    findFriendlyName,
    parseDeviceModelsText,
    processDeviceModels,
    importDeviceModels,
    // 内部状态（只读调试用）
    getState: () => ({
      enabled,
      days,
      pageId,
      cachePages: Object.keys(cache).length,
      pageDataSize: Object.keys(pageData).length,
      uidCacheSize: Object.keys(uids).length,
      deviceEnabled: deviceSettings.enabled,
      deviceModels: Object.keys(deviceDB).length,
    }),
    getLogs: () => logs.slice(),
  };

  log(`🚀 AcFunReveal v${VERSION} | ${pageId || '无缓存'} | ${enabled ? describeDays() : '关闭'} | ${Object.keys(pageData).length}条 | 设备库 ${Object.keys(deviceDB).length} 条${deviceSettings.enabled ? '' : ' (美化关闭)'}`);
})();
