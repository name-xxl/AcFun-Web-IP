  // ============================================================
  //  缓存操作（面板与菜单共用）
  // ============================================================
  function persistAndReload(alertMessage) {
    save();
    saveUids();
    if (alertMessage) alert(alertMessage);
    location.reload();
  }

  function setEnabled(next) {
    enabled = next;
    writeStorage(CONFIG.CACHE.enabledKey, enabled);
    if (!enabled) clearAllCache();
    persistAndReload(enabled ? '🟢 缓存已开启' : '🔴 缓存已关闭');
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
    alert('📋 日志已复制');
  }

  function copyPageCache() {
    const rows = Object.entries(pageData)
      .filter(([, data]) => data.ip)
      .map(([uid, data]) => ({ 用户ID: uid, 用户名: data.name, IP: data.ip }));
    console.table(rows);
    GM_setClipboard?.(JSON.stringify(rows, null, 2), 'text');
    alert(`📊 ${rows.length} 条已复制`);
  }

  function exportCache() {
    const payload = { version: VERSION, pages: cache, uids };
    GM_setClipboard?.(JSON.stringify(payload, null, 2), 'text');
    alert(`📦 已复制：${Object.keys(cache).length} 个页面，${Object.keys(uids).length} 条 uid 缓存`);
  }

  function importCache() {
    const input = prompt('粘贴缓存 JSON：');
    if (!input) return;
    let data;
    try {
      data = JSON.parse(input);
    } catch (e) {
      alert('❌ ' + e.message);
      return;
    }
    // 兼容两种格式：新版 { version, pages, uids } 打包，旧版纯页面缓存
    const bundled = data && typeof data === 'object' && (data.pages || data.uids);
    let pageCount = 0;
    for (const [key, entry] of Object.entries(bundled ? (data.pages || {}) : data)) {
      if (entry?.d && !cache[key]) {
        cache[key] = entry;
        pageCount++;
      }
    }
    let uidCount = 0;
    if (bundled) {
      for (const [uid, entry] of Object.entries(data.uids || {})) {
        if (entry && !uids[uid]) {
          uids[uid] = entry;
          uidCount++;
        }
      }
    }
    save();
    saveUids();
    loadPage();
    alert(`📥 导入 ${pageCount} 个页面，${uidCount} 条 uid 缓存`);
    location.reload();
  }

  function clearCacheWithConfirm() {
    if (!confirm('确定清空所有缓存？')) return;
    clearAllCache();
    alert('🗑️ 缓存已清空');
  }
