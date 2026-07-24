// Hierarchical Components panel for AutoMind MJCF Viewer.
// BUILD237:
// - Builds the hierarchy immediately after model load.
// - Warms thumbnails in the background without blocking the Components button.
// - Parent rows only expand/collapse; they never trigger 3-D selection.
// - One failed thumbnail cannot abort the tree.
// - 3-D selection expands ancestors and draws a teal bubble around the row.

export function createComponentsPanel(app, theme) {
  if (!app || !app.assets || !app.isolate || !app.showAll) {
    throw new Error('[ComponentsPanel] Missing required app APIs');
  }

  const UI_SCALE = 0.5;
  const UI_SCALE_INV = 1 / UI_SCALE;
  const BUTTON_LEFT = 50;
  const BUTTON_BOTTOM = 14;
  const PANEL_BASE_WIDTH = 520;

  let open = false;
  let disposed = false;
  let loadingTree = true;
  let treeBuilt = false;
  let preloadPromise = null;
  let thumbnailWarmupPromise = null;
  let currentClosedTx = -2200;
  let selectedRecord = null;
  let thumbnailGeneration = 0;

  const expandedLinks = new Set();
  const rowRecords = [];
  const assetRows = new Map();
  const linkRows = new Map();

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
    position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '9999',
    overflow: 'hidden', fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif'
  });
  Object.assign(ui.btn.style, {
    position: 'absolute', left: `${BUTTON_LEFT}px`, bottom: `${BUTTON_BOTTOM}px`,
    padding: '8px 12px', borderRadius: '12px', border: `1px solid ${theme.stroke}`,
    background: theme.bgPanel, color: theme.text, fontWeight: '700', cursor: 'pointer',
    boxShadow: theme.shadow, pointerEvents: 'auto', transition: 'all .12s ease',
    transformOrigin: 'bottom left', scale: String(UI_SCALE)
  });
  Object.assign(ui.panel.style, {
    position: 'absolute', left: `${BUTTON_LEFT}px`, bottom: '60px', width: `${PANEL_BASE_WIDTH}px`,
    maxHeight: `calc(92vh * ${UI_SCALE_INV})`, background: theme.bgPanel,
    border: `1px solid ${theme.stroke}`, boxShadow: theme.shadow, borderRadius: '18px',
    overflow: 'hidden', display: 'block', pointerEvents: 'none', willChange: 'transform, opacity',
    transition: 'transform 260ms cubic-bezier(.2,.7,.2,1), opacity 200ms ease',
    transform: 'translateX(-2200px)', opacity: '0', transformOrigin: 'bottom left', scale: String(UI_SCALE)
  });
  Object.assign(ui.header.style, {
    display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: '10px',
    padding: '10px 12px', borderBottom: `1px solid ${theme.stroke}`, background: '#0ea5a6'
  });
  Object.assign(ui.title.style, { fontWeight: '800', color: '#fff', fontSize: '14px' });
  Object.assign(ui.showAllBtn.style, {
    padding: '6px 10px', borderRadius: '10px', border: `1px solid ${theme.stroke}`,
    background: theme.bgPanel, fontWeight: '700', cursor: 'pointer', fontSize: '11px'
  });
  Object.assign(ui.status.style, {
    padding: '7px 12px', fontSize: '11px', fontWeight: '700', color: theme.textMuted,
    borderBottom: `1px solid ${theme.stroke}`, background: '#f8fafc'
  });
  Object.assign(ui.list.style, {
    overflowY: 'auto', maxHeight: `calc((92vh - 86px) * ${UI_SCALE_INV})`, padding: '10px 10px 16px'
  });

  ui.title.textContent = 'Components';
  ui.showAllBtn.textContent = 'Show all';
  ui.btn.textContent = 'Components · loading';
  ui.btn.disabled = true;
  ui.btn.style.opacity = '0.72';
  ui.btn.style.cursor = 'progress';
  ui.status.textContent = 'Preparing component hierarchy…';

  ui.header.append(ui.title, ui.showAllBtn);
  ui.panel.append(ui.header, ui.status, ui.list);
  ui.root.append(ui.panel, ui.btn);
  host.appendChild(ui.root);

  function updateResponsiveLayout() {
    const rect = host.getBoundingClientRect();
    const panelVisualWidth = PANEL_BASE_WIDTH * UI_SCALE;
    const availableLeft = Math.max(0, BUTTON_LEFT);
    currentClosedTx = -Math.max(panelVisualWidth + availableLeft + 40, 300) * UI_SCALE_INV;
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
    if (open) {
      ui.panel.style.opacity = '1';
      ui.panel.style.transform = 'translateX(0px)';
      ui.panel.style.pointerEvents = 'auto';
      if (selectedRecord) revealRecord(selectedRecord, true);
    } else {
      ui.panel.style.opacity = '0';
      ui.panel.style.transform = `translateX(${currentClosedTx}px)`;
      ui.panel.style.pointerEvents = 'none';
    }
  }

  function normalizeKey(value) {
    return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  }

  function addMapValue(map, key, record) {
    if (!key) return;
    for (const k of new Set([String(key), normalizeKey(key)])) {
      const arr = map.get(k) || [];
      arr.push(record);
      map.set(k, arr);
    }
  }

  function getMapValues(map, key) {
    if (!key) return [];
    return map.get(String(key)) || map.get(normalizeKey(key)) || [];
  }

  function clearSelectionBubble() {
    for (const record of rowRecords) {
      if (!record?.row) continue;
      record.row.style.boxShadow = record.kind === 'asset' ? '0 1px 4px rgba(15,23,42,.06)' : 'none';
      record.row.style.borderColor = theme.stroke;
      record.row.style.background = record.kind === 'asset' ? '#fff' : 'transparent';
      record.row.style.outline = 'none';
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

  function setLinkExpanded(record, expanded) {
    if (!record || record.kind !== 'link') return;
    record.expanded = !!expanded;
    if (record.expanded) expandedLinks.add(record.linkName);
    else expandedLinks.delete(record.linkName);
    if (record.childrenEl) record.childrenEl.style.display = record.expanded ? 'block' : 'none';
    if (record.chevron) record.chevron.textContent = record.expanded ? '▾' : '▸';
    record.row?.setAttribute?.('aria-expanded', String(record.expanded));
  }

  function revealRecord(record, scroll = false) {
    if (!record) return;
    for (const ancestor of record.ancestors || []) setLinkExpanded(ancestor, true);
    if (record.kind === 'link') setLinkExpanded(record, true);
    if (scroll && open) {
      requestAnimationFrame(() => {
        try { record.row?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); } catch (_) {}
      });
    }
  }

  function makeLinkRow(node, depth, ancestors) {
    const wrap = document.createElement('div');
    const row = document.createElement('div');
    const childrenEl = document.createElement('div');
    const chevron = document.createElement('span');
    const label = document.createElement('span');
    const count = document.createElement('span');

    Object.assign(row.style, {
      display: 'grid', gridTemplateColumns: '20px 1fr auto', alignItems: 'center', gap: '7px',
      minHeight: '34px', padding: `5px 8px 5px ${8 + depth * 16}px`, margin: '3px 0',
      border: `1px solid ${theme.stroke}`, borderRadius: '12px', cursor: 'pointer', color: theme.text,
      transition: 'background .12s ease, border-color .12s ease, box-shadow .12s ease', userSelect: 'none'
    });
    chevron.textContent = '▸';
    chevron.style.fontSize = '16px';
    chevron.style.color = '#0f766e';
    label.textContent = node.name || node.linkName || 'Body';
    label.style.fontWeight = '800';
    label.style.fontSize = '13px';
    count.textContent = String(node.visualCount || 0);
    count.style.fontSize = '11px';
    count.style.fontWeight = '800';
    count.style.color = theme.textMuted;
    count.style.padding = '2px 7px';
    count.style.borderRadius = '999px';
    count.style.background = '#e6fffb';
    row.append(chevron, label, count);
    wrap.append(row, childrenEl);

    const record = {
      kind: 'link', row, childrenEl, chevron, linkName: node.linkName || node.name || '',
      ancestors: ancestors.slice(), expanded: false
    };
    rowRecords.push(record);
    addMapValue(linkRows, record.linkName, record);

    // A parent row is strictly a tree control. Selecting the body here used to
    // trigger the 3-D selection callback and could immediately disturb/collapse
    // the same branch before its child rows became visible.
    row.addEventListener('click', (ev) => {
      ev.stopPropagation();
      setLinkExpanded(record, !record.expanded);
    });
    row.addEventListener('pointerdown', ev => ev.stopPropagation());
    row.addEventListener('mouseenter', () => {
      if (selectedRecord !== record) row.style.background = theme.tealFaint || '#f0fdfa';
    });
    row.addEventListener('mouseleave', () => {
      if (selectedRecord !== record) row.style.background = 'transparent';
    });

    setLinkExpanded(record, expandedLinks.has(record.linkName));
    return { wrap, record };
  }

  function placeholderDataUrl(label) {
    const safe = String(label || 'Component').slice(0, 22).replace(/[&<>"']/g, '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="192"><rect width="100%" height="100%" rx="18" fill="#f3f8f9"/><path d="M62 116l36-40 27 31 22-24 47 52H62z" fill="#cbd5e1"/><circle cx="161" cy="62" r="13" fill="#cbd5e1"/><text x="128" y="164" text-anchor="middle" font-family="Arial" font-size="15" fill="#64748b">${safe}</text></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  function makeAssetRow(ent, depth, ancestors, thumbnailJobs) {
    const row = document.createElement('div');
    const img = document.createElement('img');
    const meta = document.createElement('div');
    const title = document.createElement('div');
    const small = document.createElement('div');

    Object.assign(row.style, {
      display: 'grid', gridTemplateColumns: '128px 1fr', gap: '12px', alignItems: 'center',
      padding: '10px', margin: `5px 0 8px ${Math.max(0, depth * 16)}px`, borderRadius: '15px',
      border: `1px solid ${theme.stroke}`, background: '#fff', cursor: 'pointer',
      transition: 'transform .08s ease, box-shadow .12s ease, border-color .12s ease',
      boxShadow: '0 1px 4px rgba(15,23,42,.06)'
    });
    Object.assign(img.style, {
      width: '128px', height: '96px', objectFit: 'contain', borderRadius: '10px',
      border: `1px solid ${theme.stroke}`, background: theme.bgCanvas || '#f8fafc'
    });
    img.alt = ent.base || ent.assetKey || 'component';
    img.decoding = 'async';
    img.loading = 'eager';
    img.src = placeholderDataUrl(img.alt);
    title.textContent = ent.base || ent.assetKey || 'Component';
    Object.assign(title.style, { fontWeight: '800', fontSize: '14px', color: theme.text, overflowWrap: 'anywhere' });
    small.textContent = `${ent.ext ? '.' + ent.ext : 'visual'} • ${ent.count || 1} mesh${(ent.count || 1) !== 1 ? 'es' : ''}`;
    Object.assign(small.style, { color: theme.textMuted, fontSize: '12px', marginTop: '3px' });
    meta.append(title, small);
    row.append(img, meta);

    const record = {
      kind: 'asset', row, img, assetKey: ent.assetKey || '', linkName: ent.linkName || '',
      ancestors: ancestors.slice(), ent
    };
    rowRecords.push(record);
    addMapValue(assetRows, record.assetKey, record);
    addMapValue(linkRows, record.linkName, record);

    row.addEventListener('pointerdown', ev => ev.stopPropagation());
    row.addEventListener('mouseenter', () => {
      if (selectedRecord !== record) {
        row.style.transform = 'translateY(-1px) scale(1.01)';
        row.style.background = theme.tealFaint || '#f0fdfa';
      }
    });
    row.addEventListener('mouseleave', () => {
      row.style.transform = 'none';
      if (selectedRecord !== record) row.style.background = '#fff';
    });
    row.addEventListener('click', ev => {
      ev.stopPropagation();
      revealRecord(record, false);
      try { app.clearSelection?.(); app.interaction?.clearHover?.(); } catch (_) {}
      try { app.isolate.asset?.(record.assetKey); } catch (_) {}
      try { app.selectAsset?.(record.assetKey, record.linkName); } catch (_) {}
      // Keep the row bubble even if a model has no selectable articulated link.
      applySelectionBubble(record);
      set(true);
    });

    thumbnailJobs.push({ record, img, assetKey: record.assetKey, label: title.textContent });
    return { row, record };
  }

  function countVisuals(node, visiting = new Set()) {
    if (!node || visiting.has(node)) return 0;
    visiting.add(node);
    let n = Array.isArray(node.assets) ? node.assets.length : 0;
    for (const child of Array.isArray(node.children) ? node.children : []) n += countVisuals(child, visiting);
    visiting.delete(node);
    node.visualCount = n;
    return n;
  }

  async function getSafeTree() {
    try {
      const tree = await app.assets.tree?.();
      if (tree && Array.isArray(tree.children)) return tree;
    } catch (err) {
      console.warn('[ComponentsPanel] hierarchy unavailable; using flat fallback', err);
    }
    let items = [];
    try { items = await app.assets.list?.() || []; } catch (_) {}
    return {
      type: 'root', name: app.robot?.name || 'Robot', children: [{
        type: 'link', name: app.robot?.name || 'Robot', linkName: '__fallback__', children: [],
        assets: Array.isArray(items) ? items.map(x => ({ ...x, linkName: x.linkName || x.linkNames?.[0] || '' })) : []
      }]
    };
  }

  async function renderTree() {
    ui.list.replaceChildren();
    rowRecords.length = 0;
    assetRows.clear();
    linkRows.clear();
    const thumbnailJobs = [];
    const tree = await getSafeTree();

    for (const child of tree.children || []) countVisuals(child);

    const rootHeader = document.createElement('div');
    rootHeader.textContent = tree.name || app.robot?.name || 'Robot';
    Object.assign(rootHeader.style, {
      padding: '7px 9px', marginBottom: '6px', borderRadius: '10px', background: '#ccfbf1',
      color: '#115e59', fontWeight: '900', fontSize: '13px'
    });
    ui.list.appendChild(rootHeader);

    const renderedNodes = new Set();
    function appendNode(node, parentEl, depth, ancestors) {
      if (!node || renderedNodes.has(node)) return;
      renderedNodes.add(node);
      const made = makeLinkRow(node, depth, ancestors);
      parentEl.appendChild(made.wrap);
      const nextAncestors = ancestors.concat(made.record);
      for (const ent of Array.isArray(node.assets) ? node.assets : []) {
        const assetMade = makeAssetRow(ent, depth + 1, nextAncestors, thumbnailJobs);
        made.childrenEl.appendChild(assetMade.row);
      }
      for (const child of Array.isArray(node.children) ? node.children : []) {
        appendNode(child, made.childrenEl, depth + 1, nextAncestors);
      }
    }

    const topNodes = Array.isArray(tree.children) ? tree.children : [];
    if (!topNodes.length) {
      const empty = document.createElement('div');
      empty.textContent = 'No components with visual geometry found.';
      Object.assign(empty.style, { padding: '12px 4px', color: theme.textMuted, fontWeight: '700' });
      ui.list.appendChild(empty);
    } else {
      for (const node of topNodes) appendNode(node, ui.list, 0, []);
    }

    treeBuilt = true;
    return thumbnailJobs;
  }

  async function loadThumbnailJob(job, generation) {
    if (disposed || generation !== thumbnailGeneration || !job?.img?.isConnected) return false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const url = await app.assets.thumbnail?.(job.assetKey);
        if (disposed || generation !== thumbnailGeneration || !job.img.isConnected) return false;
        if (typeof url === 'string' && /^data:image\//i.test(url) && url.length > 64) {
          job.img.src = url;
          job.img.dataset.thumbnailReady = '1';
          return true;
        }
      } catch (err) {
        console.warn('[ComponentsPanel] thumbnail failed', job.assetKey, err);
      }
      await idleYield();
    }
    job.img.dataset.thumbnailReady = '0';
    return false;
  }

  function warmThumbnails(thumbnailJobs) {
    const generation = ++thumbnailGeneration;
    thumbnailWarmupPromise = (async () => {
      let ok = 0;
      const jobs = Array.isArray(thumbnailJobs) ? thumbnailJobs : [];
      for (let i = 0; i < jobs.length; i++) {
        await idleYield();
        if (await loadThumbnailJob(jobs[i], generation)) ok++;
        if (disposed || generation !== thumbnailGeneration) return false;
        ui.status.style.display = 'block';
        ui.status.textContent = `Loading thumbnails… ${i + 1}/${jobs.length}`;
        ui.btn.textContent = `Components · ${i + 1}/${jobs.length}`;
      }
      if (disposed || generation !== thumbnailGeneration) return false;
      ui.status.textContent = ok === jobs.length ? 'Thumbnails ready' : `Thumbnails ready: ${ok}/${jobs.length}`;
      setTimeout(() => {
        if (!disposed && generation === thumbnailGeneration) ui.status.style.display = 'none';
      }, 1200);
      return ok === jobs.length;
    })().catch(err => {
      console.warn('[ComponentsPanel] thumbnail warm-up stopped', err);
      return false;
    });
    return thumbnailWarmupPromise;
  }

  async function preload() {
    if (disposed) return false;
    if (preloadPromise) return preloadPromise;
    loadingTree = true;
    ui.btn.disabled = true;
    ui.btn.textContent = 'Components · loading';
    ui.btn.style.opacity = '0.72';
    ui.btn.style.cursor = 'progress';
    ui.status.style.display = 'block';
    ui.status.textContent = 'Preparing component hierarchy…';

    preloadPromise = (async () => {
      let jobs = [];
      try {
        jobs = await renderTree();
      } catch (err) {
        console.warn('[ComponentsPanel] tree build failed', err);
        // A final flat fallback guarantees the button and component rows remain usable.
        ui.list.replaceChildren();
        const fallback = await getSafeTree();
        const all = [];
        const walk = node => {
          for (const a of node?.assets || []) all.push(a);
          for (const c of node?.children || []) walk(c);
        };
        walk(fallback);
        const synthetic = { name: 'Components', linkName: '__flat__', assets: all, children: [], visualCount: all.length };
        const made = makeLinkRow(synthetic, 0, []);
        ui.list.appendChild(made.wrap);
        jobs = [];
        for (const ent of all) {
          const assetMade = makeAssetRow(ent, 1, [made.record], jobs);
          made.childrenEl.appendChild(assetMade.row);
        }
        treeBuilt = true;
      }

      ui.status.textContent = jobs.length ? `Loading thumbnails… 0/${jobs.length}` : 'Components ready';
      if (jobs.length) await warmThumbnails(jobs);
      loadingTree = false;
      ui.btn.disabled = false;
      ui.btn.textContent = 'Components';
      ui.btn.style.opacity = '1';
      ui.btn.style.cursor = 'pointer';
      if (!jobs.length) {
        ui.status.textContent = 'Components ready';
        setTimeout(() => { if (!disposed && !loadingTree) ui.status.style.display = 'none'; }, 900);
      }
      return true;
    })();
    return preloadPromise;
  }

  async function refresh() {
    preloadPromise = null;
    treeBuilt = false;
    thumbnailGeneration++;
    return preload();
  }

  function selectComponent(assetKey = '', linkName = '', { reveal = true, openPanel = false } = {}) {
    let candidates = assetKey ? getMapValues(assetRows, assetKey) : [];
    let record = null;
    if (linkName && candidates.length) record = candidates.find(r => r.linkName === linkName) || candidates[0];
    else if (candidates.length) record = candidates[0];
    if (!record && linkName) {
      const linkCandidates = getMapValues(linkRows, linkName);
      record = linkCandidates.find(r => r.kind === 'asset') || linkCandidates.find(r => r.kind === 'link') || null;
    }
    if (!record) return false;
    applySelectionBubble(record);
    if (reveal) revealRecord(record, true);
    if (openPanel) set(true);
    return true;
  }

  ui.btn.addEventListener('click', () => {
    if (loadingTree) return;
    set(!open);
  });
  ui.showAllBtn.addEventListener('pointerdown', ev => ev.stopPropagation());
  ui.showAllBtn.addEventListener('click', ev => {
    ev.stopPropagation();
    try { app.showAll?.(); } catch (_) {}
    try { app.clearSelection?.(); app.interaction?.clearHover?.(); } catch (_) {}
    clearSelectionBubble();
  });

  function onHotkeyC(e) {
    const tag = String(e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.isComposing || loadingTree) return;
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
    assetRows.clear();
    linkRows.clear();
  }

  updateResponsiveLayout();
  set(false);

  return {
    open: () => set(true), close: () => set(false), set, preload, refresh, selectComponent,
    clearSelection: clearSelectionBubble,
    get ready() { return treeBuilt && !loadingTree; },
    get thumbnailsReady() { return thumbnailWarmupPromise || Promise.resolve(false); },
    destroy,
  };
}

function idleYield() {
  return new Promise(resolve => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 120 });
    else setTimeout(resolve, 0);
  });
}
