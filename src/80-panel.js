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
