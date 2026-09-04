  // ============================================================
  //  常量与配置：API 端点、DOM 选择器、各类阈值统一收拢于此
  //  A 站改版时只需调整本区块
  // ============================================================
  const VERSION = '5.6.0';

  const CONFIG = {
    API: {
      userInfo: (uid) => `https://www.acfun.cn/rest/pc-direct/user/userInfo?userId=${uid}`,
    },
    COMMENT_URL_PATTERNS: ['/comment/list', '/comment/sublist', '/comment/subComment', '/comment/reply'],
    SELECTORS: {
      commentRoot: '[data-commentid]',
      commentFrom: '.area-comment-from',
      commentSkipSelf: '.area-sec-seemore',
      commentSkipParent: '.area-sec-more',
      userAttrLink: 'a[data-userid]',
      profileLink: 'a[href*="/u/"]',
      avatar: 'img.avatar',
      avatarUidPattern: /newUpload\/(\d+)_/,
      feedTime: '.feed-time',
      feedUpInfo: '.feed-up-info',
      feedUp: '.feed-up',
      upLink: 'a[href*="/u/"], a[href*="/live/"]',
      profileInfo: '#ac-space-info[data-uid]',
      profileTop: '.top',
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
