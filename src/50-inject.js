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
