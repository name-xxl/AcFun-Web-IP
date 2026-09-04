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
    const elements = document.querySelectorAll(CONFIG.SELECTORS.commentRoot);
    let newlyObserved = 0;
    for (const el of elements) {
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
    if (newlyObserved) addLog('info', `👁️ 新增观察: ${newlyObserved} 个`);
  }

  function isSkippableComment(el) {
    return el.classList.contains(CONFIG.SELECTORS.commentSkipSelf.slice(1))
      || !!el.closest(CONFIG.SELECTORS.commentSkipParent);
  }

  async function processVisibleComment(el) {
    if (el.querySelector('.acr-ip') || isSkippableComment(el)) return;

    const commentId = el.getAttribute('data-commentid');
    const uid = commentUserMap.get(commentId) || extractUidFromComment(el);
    if (!uid) {
      addLog('warn', `⚠️ 无法提取 userId (commentId: ${commentId})`);
      return;
    }

    const fresh = getFreshUidInfo(uid);
    if (fresh) {
      if (fresh.ip) {
        addLog('success', `📦 从缓存注入: ${uid} → ${fresh.ip}`);
        injectIntoComment(el, fresh.ip, { queriedAt: fresh.t, uid });
      }
      return;
    }

    addLog('info', `🔍 处理评论: commentId=${commentId}, userId=${uid}`);
    const ip = await getIp(uid);
    if (ip) {
      addLog('success', `🎉 查询注入: ${uid} → ${ip}`);
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
