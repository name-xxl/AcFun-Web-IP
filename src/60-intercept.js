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
