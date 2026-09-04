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
