// Clean body-tree Components panel for AutoMind MJCF Viewer.
// BUILD241:
// - Uses only the MJCF <body> hierarchy.
// - Tree rows contain chevron, thumbnail, body name and subtree object count.
// - No Geometry folders, mesh labels, child counts or joint badges in the tree.
// - Clicking a body opens a structured component detail view in the same panel.
// - Back arrow returns to the tree.
// - Hotkey C: closed -> tree, tree -> closed, detail -> tree.
// - Body thumbnails load independently in the background and never block the UI.

export function createComponentsPanel(app, theme) {
  if (!app || !app.assets || !app.isolate || !app.showAll) {
    throw new Error('[ComponentsPanel] Missing required app APIs');
  }

  const UI_SCALE = 0.5;
  const UI_SCALE_INV = 1 / UI_SCALE;
  const BUTTON_LEFT = 50;
  const BUTTON_BOTTOM = 14;
  const PANEL_BASE_WIDTH = 760;

  let open = false;
  let disposed = false;
  let treeBuilt = false;
  let preloadPromise = null;
  let thumbnailWarmupPromise = null;
  let thumbnailGeneration = 0;
  let currentClosedTx = -2400;
  let selectedRecord = null;
  let detailRecord = null;
  let viewMode = 'tree'; // tree | detail

  const rowRecords = [];
  const bodyRows = new Map();
  const expandedBodies = new Set();

  const ui = {
    root: document.createElement('div'),
    btn: document.createElement('button'),
    panel: document.createElement('div'),
    header: document.createElement('div'),
    headerLeft: document.createElement('div'),
    backBtn: document.createElement('button'),
    title: document.createElement('div'),
    showAllBtn: document.createElement('button'),
    content: document.createElement('div'),
    treeView: document.createElement('div'),
    detailView: document.createElement('div'),
  };

  const host = app.renderer?.domElement?.parentElement || document.body;
  if (window.getComputedStyle(host).position === 'static') host.style.position = 'relative';

  ui.root.dataset.automindRuntimeUi = '1';
  Object.assign(ui.root.style, {
    position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '9999', overflow: 'hidden',
    fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif'
  });
  Object.assign(ui.btn.style, {
    position: 'absolute', left: `${BUTTON_LEFT}px`, bottom: `${BUTTON_BOTTOM}px`, padding: '8px 12px',
    borderRadius: '12px', border: `1px solid ${theme.stroke}`, background: theme.bgPanel,
    color: theme.text, fontWeight: '700', cursor: 'pointer', boxShadow: theme.shadow,
    pointerEvents: 'auto', transition: 'transform .12s ease, box-shadow .12s ease, background-color .12s ease, border-color .12s ease',
    transformOrigin: 'bottom left', scale: String(UI_SCALE)
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
    display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', alignItems: 'center', gap: '10px', padding: '10px 12px',
    borderBottom: `1px solid ${theme.stroke}`, background: '#0ea5a6'
  });
  Object.assign(ui.headerLeft.style, {
    display: 'flex', alignItems: 'center', gap: '9px', minWidth: '0'
  });
  Object.assign(ui.backBtn.style, {
    display: 'none', width: '31px', height: '31px', borderRadius: '10px', border: '1px solid rgba(255,255,255,.45)',
    background: 'rgba(255,255,255,.16)', color: '#fff', fontWeight: '900', fontSize: '17px', cursor: 'pointer',
    alignItems: 'center', justifyContent: 'center', padding: '0', transition: 'background-color .12s ease, transform .12s ease'
  });
  Object.assign(ui.title.style, {
    fontWeight: '800', color: '#fff', fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
  });
  Object.assign(ui.showAllBtn.style, {
    padding: '6px 10px', borderRadius: '10px', border: `1px solid ${theme.stroke}`,
    background: theme.bgPanel, color: theme.text, fontWeight: '700', cursor: 'pointer', fontSize: '11px'
  });
  Object.assign(ui.content.style, {
    position: 'relative', overflow: 'hidden'
  });
  Object.assign(ui.treeView.style, {
    overflowY: 'auto', maxHeight: `calc((92vh - 48px) * ${UI_SCALE_INV})`, padding: '12px 14px 20px'
  });
  Object.assign(ui.detailView.style, {
    display: 'none', overflowY: 'auto', maxHeight: `calc((92vh - 48px) * ${UI_SCALE_INV})`, padding: '14px 14px 18px'
  });

  ui.title.textContent = 'Model hierarchy';
  ui.showAllBtn.textContent = 'Show all';
  ui.backBtn.textContent = '←';
  ui.backBtn.title = 'Back to components';
  ui.backBtn.setAttribute('aria-label', 'Back to components');
  ui.btn.textContent = 'Components';
  ui.btn.disabled = false;

  const initial = document.createElement('div');
  initial.textContent = 'Loading model hierarchy…';
  Object.assign(initial.style, { padding: '18px 10px', color: theme.textMuted, fontWeight: '700', textAlign: 'center' });
  ui.treeView.appendChild(initial);

  ui.headerLeft.append(ui.backBtn, ui.title);
  ui.header.append(ui.headerLeft, ui.showAllBtn);
  ui.content.append(ui.treeView, ui.detailView);
  ui.panel.append(ui.header, ui.content);
  ui.root.append(ui.panel, ui.btn);
  host.appendChild(ui.root);

  // Keep the original Components hover feedback visible in every panel state.
  ui.btn.addEventListener('mouseenter', () => {
    ui.btn.style.transform = 'translateY(-2px)';
    ui.btn.style.background = theme.tealFaint || '#ecfeff';
    ui.btn.style.borderColor = theme.tealSoft || theme.teal || '#0ea5a6';
    ui.btn.style.boxShadow = '0 10px 26px rgba(14,165,166,.20)';
  });
  ui.btn.addEventListener('mouseleave', () => {
    ui.btn.style.transform = 'none';
    ui.btn.style.background = theme.bgPanel;
    ui.btn.style.borderColor = theme.stroke;
    ui.btn.style.boxShadow = theme.shadow;
  });
  ui.backBtn.addEventListener('mouseenter', () => {
    ui.backBtn.style.background = 'rgba(255,255,255,.28)';
    ui.backBtn.style.transform = 'translateX(-1px)';
  });
  ui.backBtn.addEventListener('mouseleave', () => {
    ui.backBtn.style.background = 'rgba(255,255,255,.16)';
    ui.backBtn.style.transform = 'none';
  });

  function updateResponsiveLayout() {
    const rect = host.getBoundingClientRect();
    const panelVisualWidth = PANEL_BASE_WIDTH * UI_SCALE;
    currentClosedTx = -Math.max(panelVisualWidth + BUTTON_LEFT + 40, 320) * UI_SCALE_INV;
    if (!open) ui.panel.style.transform = `translateX(${currentClosedTx}px)`;
    const visualHeight = Math.max(rect.height || window.innerHeight || 1, 1);
    const maxHeight = Math.max(260, visualHeight * 0.92) * UI_SCALE_INV;
    ui.panel.style.maxHeight = `${maxHeight}px`;
    ui.treeView.style.maxHeight = `${Math.max(190, maxHeight - 52)}px`;
    ui.detailView.style.maxHeight = `${Math.max(190, maxHeight - 52)}px`;
  }

  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateResponsiveLayout) : null;
  if (resizeObserver) resizeObserver.observe(host);
  else window.addEventListener('resize', updateResponsiveLayout);

  function setPanelOpen(isOpen) {
    open = !!isOpen;
    updateResponsiveLayout();
    ui.panel.style.opacity = open ? '1' : '0';
    ui.panel.style.transform = open ? 'translateX(0px)' : `translateX(${currentClosedTx}px)`;
    ui.panel.style.pointerEvents = open ? 'auto' : 'none';
    if (open && viewMode === 'tree' && selectedRecord) revealRecord(selectedRecord, true);
  }

  function showTree({ revealSelection = true } = {}) {
    viewMode = 'tree';
    detailRecord = null;
    ui.treeView.style.display = 'block';
    ui.detailView.style.display = 'none';
    ui.backBtn.style.display = 'none';
    ui.title.textContent = 'Model hierarchy';
    if (revealSelection && selectedRecord) revealRecord(selectedRecord, true);
  }

  function showDetail(record) {
    if (!record?.node) return;
    detailRecord = record;
    viewMode = 'detail';
    buildDetail(record);
    ui.treeView.style.display = 'none';
    ui.detailView.style.display = 'block';
    ui.backBtn.style.display = 'inline-flex';
    ui.title.textContent = 'Component details';
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
      record.row.style.borderColor = 'transparent';
      record.row.style.boxShadow = 'none';
      record.row.style.background = 'transparent';
    }
    selectedRecord = null;
  }

  function applySelectionBubble(record) {
    clearSelectionBubble();
    if (!record?.row) return;
    selectedRecord = record;
    record.row.style.borderColor = '#0ea5a6';
    record.row.style.background = '#ecfeff';
    record.row.style.outline = '4px solid rgba(14,165,166,.22)';
    record.row.style.boxShadow = '0 8px 20px rgba(14,165,166,.18)';
  }

  function setBodyExpanded(record, expanded) {
    if (!record) return;
    record.expanded = !!expanded;
    if (record.expanded) expandedBodies.add(record.linkName);
    else expandedBodies.delete(record.linkName);
    if (record.childrenEl) record.childrenEl.style.display = record.expanded ? 'block' : 'none';
    if (record.chevron) record.chevron.textContent = record.hasChildren ? (record.expanded ? '▾' : '▸') : '';
    record.row?.setAttribute?.('aria-expanded', String(record.expanded));
  }

  function revealRecord(record, scroll = false) {
    if (!record) return;
    for (const ancestor of record.ancestors || []) setBodyExpanded(ancestor, true);
    if (scroll && open && viewMode === 'tree') {
      requestAnimationFrame(() => {
        try { record.row?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); } catch (_) {}
      });
    }
  }

  function selectBodyRecord(record, { openDetails = true } = {}) {
    if (!record?.linkName) return;
    try { app.clearSelection?.(); app.interaction?.clearHover?.(); } catch (_) {}
    try { app.isolate.body?.(record.linkName); } catch (_) {}
    try { app.selectBody?.(record.linkName); } catch (_) {}
    applySelectionBubble(record);
    if (openDetails) showDetail(record);
    setPanelOpen(true);
  }

  function makeBodyRow(node, depth, ancestors, thumbnailJobs, expandByDefault = false) {
    const wrap = document.createElement('div');
    const row = document.createElement('div');
    const chevronButton = document.createElement('button');
    const thumb = document.createElement('img');
    const title = document.createElement('div');
    const objectCount = document.createElement('div');
    const childrenEl = document.createElement('div');

    const indentPx = 10;
    Object.assign(row.style, {
      display: 'grid', gridTemplateColumns: '44px 88px minmax(0,1fr) auto', alignItems: 'center', gap: '13px',
      width: '100%', boxSizing: 'border-box', minHeight: '78px',
      padding: `8px 16px 8px ${indentPx}px`, margin: '5px 0',
      border: '1px solid transparent', borderRadius: '15px', cursor: 'pointer', color: theme.text,
      background: 'transparent', transition: 'background .12s ease, border-color .12s ease, box-shadow .12s ease, transform .08s ease',
      userSelect: 'none'
    });
    Object.assign(chevronButton.style, {
      width: '44px', height: '52px', border: 'none', borderRadius: '10px', background: 'transparent', color: '#0f766e',
      fontSize: '36px', lineHeight: '1', fontWeight: '900', cursor: 'pointer', padding: '0',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', transition: 'background-color .12s ease, transform .12s ease'
    });
    Object.assign(thumb.style, {
      width: '88px', height: '64px', objectFit: 'contain', borderRadius: '11px', border: `1px solid ${theme.stroke}`,
      background: theme.bgCanvas || '#f8fafc', pointerEvents: 'none'
    });
    thumb.alt = node.name || node.linkName || 'Body';
    thumb.decoding = 'async';
    thumb.loading = 'eager';
    thumb.src = placeholderDataUrl(thumb.alt);
    title.textContent = node.name || node.linkName || 'Body';
    Object.assign(title.style, {
      minWidth: '0', fontWeight: '820', fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
    });
    const count = Math.max(0, Number(node.objectCount ?? node.directMeshCount) || 0);
    objectCount.textContent = `${count} ${count === 1 ? 'object' : 'objects'}`;
    Object.assign(objectCount.style, {
      justifySelf: 'end', whiteSpace: 'nowrap', padding: '5px 9px', borderRadius: '999px',
      background: '#eef8f8', border: '1px solid rgba(14,165,166,.22)', color: '#0f766e',
      fontSize: '10px', fontWeight: '850', letterSpacing: '.01em'
    });

    row.append(chevronButton, thumb, title, objectCount);
    wrap.append(row, childrenEl);
    Object.assign(childrenEl.style, {
      display: 'none', marginLeft: '32px', paddingLeft: '10px',
      borderLeft: '2px solid rgba(14,165,166,.18)'
    });

    const childCount = Array.isArray(node.children) ? node.children.length : 0;
    const record = {
      kind: 'body', row, wrap, childrenEl, chevron: chevronButton, thumb, objectCount,
      linkName: node.linkName || node.name || '',
      thumbnailKey: node.thumbnailKey || `__body__:${node.linkName || node.name || ''}`,
      ancestors: ancestors.slice(), expanded: false, hasChildren: childCount > 0, node
    };
    rowRecords.push(record);
    mapRecord(bodyRows, record.linkName, record);

    chevronButton.textContent = record.hasChildren ? '▸' : '';
    chevronButton.style.cursor = record.hasChildren ? 'pointer' : 'default';
    chevronButton.style.visibility = record.hasChildren ? 'visible' : 'hidden';
    chevronButton.setAttribute('aria-label', record.hasChildren ? 'Expand component hierarchy' : '');
    chevronButton.addEventListener('pointerdown', ev => ev.stopPropagation());
    chevronButton.addEventListener('mouseenter', () => {
      if (!record.hasChildren) return;
      chevronButton.style.background = 'rgba(14,165,166,.12)';
      chevronButton.style.transform = 'scale(1.08)';
    });
    chevronButton.addEventListener('mouseleave', () => {
      chevronButton.style.background = 'transparent';
      chevronButton.style.transform = 'none';
    });
    chevronButton.addEventListener('click', ev => {
      ev.stopPropagation();
      if (record.hasChildren) setBodyExpanded(record, !record.expanded);
    });
    row.addEventListener('pointerdown', ev => ev.stopPropagation());
    row.addEventListener('click', ev => {
      ev.stopPropagation();
      selectBodyRecord(record, { openDetails: true });
    });
    row.addEventListener('mouseenter', () => {
      if (selectedRecord !== record) {
        row.style.background = theme.tealFaint || '#f0fdfa';
        row.style.transform = 'translateY(-1px)';
      }
    });
    row.addEventListener('mouseleave', () => {
      row.style.transform = 'none';
      if (selectedRecord !== record) row.style.background = 'transparent';
    });

    setBodyExpanded(record, record.hasChildren && (expandByDefault || expandedBodies.has(record.linkName)));
    thumbnailJobs.push({ record, img: thumb, thumbnailKey: record.thumbnailKey });
    return record;
  }

  function countTree(node, seen = new Set()) {
    if (!node || seen.has(node)) return 0;
    seen.add(node);
    let bodies = 1;
    for (const child of Array.isArray(node.children) ? node.children : []) bodies += countTree(child, seen);
    return bodies;
  }

  function renderTree(tree) {
    ui.treeView.replaceChildren();
    rowRecords.length = 0;
    bodyRows.clear();
    const thumbnailJobs = [];
    const renderedNodes = new Set();

    function appendNode(node, parentEl, depth, ancestors, isTopLevel = false) {
      if (!node || renderedNodes.has(node)) return;
      renderedNodes.add(node);
      const record = makeBodyRow(node, depth, ancestors, thumbnailJobs, isTopLevel);
      parentEl.appendChild(record.wrap);
      const nextAncestors = ancestors.concat(record);
      for (const child of Array.isArray(node.children) ? node.children : []) {
        appendNode(child, record.childrenEl, depth + 1, nextAncestors, false);
      }
    }

    const roots = Array.isArray(tree?.children) ? tree.children : [];
    if (!roots.length) {
      const empty = document.createElement('div');
      empty.textContent = 'No MJCF bodies with visual geometry were found.';
      Object.assign(empty.style, { padding: '18px 8px', color: theme.textMuted, fontWeight: '700', textAlign: 'center' });
      ui.treeView.appendChild(empty);
    } else {
      for (const node of roots) appendNode(node, ui.treeView, 0, [], true);
    }

    const bodyCount = roots.reduce((sum, node) => sum + countTree(node), 0);
    treeBuilt = true;
    return { thumbnailJobs, bodyCount };
  }

  function sectionTitle(text) {
    const el = document.createElement('div');
    el.textContent = text;
    Object.assign(el.style, {
      margin: '16px 0 7px', fontSize: '10px', fontWeight: '900', letterSpacing: '.08em',
      textTransform: 'uppercase', color: '#0f766e'
    });
    return el;
  }

  function infoRow(label, value) {
    const row = document.createElement('div');
    const left = document.createElement('div');
    const right = document.createElement('div');
    Object.assign(row.style, {
      display: 'grid', gridTemplateColumns: '132px minmax(0,1fr)', gap: '12px', padding: '9px 0',
      borderBottom: `1px solid ${theme.stroke}`
    });
    left.textContent = label;
    right.textContent = value || '—';
    Object.assign(left.style, { color: theme.textMuted, fontWeight: '750', fontSize: '11px' });
    Object.assign(right.style, { color: theme.text, fontWeight: '750', fontSize: '11px', overflowWrap: 'anywhere' });
    row.append(left, right);
    return row;
  }

  function buildDetail(record) {
    const node = record.node || {};
    ui.detailView.replaceChildren();

    const hero = document.createElement('div');
    const img = document.createElement('img');
    const heading = document.createElement('div');
    const name = document.createElement('div');
    const path = document.createElement('div');
    Object.assign(hero.style, {
      display: 'grid', gridTemplateColumns: '160px minmax(0,1fr)', gap: '16px', alignItems: 'center',
      padding: '12px', border: `1px solid ${theme.stroke}`, borderRadius: '16px', background: '#fff'
    });
    Object.assign(img.style, {
      width: '160px', height: '120px', objectFit: 'contain', borderRadius: '12px', border: `1px solid ${theme.stroke}`,
      background: theme.bgCanvas || '#f8fafc'
    });
    img.src = record.thumb?.src || placeholderDataUrl(node.name || record.linkName);
    img.alt = node.name || record.linkName || 'Component';
    name.textContent = node.name || record.linkName || 'Component';
    Object.assign(name.style, { fontSize: '19px', fontWeight: '900', color: theme.text, overflowWrap: 'anywhere' });
    const pathNames = [...(record.ancestors || []).map(a => a.node?.name || a.linkName).filter(Boolean), node.name || record.linkName].filter(Boolean);
    path.textContent = pathNames.join('  ›  ');
    Object.assign(path.style, { marginTop: '8px', fontSize: '11px', lineHeight: '1.45', color: theme.textMuted, overflowWrap: 'anywhere' });
    heading.append(name, path);
    hero.append(img, heading);
    ui.detailView.appendChild(hero);

    const parent = record.ancestors?.length ? record.ancestors[record.ancestors.length - 1] : null;
    const children = Array.isArray(node.children) ? node.children : [];
    const assets = Array.isArray(node.assets) ? node.assets : [];

    ui.detailView.appendChild(sectionTitle('Hierarchy'));
    ui.detailView.appendChild(infoRow('Parent body', parent?.node?.name || parent?.linkName || 'Root'));
    ui.detailView.appendChild(infoRow('Contained objects', String(Math.max(0, Number(node.objectCount ?? node.directMeshCount) || 0))));
    ui.detailView.appendChild(infoRow('Child bodies', children.length ? children.map(c => c.name || c.linkName).join(', ') : 'None'));

    ui.detailView.appendChild(sectionTitle('Kinematics'));
    ui.detailView.appendChild(infoRow('Joint', node.jointLabel || 'Fixed / inherited'));

    ui.detailView.appendChild(sectionTitle('Visual representation'));
    const visualFiles = assets.map(a => `${a.base || a.assetKey || 'Visual'}${a.ext ? '.' + a.ext : ''}`);
    ui.detailView.appendChild(infoRow('Visual files', visualFiles.length ? visualFiles.join(', ') : 'Procedural or inherited'));

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
        if (detailRecord === job.record && viewMode === 'detail') buildDetail(job.record);
        return true;
      }
    } catch (_) {}
    job.img.dataset.thumbnailReady = '0';
    return false;
  }

  function warmThumbnails(jobs) {
    const generation = ++thumbnailGeneration;
    thumbnailWarmupPromise = (async () => {
      const queue = Array.isArray(jobs) ? jobs.slice() : [];
      if (!queue.length) return true;
      let cursor = 0;
      const workerCount = Math.min(3, queue.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (!disposed && generation === thumbnailGeneration) {
          const index = cursor++;
          if (index >= queue.length) break;
          await idleYield();
          await loadThumbnailJob(queue[index], generation);
        }
      });
      await Promise.all(workers);
      return !disposed && generation === thumbnailGeneration;
    })().catch(() => false);
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
      const { thumbnailJobs } = renderTree(tree);
      warmThumbnails(thumbnailJobs);
      return true;
    })().catch(err => {
      console.warn('[ComponentsPanel] body tree unavailable', err);
      ui.treeView.replaceChildren();
      const error = document.createElement('div');
      error.textContent = 'The MJCF body hierarchy could not be read.';
      Object.assign(error.style, { padding: '18px 8px', color: theme.textMuted, fontWeight: '700', textAlign: 'center' });
      ui.treeView.appendChild(error);
      treeBuilt = true;
      return false;
    });
    return preloadPromise;
  }

  function refresh() {
    preloadPromise = null;
    treeBuilt = false;
    thumbnailGeneration++;
    showTree({ revealSelection: false });
    return preload();
  }

  function selectBody(linkName = '', { reveal = true, openPanel = false, showDetails = false } = {}) {
    const record = mapped(bodyRows, linkName)[0] || null;
    if (!record) return false;
    applySelectionBubble(record);
    if (reveal) revealRecord(record, true);
    if (showDetails) showDetail(record);
    if (openPanel) setPanelOpen(true);
    return true;
  }

  function selectComponent(_assetKey = '', linkName = '', options = {}) {
    return linkName ? selectBody(linkName, options) : false;
  }

  ui.btn.addEventListener('click', () => {
    if (open) setPanelOpen(false);
    else {
      showTree();
      setPanelOpen(true);
    }
  });
  ui.backBtn.addEventListener('pointerdown', ev => ev.stopPropagation());
  ui.backBtn.addEventListener('click', ev => {
    ev.stopPropagation();
    showTree();
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
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.isComposing) return;
    if (e.key === 'c' || e.key === 'C' || e.code === 'KeyC') {
      e.preventDefault();
      e.stopPropagation();
      if (!open) {
        showTree();
        setPanelOpen(true);
      } else if (viewMode === 'detail') {
        showTree();
      } else {
        setPanelOpen(false);
      }
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
  }

  updateResponsiveLayout();
  showTree({ revealSelection: false });
  setPanelOpen(false);

  return {
    open: () => { showTree(); setPanelOpen(true); },
    close: () => setPanelOpen(false),
    set: isOpen => { if (isOpen) { showTree(); setPanelOpen(true); } else setPanelOpen(false); },
    preload, refresh, selectBody, selectComponent, clearSelection: clearSelectionBubble,
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
