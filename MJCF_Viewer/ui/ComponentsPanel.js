// Body-tree Components panel for AutoMind MJCF Viewer.
// BUILD239:
// - The MJCF <body> hierarchy is the only primary structure.
// - Body rows are created immediately; OBJ/geom rows are lazy under a closed
//   Geometry folder, so the panel never creates every .obj card at startup.
// - Thumbnails are generated once per body in the background and never block UI.
// - Clicking a body selects/isolates it and expands its branch.
// - 3-D selection reveals the matching body and draws a teal selection bubble.

export function createComponentsPanel(app, theme) {
  if (!app || !app.assets || !app.isolate || !app.showAll) {
    throw new Error('[ComponentsPanel] Missing required app APIs');
  }

  const UI_SCALE = 0.5;
  const UI_SCALE_INV = 1 / UI_SCALE;
  const BUTTON_LEFT = 50;
  const BUTTON_BOTTOM = 14;
  const PANEL_BASE_WIDTH = 600;

  let open = false;
  let disposed = false;
  let treeBuilt = false;
  let preloadPromise = null;
  let thumbnailWarmupPromise = null;
  let thumbnailGeneration = 0;
  let currentClosedTx = -2400;
  let selectedRecord = null;

  const rowRecords = [];
  const bodyRows = new Map();
  const assetRows = new Map();
  const expandedBodies = new Set();

  const ui = {
    root: document.createElement('div'),
    btn: document.createElement('button'),
    panel: document.createElement('div'),
    header: document.createElement('div'),
    title: document.createElement('div'),
    showAllBtn: document.createElement('button'),
    status: document.createElement('div'),
    list: document.createElement('div'),
  };

  const host = app.renderer?.domElement?.parentElement || document.body;
  if (window.getComputedStyle(host).position === 'static') host.style.position = 'relative';

  Object.assign(ui.root.style, {
    position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '9999', overflow: 'hidden',
    fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif'
  });
  Object.assign(ui.btn.style, {
    position: 'absolute', left: `${BUTTON_LEFT}px`, bottom: `${BUTTON_BOTTOM}px`, padding: '8px 12px',
    borderRadius: '12px', border: `1px solid ${theme.stroke}`, background: theme.bgPanel,
    color: theme.text, fontWeight: '700', cursor: 'pointer', boxShadow: theme.shadow,
    pointerEvents: 'auto', transition: 'all .12s ease', transformOrigin: 'bottom left', scale: String(UI_SCALE)
  });
  Object.assign(ui.panel.style, {
    position: 'absolute', left: `${BUTTON_LEFT}px`, bottom: '60px', width: `${PANEL_BASE_WIDTH}px`,
    maxHeight: `calc(92vh * ${UI_SCALE_INV})`, background: theme.bgPanel,
    border: `1px solid ${theme.stroke}`, boxShadow: theme.shadow, borderRadius: '18px', overflow: 'hidden',
    display: 'block', pointerEvents: 'none', willChange: 'transform, opacity',
    transition: 'transform 260ms cubic-bezier(.2,.7,.2,1), opacity 200ms ease',
    transform: 'translateX(-2400px)', opacity: '0', transformOrigin: 'bottom left', scale: String(UI_SCALE)
  });
  Object.assign(ui.header.style, {
    display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: '10px', padding: '10px 12px',
    borderBottom: `1px solid ${theme.stroke}`, background: '#0ea5a6'
  });
  Object.assign(ui.title.style, { fontWeight: '800', color: '#fff', fontSize: '14px' });
  Object.assign(ui.showAllBtn.style, {
    padding: '6px 10px', borderRadius: '10px', border: `1px solid ${theme.stroke}`,
    background: theme.bgPanel, fontWeight: '700', cursor: 'pointer', fontSize: '11px'
  });
  Object.assign(ui.status.style, {
    display: 'none', padding: '7px 12px', fontSize: '11px', fontWeight: '700', color: theme.textMuted,
    borderBottom: `1px solid ${theme.stroke}`, background: '#f8fafc'
  });
  Object.assign(ui.list.style, {
    overflowY: 'auto', maxHeight: `calc((92vh - 48px) * ${UI_SCALE_INV})`, padding: '10px 10px 16px'
  });

  ui.title.textContent = 'Components';
  ui.showAllBtn.textContent = 'Show all';
  ui.btn.textContent = 'Components';
  ui.btn.disabled = false;

  const initial = document.createElement('div');
  initial.textContent = 'Model components will appear here.';
  Object.assign(initial.style, { padding: '18px 10px', color: theme.textMuted, fontWeight: '700', textAlign: 'center' });
  ui.list.appendChild(initial);

  ui.header.append(ui.title, ui.showAllBtn);
  ui.panel.append(ui.header, ui.status, ui.list);
  ui.root.append(ui.panel, ui.btn);
  host.appendChild(ui.root);

  function updateResponsiveLayout() {
    const rect = host.getBoundingClientRect();
    const panelVisualWidth = PANEL_BASE_WIDTH * UI_SCALE;
    currentClosedTx = -Math.max(panelVisualWidth + BUTTON_LEFT + 40, 320) * UI_SCALE_INV;
    if (!open) ui.panel.style.transform = `translateX(${currentClosedTx}px)`;
    const visualHeight = Math.max(rect.height || window.innerHeight || 1, 1);
    ui.panel.style.maxHeight = `${Math.max(260, visualHeight * 0.92) * UI_SCALE_INV}px`;
  }

  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateResponsiveLayout) : null;
  if (resizeObserver) resizeObserver.observe(host);
  else window.addEventListener('resize', updateResponsiveLayout);

  function set(isOpen) {
    open = !!isOpen;
    updateResponsiveLayout();
    ui.panel.style.opacity = open ? '1' : '0';
    ui.panel.style.transform = open ? 'translateX(0px)' : `translateX(${currentClosedTx}px)`;
    ui.panel.style.pointerEvents = open ? 'auto' : 'none';
    if (open && selectedRecord) revealRecord(selectedRecord, true);
  }

  function normalizeKey(value) {
    return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  }

  function mapRecord(map, key, record) {
    if (!key) return;
    for (const k of new Set([String(key), normalizeKey(key)])) {
      const arr = map.get(k) || [];
      arr.push(record);
      map.set(k, arr);
    }
  }

  function mapped(map, key) {
    if (!key) return [];
    return map.get(String(key)) || map.get(normalizeKey(key)) || [];
  }

  function placeholderDataUrl(label) {
    const safe = String(label || 'Body').slice(0, 24).replace(/[&<>"']/g, '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="108"><rect width="100%" height="100%" rx="16" fill="#f3f8f9"/><path d="M28 69l25-28 19 22 16-17 31 35H28z" fill="#cbd5e1"/><circle cx="92" cy="32" r="9" fill="#cbd5e1"/><text x="72" y="96" text-anchor="middle" font-family="Arial" font-size="10" fill="#64748b">${safe}</text></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  function clearSelectionBubble() {
    for (const record of rowRecords) {
      if (!record?.row) continue;
      record.row.style.outline = 'none';
      record.row.style.borderColor = theme.stroke;
      record.row.style.boxShadow = record.kind === 'body' ? '0 1px 4px rgba(15,23,42,.05)' : 'none';
      record.row.style.background = record.kind === 'asset' ? '#fff' : '#fff';
    }
    selectedRecord = null;
  }

  function applySelectionBubble(record) {
    clearSelectionBubble();
    if (!record?.row) return;
    selectedRecord = record;
    record.row.style.borderColor = '#0ea5a6';
    record.row.style.background = '#ecfeff';
    record.row.style.outline = '4px solid rgba(14,165,166,.23)';
    record.row.style.boxShadow = '0 8px 20px rgba(14,165,166,.20)';
  }

  function setBodyExpanded(record, expanded) {
    if (!record || record.kind !== 'body') return;
    record.expanded = !!expanded;
    if (record.expanded) expandedBodies.add(record.linkName);
    else expandedBodies.delete(record.linkName);
    if (record.childrenEl) record.childrenEl.style.display = record.expanded ? 'block' : 'none';
    if (record.chevron) record.chevron.textContent = record.expanded ? '▾' : '▸';
    record.row?.setAttribute?.('aria-expanded', String(record.expanded));
  }

  function revealRecord(record, scroll = false) {
    if (!record) return;
    for (const ancestor of record.ancestors || []) setBodyExpanded(ancestor, true);
    if (record.kind === 'body') setBodyExpanded(record, true);
    if (scroll && open) {
      requestAnimationFrame(() => {
        try { record.row?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); } catch (_) {}
      });
    }
  }

  function badge(text, background = '#e6fffb', color = '#0f766e') {
    const el = document.createElement('span');
    el.textContent = text;
    Object.assign(el.style, {
      display: 'inline-flex', alignItems: 'center', padding: '2px 7px', borderRadius: '999px',
      background, color, fontSize: '10px', fontWeight: '800', whiteSpace: 'nowrap'
    });
    return el;
  }

  function selectBodyRecord(record) {
    if (!record?.linkName) return;
    if (!record.expanded) setBodyExpanded(record, true);
    try { app.clearSelection?.(); app.interaction?.clearHover?.(); } catch (_) {}
    try { app.isolate.body?.(record.linkName); } catch (_) {}
    try { app.selectBody?.(record.linkName); } catch (_) {}
    applySelectionBubble(record);
    set(true);
  }

  function makeBodyRow(node, depth, ancestors, thumbnailJobs, expandByDefault = false) {
    const wrap = document.createElement('div');
    const row = document.createElement('div');
    const chevronButton = document.createElement('button');
    const thumb = document.createElement('img');
    const text = document.createElement('div');
    const title = document.createElement('div');
    const badges = document.createElement('div');
    const childrenEl = document.createElement('div');

    Object.assign(row.style, {
      display: 'grid', gridTemplateColumns: '24px 72px minmax(0,1fr)', alignItems: 'center', gap: '9px',
      minHeight: '66px', padding: `7px 9px 7px ${8 + depth * 14}px`, margin: '4px 0',
      border: `1px solid ${theme.stroke}`, borderRadius: '14px', cursor: 'pointer', color: theme.text,
      background: '#fff', transition: 'background .12s ease, border-color .12s ease, box-shadow .12s ease, transform .08s ease',
      boxShadow: '0 1px 4px rgba(15,23,42,.05)', userSelect: 'none'
    });
    Object.assign(chevronButton.style, {
      width: '22px', height: '32px', border: 'none', background: 'transparent', color: '#0f766e',
      fontSize: '17px', fontWeight: '900', cursor: 'pointer', padding: '0'
    });
    Object.assign(thumb.style, {
      width: '72px', height: '54px', objectFit: 'contain', borderRadius: '9px', border: `1px solid ${theme.stroke}`,
      background: theme.bgCanvas || '#f8fafc'
    });
    thumb.alt = node.name || node.linkName || 'Body';
    thumb.decoding = 'async';
    thumb.loading = 'eager';
    thumb.src = placeholderDataUrl(thumb.alt);
    title.textContent = node.name || node.linkName || 'Body';
    Object.assign(title.style, { fontWeight: '850', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
    Object.assign(badges.style, { display: 'flex', flexWrap: 'wrap', gap: '5px', marginTop: '5px' });

    const directGeometryCount = Array.isArray(node.assets) ? node.assets.length : 0;
    const directMeshCount = Number(node.directMeshCount || 0);
    const childCount = Array.isArray(node.children) ? node.children.length : 0;
    if (node.jointLabel) badges.appendChild(badge(node.jointLabel, '#eef2ff', '#4338ca'));
    if (directMeshCount || directGeometryCount) badges.appendChild(badge(`${directMeshCount || directGeometryCount} mesh${(directMeshCount || directGeometryCount) === 1 ? '' : 'es'}`));
    if (childCount) badges.appendChild(badge(`${childCount} child${childCount === 1 ? '' : 'ren'}`, '#f1f5f9', '#475569'));

    text.append(title, badges);
    row.append(chevronButton, thumb, text);
    wrap.append(row, childrenEl);

    const record = {
      kind: 'body', row, wrap, childrenEl, chevron: chevronButton,
      linkName: node.linkName || node.name || '', thumbnailKey: node.thumbnailKey || `__body__:${node.linkName || node.name || ''}`,
      ancestors: ancestors.slice(), expanded: false, node
    };
    rowRecords.push(record);
    mapRecord(bodyRows, record.linkName, record);

    const hasChildren = childCount > 0 || directGeometryCount > 0;
    chevronButton.textContent = hasChildren ? '▸' : '•';
    chevronButton.style.cursor = hasChildren ? 'pointer' : 'default';
    chevronButton.addEventListener('pointerdown', ev => ev.stopPropagation());
    chevronButton.addEventListener('click', ev => {
      ev.stopPropagation();
      if (hasChildren) setBodyExpanded(record, !record.expanded);
    });
    row.addEventListener('pointerdown', ev => ev.stopPropagation());
    row.addEventListener('click', ev => {
      ev.stopPropagation();
      selectBodyRecord(record);
    });
    row.addEventListener('mouseenter', () => {
      if (selectedRecord !== record) { row.style.background = theme.tealFaint || '#f0fdfa'; row.style.transform = 'translateY(-1px)'; }
    });
    row.addEventListener('mouseleave', () => {
      row.style.transform = 'none';
      if (selectedRecord !== record) row.style.background = '#fff';
    });

    setBodyExpanded(record, hasChildren && (expandByDefault || expandedBodies.has(record.linkName)));
    thumbnailJobs.push({ record, img: thumb, thumbnailKey: record.thumbnailKey, label: title.textContent });
    return record;
  }

  function makeAssetRow(ent, depth, ancestors) {
    const row = document.createElement('div');
    const icon = document.createElement('span');
    const label = document.createElement('span');
    const count = document.createElement('span');

    Object.assign(row.style, {
      display: 'grid', gridTemplateColumns: '22px minmax(0,1fr) auto', alignItems: 'center', gap: '7px',
      padding: `6px 8px 6px ${8 + depth * 14}px`, margin: '3px 0', border: `1px solid ${theme.stroke}`,
      borderRadius: '10px', background: '#fff', cursor: 'pointer', color: theme.text
    });
    icon.textContent = '◇';
    Object.assign(icon.style, { color: '#0f766e', fontWeight: '900', textAlign: 'center' });
    label.textContent = `${ent.base || ent.assetKey || 'Geometry'}${ent.ext ? '.' + ent.ext : ''}`;
    Object.assign(label.style, { fontSize: '11px', fontWeight: '750', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
    count.textContent = String(ent.count || 1);
    Object.assign(count.style, { fontSize: '10px', color: theme.textMuted, fontWeight: '800' });
    row.append(icon, label, count);

    const record = {
      kind: 'asset', row, assetKey: ent.assetKey || '', linkName: ent.linkName || '', ancestors: ancestors.slice(), ent
    };
    rowRecords.push(record);
    mapRecord(assetRows, record.assetKey, record);

    row.addEventListener('pointerdown', ev => ev.stopPropagation());
    row.addEventListener('click', ev => {
      ev.stopPropagation();
      try { app.clearSelection?.(); app.interaction?.clearHover?.(); } catch (_) {}
      try { app.isolate.asset?.(record.assetKey); } catch (_) {}
      try { app.selectAsset?.(record.assetKey, record.linkName); } catch (_) {}
      applySelectionBubble(record);
      set(true);
    });
    row.addEventListener('mouseenter', () => { if (selectedRecord !== record) row.style.background = theme.tealFaint || '#f0fdfa'; });
    row.addEventListener('mouseleave', () => { if (selectedRecord !== record) row.style.background = '#fff'; });
    return record;
  }

  function makeGeometryFolder(node, depth, bodyAncestors) {
    const assets = Array.isArray(node.assets) ? node.assets : [];
    if (!assets.length) return null;

    const wrap = document.createElement('div');
    const row = document.createElement('div');
    const chevron = document.createElement('span');
    const label = document.createElement('span');
    const count = document.createElement('span');
    const children = document.createElement('div');
    let populated = false;
    let expanded = false;

    Object.assign(row.style, {
      display: 'grid', gridTemplateColumns: '20px 1fr auto', alignItems: 'center', gap: '7px',
      minHeight: '31px', padding: `4px 8px 4px ${8 + depth * 14}px`, margin: '3px 0',
      borderRadius: '10px', cursor: 'pointer', color: '#475569', background: '#f8fafc', userSelect: 'none'
    });
    chevron.textContent = '▸';
    label.textContent = 'Geometry';
    Object.assign(label.style, { fontWeight: '800', fontSize: '11px' });
    count.textContent = String(assets.length);
    Object.assign(count.style, { fontWeight: '800', fontSize: '10px', color: theme.textMuted });
    children.style.display = 'none';
    row.append(chevron, label, count);
    wrap.append(row, children);

    function populate() {
      if (populated) return;
      populated = true;
      for (const ent of assets) {
        const assetRecord = makeAssetRow(ent, depth + 1, bodyAncestors);
        children.appendChild(assetRecord.row);
      }
    }
    row.addEventListener('pointerdown', ev => ev.stopPropagation());
    row.addEventListener('click', ev => {
      ev.stopPropagation();
      expanded = !expanded;
      if (expanded) populate();
      children.style.display = expanded ? 'block' : 'none';
      chevron.textContent = expanded ? '▾' : '▸';
    });
    return wrap;
  }

  function countTree(node, seen = new Set()) {
    if (!node || seen.has(node)) return { bodies: 0, assets: 0 };
    seen.add(node);
    let bodies = 1;
    let assets = Array.isArray(node.assets) ? node.assets.length : 0;
    for (const child of Array.isArray(node.children) ? node.children : []) {
      const c = countTree(child, seen);
      bodies += c.bodies;
      assets += c.assets;
    }
    return { bodies, assets };
  }

  function renderTree(tree) {
    ui.list.replaceChildren();
    rowRecords.length = 0;
    bodyRows.clear();
    assetRows.clear();
    const thumbnailJobs = [];
    const renderedNodes = new Set();

    function appendNode(node, parentEl, depth, ancestors, isTopLevel = false) {
      if (!node || renderedNodes.has(node)) return;
      renderedNodes.add(node);
      const record = makeBodyRow(node, depth, ancestors, thumbnailJobs, isTopLevel);
      parentEl.appendChild(record.wrap);
      const nextAncestors = ancestors.concat(record);

      const geometry = makeGeometryFolder(node, depth + 1, nextAncestors);
      if (geometry) record.childrenEl.appendChild(geometry);
      for (const child of Array.isArray(node.children) ? node.children : []) {
        appendNode(child, record.childrenEl, depth + 1, nextAncestors, false);
      }
    }

    const roots = Array.isArray(tree?.children) ? tree.children : [];
    if (!roots.length) {
      const empty = document.createElement('div');
      empty.textContent = 'No MJCF bodies with visual geometry were found.';
      Object.assign(empty.style, { padding: '18px 8px', color: theme.textMuted, fontWeight: '700', textAlign: 'center' });
      ui.list.appendChild(empty);
    } else {
      for (const node of roots) appendNode(node, ui.list, 0, [], true);
    }

    const totals = roots.reduce((acc, node) => {
      const c = countTree(node);
      acc.bodies += c.bodies;
      acc.assets += c.assets;
      return acc;
    }, { bodies: 0, assets: 0 });
    treeBuilt = true;
    return { thumbnailJobs, totals };
  }

  async function loadThumbnailJob(job, generation) {
    if (disposed || generation !== thumbnailGeneration || !job?.img?.isConnected) return false;
    try {
      const source = app.assets.bodyThumbnail?.(job.record.linkName) || app.assets.thumbnail?.(job.thumbnailKey);
      const url = await promiseWithTimeout(Promise.resolve(source), 3500, '');
      if (disposed || generation !== thumbnailGeneration || !job.img.isConnected) return false;
      if (typeof url === 'string' && /^data:image\//i.test(url) && url.length > 64) {
        job.img.src = url;
        job.img.dataset.thumbnailReady = '1';
        return true;
      }
    } catch (_) {}
    job.img.dataset.thumbnailReady = '0';
    return false;
  }

  function warmThumbnails(jobs, totals) {
    const generation = ++thumbnailGeneration;
    thumbnailWarmupPromise = (async () => {
      const list = Array.isArray(jobs) ? jobs : [];
      let ok = 0;
      if (!list.length) {
        ui.status.style.display = 'none';
        return true;
      }
      ui.status.style.display = 'block';
      ui.status.textContent = `${totals.bodies} bodies · thumbnails 0/${list.length}`;
      for (let i = 0; i < list.length; i++) {
        await idleYield();
        if (disposed || generation !== thumbnailGeneration) return false;
        if (await loadThumbnailJob(list[i], generation)) ok++;
        if (disposed || generation !== thumbnailGeneration) return false;
        ui.status.textContent = `${totals.bodies} bodies · thumbnails ${i + 1}/${list.length}`;
      }
      if (!disposed && generation === thumbnailGeneration) {
        ui.status.textContent = `${totals.bodies} bodies · ${ok}/${list.length} thumbnails ready`;
        setTimeout(() => {
          if (!disposed && generation === thumbnailGeneration) ui.status.style.display = 'none';
        }, 1400);
      }
      return true;
    })().catch(() => {
      if (!disposed && generation === thumbnailGeneration) ui.status.style.display = 'none';
      return false;
    });
    return thumbnailWarmupPromise;
  }

  async function safeTree() {
    try {
      const value = app.assets.tree?.();
      const tree = await promiseWithTimeout(Promise.resolve(value), 1500, null);
      if (tree && Array.isArray(tree.children)) return tree;
    } catch (_) {}
    return { type: 'root', name: app.robot?.name || 'Robot', children: [] };
  }

  async function preload() {
    if (disposed) return false;
    if (preloadPromise) return preloadPromise;
    preloadPromise = (async () => {
      const tree = await safeTree();
      const { thumbnailJobs, totals } = renderTree(tree);
      // Hierarchy is already usable here. Images are an independent background job.
      warmThumbnails(thumbnailJobs, totals);
      return true;
    })().catch(err => {
      console.warn('[ComponentsPanel] body tree unavailable', err);
      ui.list.replaceChildren();
      const error = document.createElement('div');
      error.textContent = 'The MJCF body hierarchy could not be read.';
      Object.assign(error.style, { padding: '18px 8px', color: theme.textMuted, fontWeight: '700', textAlign: 'center' });
      ui.list.appendChild(error);
      ui.status.style.display = 'none';
      treeBuilt = true;
      return false;
    });
    return preloadPromise;
  }

  function refresh() {
    preloadPromise = null;
    treeBuilt = false;
    thumbnailGeneration++;
    return preload();
  }

  function selectBody(linkName = '', { reveal = true, openPanel = false } = {}) {
    const record = mapped(bodyRows, linkName)[0] || null;
    if (!record) return false;
    applySelectionBubble(record);
    if (reveal) revealRecord(record, true);
    if (openPanel) set(true);
    return true;
  }

  function selectComponent(assetKey = '', linkName = '', options = {}) {
    // The body is the primary component. Asset lookup remains only as a fallback
    // for legacy callbacks or models lacking a usable link name.
    if (linkName && selectBody(linkName, options)) return true;
    const assetRecord = mapped(assetRows, assetKey)[0] || null;
    if (!assetRecord) return false;
    applySelectionBubble(assetRecord);
    if (options.reveal !== false) revealRecord(assetRecord, true);
    if (options.openPanel) set(true);
    return true;
  }

  ui.btn.addEventListener('click', () => set(!open));
  ui.showAllBtn.addEventListener('pointerdown', ev => ev.stopPropagation());
  ui.showAllBtn.addEventListener('click', ev => {
    ev.stopPropagation();
    try { app.showAll?.(); } catch (_) {}
    try { app.clearSelection?.(); app.interaction?.clearHover?.(); } catch (_) {}
    clearSelectionBubble();
  });

  function onHotkeyC(e) {
    const tag = String(e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.isComposing) return;
    if (e.key === 'c' || e.key === 'C' || e.code === 'KeyC') {
      e.preventDefault();
      set(!open);
    }
  }
  document.addEventListener('keydown', onHotkeyC, true);

  function destroy() {
    disposed = true;
    thumbnailGeneration++;
    try { document.removeEventListener('keydown', onHotkeyC, true); } catch (_) {}
    try { resizeObserver?.disconnect?.(); } catch (_) { window.removeEventListener('resize', updateResponsiveLayout); }
    try { ui.root.remove(); } catch (_) {}
    rowRecords.length = 0;
    bodyRows.clear();
    assetRows.clear();
  }

  updateResponsiveLayout();
  set(false);

  return {
    open: () => set(true), close: () => set(false), set, preload, refresh,
    selectBody, selectComponent, clearSelection: clearSelectionBubble,
    get ready() { return treeBuilt; },
    get thumbnailsReady() { return thumbnailWarmupPromise || Promise.resolve(false); },
    destroy,
  };
}

function promiseWithTimeout(promise, timeoutMs, fallbackValue) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallbackValue), Math.max(250, Number(timeoutMs) || 3500));
    Promise.resolve(promise).then(finish, () => finish(fallbackValue));
  });
}

function idleYield() {
  return new Promise(resolve => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 100 });
    else setTimeout(resolve, 0);
  });
}
