  // ============================================================
  //  DOM 工具：UID 提取、IP 标签构造与注入
  // ============================================================
  function parseUidFromHref(href) {
    if (!href) return null;
    const match = href.match(/\/u\/(\d+)/) || href.match(/\/live\/(\d+)/);
    return match ? parseInt(match[1]) : null;
  }

  function extractUidFromComment(el) {
    const attrLink = el.querySelector(CONFIG.SELECTORS.userAttrLink);
    if (attrLink?.dataset.userid) return parseInt(attrLink.dataset.userid);

    const profileLink = el.querySelector(CONFIG.SELECTORS.profileLink);
    const uid = parseUidFromHref(profileLink?.href);
    if (uid) return uid;

    const avatar = el.querySelector(CONFIG.SELECTORS.avatar);
    const avatarMatch = avatar?.src.match(CONFIG.SELECTORS.avatarUidPattern);
    return avatarMatch ? parseInt(avatarMatch[1]) : null;
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
    const anchor = el.querySelector(CONFIG.SELECTORS.commentFrom);
    if (!anchor) {
      addLog('warn', `⚠️ 注入点缺失 (.area-comment-from): commentId=${el.getAttribute('data-commentid')}`);
      return;
    }
    anchor.appendChild(makeIpSpan(ip, { queriedAt, uid }));
    addLog('success', `🎉 ${ip}`);
  }

  // 节点被 A 站原地重渲染后不会再次进入 IntersectionObserver，从缓存直接补注入
  function injectFromCache(el) {
    const commentId = el.getAttribute('data-commentid');
    const uid = commentUserMap.get(commentId) || extractUidFromComment(el);
    if (!uid) return;
    const fresh = getFreshUidInfo(uid);
    if (fresh?.ip) injectIntoComment(el, fresh.ip, { queriedAt: fresh.t, uid });
  }
