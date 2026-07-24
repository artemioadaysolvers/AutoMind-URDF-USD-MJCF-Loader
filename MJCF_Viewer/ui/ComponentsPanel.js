// AutoMind MJCF body-tree Components panel — BUILD249.
// BUILD248:
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
  const PANEL_BOTTOM = 52;
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
  const thumbnailCache = new Map(Object.entries(
    (globalThis.__AUTOMIND_BODY_THUMBNAILS__ && typeof globalThis.__AUTOMIND_BODY_THUMBNAILS__ === 'object')
      ? globalThis.__AUTOMIND_BODY_THUMBNAILS__
      : {}
  ));
  function publishThumbnailCache() {
    try { globalThis.__AUTOMIND_BODY_THUMBNAILS__ = Object.fromEntries(thumbnailCache); } catch (_) {}
  }

  const ui = {
    root: document.createElement('div'),
    btn: document.createElement('button'),
    panel: document.createElement('div'),
    header: document.createElement('div'),
    headerLeft: document.createElement('div'),
    backBtn: document.createElement('button'),
    title: document.createElement('div'),
    headerActions: document.createElement('div'),
    downloadSheetBtn: document.createElement('button'),
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
    position: 'absolute', left: `${BUTTON_LEFT}px`, bottom: `${PANEL_BOTTOM}px`, width: `${PANEL_BASE_WIDTH}px`,
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
  Object.assign(ui.headerActions.style, { display: 'flex', alignItems: 'center', gap: '8px' });
  Object.assign(ui.downloadSheetBtn.style, {
    display: 'none', padding: '6px 10px', borderRadius: '10px', border: '1px solid rgba(255,255,255,.55)',
    background: 'rgba(255,255,255,.18)', color: '#fff', fontWeight: '800', cursor: 'pointer', fontSize: '11px'
  });
  Object.assign(ui.showAllBtn.style, {
    padding: '6px 10px', borderRadius: '10px', border: `1px solid ${theme.stroke}`,
    background: theme.bgPanel, color: theme.text, fontWeight: '700', cursor: 'pointer', fontSize: '11px'
  });
  Object.assign(ui.content.style, {
    position: 'relative', overflow: 'hidden'
  });
  Object.assign(ui.treeView.style, {
    overflowY: 'auto', overscrollBehavior: 'contain', maxHeight: `calc((92vh - 48px) * ${UI_SCALE_INV})`, padding: '12px 14px 20px'
  });
  Object.assign(ui.detailView.style, {
    display: 'none', overflowY: 'auto', overscrollBehavior: 'contain', maxHeight: `calc((92vh - 48px) * ${UI_SCALE_INV})`, padding: '14px 14px 18px'
  });

  [ui.btn, ui.backBtn, ui.downloadSheetBtn, ui.showAllBtn].forEach(button => { button.type = 'button'; });

  ui.title.textContent = 'Model hierarchy';
  ui.downloadSheetBtn.textContent = 'Download technical sheet';
  ui.downloadSheetBtn.title = 'Download a high-resolution PNG technical sheet';
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
  ui.headerActions.append(ui.downloadSheetBtn, ui.showAllBtn);
  ui.header.append(ui.headerLeft, ui.headerActions);
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

    // In Colab the host iframe can be much shorter than the browser viewport.
    // Reserve the actual bottom offset and a small top safety margin before
    // converting the available visual height into the panel's unscaled space.
    const hostVisualHeight = Math.max(1, rect.height || host.clientHeight || window.innerHeight || 1);
    const topSafety = 10;
    const availableVisualHeight = Math.max(170, hostVisualHeight - PANEL_BOTTOM - topSafety);
    const maxHeight = availableVisualHeight * UI_SCALE_INV;
    const headerAllowance = 66;
    const contentMaxHeight = Math.max(150, maxHeight - headerAllowance);

    ui.panel.style.maxHeight = `${maxHeight}px`;
    ui.content.style.maxHeight = `${contentMaxHeight}px`;
    ui.treeView.style.maxHeight = `${contentMaxHeight}px`;
    ui.detailView.style.maxHeight = `${contentMaxHeight}px`;
  }

  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateResponsiveLayout) : null;
  if (resizeObserver) resizeObserver.observe(host);
  else window.addEventListener('resize', updateResponsiveLayout);

  function setPanelOpen(isOpen) {
    const wasDetail = viewMode === 'detail';
    open = !!isOpen;
    updateResponsiveLayout();
    ui.panel.style.opacity = open ? '1' : '0';
    ui.panel.style.transform = open ? 'translateX(0px)' : `translateX(${currentClosedTx}px)`;
    ui.panel.style.pointerEvents = open ? 'auto' : 'none';
    if (!open && wasDetail) {
      // Closing the technical sheet restores the complete model, original
      // materials and the render mode that was active before inspection.
      try { app.endComponentInspection?.(); } catch (_) {}
    }
    if (open && viewMode === 'tree' && selectedRecord) revealRecord(selectedRecord, true);
  }

  function showTree({ revealSelection = true } = {}) {
    viewMode = 'tree';
    detailRecord = null;
    ui.treeView.style.display = 'block';
    ui.detailView.style.display = 'none';
    ui.backBtn.style.display = 'none';
    ui.downloadSheetBtn.style.display = 'none';
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
    ui.downloadSheetBtn.style.display = 'inline-block';
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

  let revealScrollToken = 0;
  function revealRecord(record, scroll = false) {
    if (!record) return;
    for (const ancestor of record.ancestors || []) setBodyExpanded(ancestor, true);
    if (!(scroll && open && viewMode === 'tree')) return;
    const token = ++revealScrollToken;
    // Two animation frames let every newly-expanded ancestor contribute its
    // final height before calculating the internal list position.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (token !== revealScrollToken || !open || viewMode !== 'tree') return;
      const container = ui.treeView;
      const row = record.row;
      if (!container || !row?.isConnected) return;
      const containerRect = container.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      // The complete panel is visually scaled to 50%. DOMRect values are scaled,
      // while scrollTop/clientHeight remain in unscaled CSS pixels. Convert the
      // measured delta back to the scroll coordinate system before centering.
      const scaleY = container.clientHeight > 0
        ? Math.max(0.01, containerRect.height / container.clientHeight)
        : UI_SCALE;
      const rowTopInScrollSpace = container.scrollTop + (rowRect.top - containerRect.top) / scaleY;
      const rowHeightInScrollSpace = rowRect.height / scaleY;
      const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
      const desiredTop = Math.min(maxTop, Math.max(0,
        rowTopInScrollSpace - (container.clientHeight - rowHeightInScrollSpace) * 0.5
      ));
      container.scrollTo({ top: desiredTop, behavior: 'smooth' });
      // Smooth scrolling can be interrupted by thumbnail layout updates. Verify
      // once after the animation and finish with an exact internal correction.
      setTimeout(() => {
        if (token !== revealScrollToken || !open || viewMode !== 'tree' || !row.isConnected) return;
        const cRect = container.getBoundingClientRect();
        const rRect = row.getBoundingClientRect();
        const margin = 14 * scaleY;
        if (rRect.top < cRect.top + margin || rRect.bottom > cRect.bottom - margin) {
          const currentScale = container.clientHeight > 0 ? Math.max(0.01, cRect.height / container.clientHeight) : UI_SCALE;
          const exactTop = Math.min(Math.max(0, container.scrollHeight - container.clientHeight), Math.max(0,
            container.scrollTop + (rRect.top - cRect.top) / currentScale - (container.clientHeight - rRect.height / currentScale) * 0.5
          ));
          container.scrollTo({ top: exactTop, behavior: 'auto' });
        }
      }, 420);
    }));
  }

  function childLinkNames(record) {
    return (Array.isArray(record?.node?.children) ? record.node.children : [])
      .map(child => String(child?.linkName || child?.name || ''))
      .filter(Boolean);
  }

  function selectBodyRecord(record, { openDetails = true } = {}) {
    if (!record?.linkName) return;
    try { app.clearSelection?.(); app.interaction?.clearHover?.(); } catch (_) {}
    try { app.startComponentInspection?.(record.linkName, childLinkNames(record)); } catch (_) {}
    applySelectionBubble(record);
    if (openDetails) showDetail(record);
    setPanelOpen(true);
  }

  function makeBodyRow(node, depth, ancestors, thumbnailJobs, expandByDefault = false) {
    const wrap = document.createElement('div');
    const row = document.createElement('div');
    const chevronButton = document.createElement('button');
    chevronButton.type = 'button';
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
    chevronButton.addEventListener('pointerdown', ev => { ev.preventDefault(); ev.stopPropagation(); });
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
      ev.preventDefault();
      ev.stopPropagation();
      if (record.hasChildren) setBodyExpanded(record, !record.expanded);
    });
    row.addEventListener('pointerdown', ev => { ev.preventDefault(); ev.stopPropagation(); });
    row.addEventListener('click', ev => {
      ev.preventDefault();
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

    const cachedThumbnail = thumbnailCache.get(record.linkName) || thumbnailCache.get(record.thumbnailKey) || '';
    if (typeof cachedThumbnail === 'string' && /^data:image\//i.test(cachedThumbnail) && cachedThumbnail.length > 64) {
      thumb.src = cachedThumbnail;
      thumb.dataset.thumbnailReady = '1';
    }
    setBodyExpanded(record, record.hasChildren && (expandByDefault || expandedBodies.has(record.linkName)));
    if (thumb.dataset.thumbnailReady !== '1') thumbnailJobs.push({ record, img: thumb, thumbnailKey: record.thumbnailKey });
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
      margin: '18px 0 8px', fontSize: '10px', fontWeight: '900', letterSpacing: '.08em',
      textTransform: 'uppercase', color: '#0f766e'
    });
    return el;
  }

  function infoRow(label, value) {
    const row = document.createElement('div');
    const left = document.createElement('div');
    const right = document.createElement('div');
    Object.assign(row.style, {
      display: 'grid', gridTemplateColumns: '150px minmax(0,1fr)', gap: '14px', padding: '9px 0',
      borderBottom: `1px solid ${theme.stroke}`
    });
    left.textContent = label;
    right.textContent = value ?? '—';
    Object.assign(left.style, { color: theme.textMuted, fontWeight: '750', fontSize: '11px' });
    Object.assign(right.style, { color: theme.text, fontWeight: '750', fontSize: '11px', overflowWrap: 'anywhere' });
    row.append(left, right);
    return row;
  }

  function jointType(joint) {
    const type = String(joint?.jointType || joint?.type || '').toLowerCase();
    if (type === 'hinge' || type === 'revolute') return 'Revolute';
    if (type === 'slide' || type === 'prismatic') return 'Prismatic';
    if (type === 'ball' || type === 'spherical') return 'Spherical';
    if (type === 'free') return 'Free';
    if (type === 'fixed') return 'Fixed';
    return type ? type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Fixed';
  }
  const JOINT_CLASS_COLORS = Object.freeze({
    Revolute: '#ef4444',
    Prismatic: '#2563eb',
    Spherical: '#8b5cf6',
    Free: '#f59e0b',
    Cylindrical: '#14b8a6',
    Planar: '#06b6d4',
    Screw: '#ec4899',
    Universal: '#84cc16',
    Fixed: '#64748b',
    Other: '#0ea5a6'
  });
  const RELATION_COLORS = Object.freeze({
    parent: '#2563eb',
    child: '#ef4444'
  });
  function jointClassName(joint) {
    const label = jointType(joint);
    if (/revolute|hinge|continuous/i.test(label)) return 'Revolute';
    if (/prismatic|slide/i.test(label)) return 'Prismatic';
    if (/spherical|ball/i.test(label)) return 'Spherical';
    if (/free/i.test(label)) return 'Free';
    if (/cylindrical/i.test(label)) return 'Cylindrical';
    if (/planar/i.test(label)) return 'Planar';
    if (/screw|helical/i.test(label)) return 'Screw';
    if (/universal/i.test(label)) return 'Universal';
    if (/fixed/i.test(label)) return 'Fixed';
    return 'Other';
  }
  function jointColor(joint) { return JOINT_CLASS_COLORS[jointClassName(joint)] || JOINT_CLASS_COLORS.Other; }
  function capsule(text, color, options = {}) {
    const badge = document.createElement('span');
    const strong = options.strong !== false;
    badge.textContent = String(text || '—');
    Object.assign(badge.style, {
      display: 'inline-flex', alignItems: 'center', width: 'fit-content', maxWidth: '100%',
      padding: options.padding || '3px 8px', borderRadius: '999px',
      border: `${strong ? '1.5px' : '1px'} solid ${color}`,
      background: `${color}${strong ? '20' : '14'}`, color,
      fontSize: options.fontSize || '9px', fontWeight: '900', letterSpacing: '.02em',
      overflowWrap: 'anywhere'
    });
    return badge;
  }
  function relationshipBadge(text, relationship) {
    const color = relationship === 'child' ? RELATION_COLORS.child : RELATION_COLORS.parent;
    return capsule(text, color, { strong: true });
  }
  function jointBadge(joint, text = null) {
    return capsule(text || jointType(joint), jointColor(joint), { strong: true });
  }

  function relationshipChipsRow(label, values, color) {
    const row = document.createElement('div');
    const left = document.createElement('div');
    const right = document.createElement('div');
    Object.assign(row.style, {
      display: 'grid', gridTemplateColumns: '150px minmax(0,1fr)', gap: '14px', padding: '9px 0',
      borderBottom: `1px solid ${theme.stroke}`
    });
    left.textContent = label;
    Object.assign(left.style, { color: theme.textMuted, fontWeight: '750', fontSize: '11px' });
    Object.assign(right.style, { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', minWidth: '0' });
    const list = Array.isArray(values) ? values.filter(Boolean) : [values].filter(Boolean);
    if (!list.length) {
      const empty = document.createElement('span');
      empty.textContent = 'None';
      Object.assign(empty.style, { color: theme.textMuted, fontWeight: '750', fontSize: '11px' });
      right.appendChild(empty);
    } else {
      for (const value of list) {
        const chip = document.createElement('span');
        chip.textContent = String(value);
        Object.assign(chip.style, {
          display: 'inline-flex', alignItems: 'center', maxWidth: '100%', padding: '4px 9px', borderRadius: '999px',
          border: `1px solid ${color}`, background: `${color}18`, color, fontSize: '10px', fontWeight: '900',
          overflowWrap: 'anywhere'
        });
        right.appendChild(chip);
      }
    }
    row.append(left, right);
    return row;
  }
  function jointDOF(joint) {
    const type = String(joint?.jointType || joint?.type || '').toLowerCase();
    if (type === 'free') return 6;
    if (type === 'ball' || type === 'spherical') return 3;
    if (['hinge','revolute','slide','prismatic'].includes(type)) return 1;
    return 0;
  }
  function vecText(value) {
    const arr = value?.isVector3 ? [value.x, value.y, value.z] : (Array.isArray(value) ? value : []);
    return arr.length ? arr.slice(0, 3).map(v => Number(v).toFixed(4).replace(/\.?0+$/, '')).join(', ') : '—';
  }
  function rangeText(joint) {
    const lo = Number(joint?.lower), hi = Number(joint?.upper);
    if (!Number.isFinite(lo) && !Number.isFinite(hi)) return 'Unlimited';
    const type = String(joint?.jointType || joint?.type || '').toLowerCase();
    const angular = type === 'hinge' || type === 'revolute';
    const fmt = v => Number.isFinite(v) ? (angular ? `${(v * 180 / Math.PI).toFixed(2)}°` : Number(v).toFixed(5).replace(/\.?0+$/, '')) : '∞';
    return `${fmt(lo)} … ${fmt(hi)}`;
  }
  function valueText(joint) {
    const type = String(joint?.jointType || joint?.type || '').toLowerCase();
    const value = Number(joint?.value ?? joint?.angle ?? joint?.position);
    if (!Number.isFinite(value)) return '—';
    if (type === 'hinge' || type === 'revolute') return `${(value * 180 / Math.PI).toFixed(2)}° (${value.toFixed(5)} rad)`;
    return value.toFixed(5).replace(/\.?0+$/, '');
  }
  function jointCard(joint) {
    const card = document.createElement('div');
    const header = document.createElement('div');
    const relation = relationshipBadge(joint?.name || 'Fixed to parent', 'parent');
    const typeBadge = jointBadge(joint);
    const grid = document.createElement('div');
    const color = jointColor(joint);
    Object.assign(card.style, {
      padding: '11px 12px', margin: '7px 0', border: `1px solid ${theme.stroke}`,
      borderLeft: `6px solid ${color}`, borderRadius: '13px', background: '#fff'
    });
    Object.assign(header.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      flexWrap: 'wrap', gap: '7px 10px', marginBottom: '8px'
    });
    header.append(relation, typeBadge);
    Object.assign(grid.style, { display: 'grid', gridTemplateColumns: '105px minmax(0,1fr)', gap: '5px 10px', fontSize: '10px' });
    const add = (label, value) => {
      const l = document.createElement('div'); const v = document.createElement('div');
      l.textContent = label; v.textContent = value;
      Object.assign(l.style, { color: theme.textMuted, fontWeight: '750' });
      Object.assign(v.style, { color: theme.text, fontWeight: '750', overflowWrap: 'anywhere' });
      grid.append(l, v);
    };
    add('Class color', color.toUpperCase());
    add('Degrees of freedom', String(jointDOF(joint)));
    add('Axis', vecText(joint?.axis));
    add('Range', rangeText(joint));
    add('Current value', valueText(joint));
    card.append(header, grid);
    return card;
  }
  function childConnectionCard(connection) {
    const card = document.createElement('div');
    const heading = relationshipBadge(connection?.name || connection?.linkName || 'Child', 'child');
    const badges = document.createElement('div');
    const joints = Array.isArray(connection?.joints) ? connection.joints : [];
    const mainColor = joints.length ? jointColor(joints[0]) : JOINT_CLASS_COLORS.Fixed;
    Object.assign(card.style, {
      display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', alignItems: 'center', gap: '12px',
      padding: '10px 12px', margin: '7px 0', border: `1px solid ${theme.stroke}`,
      borderLeft: `6px solid ${mainColor}`, borderRadius: '13px', background: '#fff'
    });
    Object.assign(badges.style, { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', gap: '5px' });
    if (joints.length) joints.forEach(joint => badges.appendChild(jointBadge(joint)));
    else badges.appendChild(jointBadge({ type: 'fixed' }, 'Fixed'));
    const dof = document.createElement('span');
    dof.textContent = `${Math.max(0, Number(connection?.dof) || 0)} DOF`;
    Object.assign(dof.style, { color: theme.textMuted, fontSize: '9px', fontWeight: '850', padding: '3px 5px' });
    badges.appendChild(dof);
    card.append(heading, badges);
    return card;
  }


  function formatCount(value) {
    return Math.max(0, Number(value) || 0).toLocaleString('en-US');
  }
  function dimensionsText(value) {
    const values = Array.isArray(value) ? value.slice(0, 3).map(Number) : [];
    if (values.length < 3 || values.some(v => !Number.isFinite(v))) return '—';
    return values.map(v => v.toFixed(5).replace(/\.?0+$/, '')).join(' × ');
  }
  function geometryCard(titleText, rows = []) {
    const card = document.createElement('div');
    const title = document.createElement('div');
    const grid = document.createElement('div');
    Object.assign(card.style, {
      margin: '8px 0', padding: '11px 12px', border: `1px solid ${theme.stroke}`,
      borderRadius: '13px', background: '#fff'
    });
    title.textContent = titleText || 'Geometry';
    Object.assign(title.style, { fontWeight: '900', fontSize: '12px', color: theme.text, marginBottom: '8px', overflowWrap: 'anywhere' });
    Object.assign(grid.style, { display: 'grid', gridTemplateColumns: '145px minmax(0,1fr)', gap: '6px 11px' });
    for (const [label, rawValue] of rows) {
      const value = rawValue === null || rawValue === undefined || rawValue === '' ? '—' : String(rawValue);
      const left = document.createElement('div');
      const right = document.createElement('div');
      left.textContent = label;
      right.textContent = value;
      Object.assign(left.style, { color: theme.textMuted, fontWeight: '760', fontSize: '10px' });
      Object.assign(right.style, { color: theme.text, fontWeight: '760', fontSize: '10px', overflowWrap: 'anywhere' });
      grid.append(left, right);
    }
    card.append(title, grid);
    return card;
  }
  function technicalGeometryData(node = {}) {
    const geometry = node.geometry || {};
    const authored = Array.isArray(geometry.authored) ? geometry.authored : [];
    const assets = Array.isArray(node.assets) ? node.assets : [];
    const totals = assets.reduce((acc, asset) => {
      const stats = asset?.stats || {};
      acc.instances += Math.max(0, Number(stats.meshInstances ?? asset.count) || 0);
      acc.vertices += Math.max(0, Number(stats.vertices) || 0);
      acc.triangles += Math.max(0, Number(stats.triangles) || 0);
      acc.indexed += Math.max(0, Number(stats.indexedInstances) || 0);
      acc.normals += Math.max(0, Number(stats.normalInstances) || 0);
      acc.uvs += Math.max(0, Number(stats.uvInstances) || 0);
      acc.textured += Math.max(0, Number(stats.texturedInstances) || 0);
      return acc;
    }, { instances: 0, vertices: 0, triangles: 0, indexed: 0, normals: 0, uvs: 0, textured: 0 });
    return { geometry, authored, assets, totals };
  }
  function appendTechnicalGeometry(container, node) {
    const { geometry, authored, assets, totals } = technicalGeometryData(node);
    container.appendChild(sectionTitle('Technical geometry'));
    container.appendChild(infoRow('Authored MJCF geoms', formatCount(authored.length)));
    container.appendChild(infoRow('Visual geoms', formatCount(geometry.visualCount ?? authored.filter(g => !g.collisionOnly).length)));
    container.appendChild(infoRow('Collision-only geoms', formatCount(geometry.collisionCount ?? authored.filter(g => g.collisionOnly).length)));
    container.appendChild(infoRow('Loaded mesh instances', formatCount(totals.instances)));
    container.appendChild(infoRow('Vertices', formatCount(totals.vertices)));
    container.appendChild(infoRow('Triangles', formatCount(totals.triangles)));
    container.appendChild(infoRow('Indexed mesh instances', `${formatCount(totals.indexed)} / ${formatCount(totals.instances)}`));
    container.appendChild(infoRow('Meshes with normals', `${formatCount(totals.normals)} / ${formatCount(totals.instances)}`));
    container.appendChild(infoRow('Meshes with UV coordinates', `${formatCount(totals.uvs)} / ${formatCount(totals.instances)}`));
    container.appendChild(infoRow('Textured mesh instances', `${formatCount(totals.textured)} / ${formatCount(totals.instances)}`));

    if (assets.length) {
      for (const asset of assets) {
        const stats = asset?.stats || {};
        const fileName = `${asset.base || asset.assetKey || 'Visual'}${asset.ext ? '.' + asset.ext : ''}`;
        container.appendChild(geometryCard(fileName, [
          ['Asset key', asset.assetKey || '—'],
          ['Format', String(asset.ext || 'visual').toUpperCase()],
          ['Mesh instances', formatCount(stats.meshInstances ?? asset.count)],
          ['Vertices', formatCount(stats.vertices)],
          ['Triangles', formatCount(stats.triangles)],
          ['World-space dimensions', dimensionsText(stats.boundsSize)],
          ['Indexed instances', formatCount(stats.indexedInstances)],
          ['Normal attributes', formatCount(stats.normalInstances)],
          ['UV attributes', formatCount(stats.uvInstances)],
          ['Textured instances', formatCount(stats.texturedInstances)],
          ['Materials', Array.isArray(stats.materialNames) && stats.materialNames.length ? stats.materialNames.join(', ') : 'Not named'],
          ['Textures', Array.isArray(stats.textureNames) && stats.textureNames.length ? stats.textureNames.join(', ') : 'None']
        ]));
      }
    }

    if (authored.length) {
      for (const geom of authored) {
        const collision = !!geom.collisionOnly;
        const rows = [
          ['Role', collision ? 'Collision' : 'Visual'],
          ['Type', geom.type || '—'],
          ['Mesh asset', geom.mesh || 'Procedural primitive'],
          ['Material', geom.material || 'Inherited / default'],
          ['Class', geom.className || '—'],
          ['Local position', geom.position || '0 0 0'],
          ['Local quaternion (w x y z)', geom.quaternion || '1 0 0 0'],
          ['Size', geom.size || 'Defined by mesh'],
          ['RGBA override', geom.rgba || 'Inherited'],
          ['Group', geom.group || '0'],
          ['Collision type / affinity', [geom.contype, geom.conaffinity].filter(Boolean).join(' / ') || 'Inherited'],
          ['Contact dimensions', geom.condim || 'Inherited'],
          ['Friction', geom.friction || 'Inherited'],
          ['Density / mass', [geom.density && `density ${geom.density}`, geom.mass && `mass ${geom.mass}`].filter(Boolean).join(' · ') || 'Inherited'],
          ['Solver reference', geom.solref || 'Inherited'],
          ['Solver impedance', geom.solimp || 'Inherited']
        ];
        container.appendChild(geometryCard(geom.name || 'MJCF geom', rows));
      }
    } else if (!assets.length) {
      container.appendChild(infoRow('Geometry source', 'Procedural, inherited or unavailable'));
    }
  }

  function componentSheetSections(record) {
    const node = record?.node || {};
    const parent = record?.ancestors?.length ? record.ancestors[record.ancestors.length - 1] : null;
    const children = Array.isArray(node.children) ? node.children : [];
    const directJoints = Array.isArray(node.directJoints) ? node.directJoints : [];
    const childConnections = Array.isArray(node.childConnections) ? node.childConnections : [];
    const physics = node.physics || {};
    const { geometry, authored, assets, totals } = technicalGeometryData(node);
    const sections = [];
    sections.push({ title: 'Overview', rows: [
      ['Parent body', parent?.node?.name || parent?.linkName || 'Root'],
      ['Child bodies', children.length ? children.map(c => c.name || c.linkName).join(', ') : 'None'],
      ['Contained objects', formatCount(node.objectCount ?? node.directMeshCount)],
      ['Direct joints', formatCount(directJoints.length)],
      ['Direct degrees of freedom', formatCount(node.directDOF)],
      ['Joints in subtree', formatCount(node.subtreeJointCount)],
      ['Degrees of freedom in subtree', formatCount(node.subtreeDOF)]
    ]});
    if (directJoints.length) {
      for (const joint of directJoints) sections.push({ title: `Joint to parent · ${joint.name || jointType(joint)}`, color: RELATION_COLORS.parent, rows: [
        ['Type', jointType(joint)], ['Degrees of freedom', String(jointDOF(joint))], ['Axis', vecText(joint.axis)],
        ['Range', rangeText(joint)], ['Current value', valueText(joint)]
      ]});
    } else sections.push({ title: 'Joints to parent', color: RELATION_COLORS.parent, rows: [['Connection', 'Fixed to parent'], ['Class color', JOINT_CLASS_COLORS.Fixed.toUpperCase()], ['Degrees of freedom', '0']] });
    sections.push({ title: 'Child connections', color: RELATION_COLORS.child, rows: childConnections.length
      ? childConnections.map(connection => [connection.name || connection.linkName || 'Child', `${connection.joints?.length ? connection.joints.map(jointType).join(' + ') : 'Fixed'} · ${connection.dof || 0} DOF`])
      : [['Connections', 'None']] });
    const physicsRows = [];
    if (physics.explicitInertial) {
      physicsRows.push(['Mass', Number.isFinite(Number(physics.mass)) ? `${Number(physics.mass).toFixed(6).replace(/\.?0+$/, '')} kg` : 'Not specified']);
      physicsRows.push(['Center of mass', vecText(physics.centerOfMass)]);
      if (physics.diagonalInertia) physicsRows.push(['Diagonal inertia', vecText(physics.diagonalInertia)]);
      if (physics.fullInertia) physicsRows.push(['Full inertia', physics.fullInertia.join(', ')]);
    } else physicsRows.push(['Inertial properties', 'Not explicitly authored in this body']);
    if (Number.isFinite(Number(physics.gravcomp))) physicsRows.push(['Gravity compensation', String(physics.gravcomp)]);
    if (physics.mocap) physicsRows.push(['Motion capture body', 'Yes']);
    sections.push({ title: 'Physics', rows: physicsRows });
    sections.push({ title: 'Technical geometry summary', rows: [
      ['Authored MJCF geoms', formatCount(authored.length)],
      ['Visual geoms', formatCount(geometry.visualCount ?? authored.filter(g => !g.collisionOnly).length)],
      ['Collision-only geoms', formatCount(geometry.collisionCount ?? authored.filter(g => g.collisionOnly).length)],
      ['Loaded mesh instances', formatCount(totals.instances)],
      ['Vertices', formatCount(totals.vertices)],
      ['Triangles', formatCount(totals.triangles)],
      ['Meshes with normals', `${formatCount(totals.normals)} / ${formatCount(totals.instances)}`],
      ['Meshes with UV coordinates', `${formatCount(totals.uvs)} / ${formatCount(totals.instances)}`],
      ['Textured mesh instances', `${formatCount(totals.textured)} / ${formatCount(totals.instances)}`]
    ]});
    for (const asset of assets) {
      const stats = asset.stats || {};
      sections.push({ title: `Geometry asset · ${asset.base || asset.assetKey || 'Visual'}`, rows: [
        ['File', `${asset.base || asset.assetKey || 'Visual'}${asset.ext ? '.' + asset.ext : ''}`],
        ['Asset key', asset.assetKey || '—'], ['Format', String(asset.ext || 'visual').toUpperCase()],
        ['Mesh instances', formatCount(stats.meshInstances ?? asset.count)], ['Vertices', formatCount(stats.vertices)],
        ['Triangles', formatCount(stats.triangles)], ['World-space dimensions', dimensionsText(stats.boundsSize)],
        ['Materials', Array.isArray(stats.materialNames) && stats.materialNames.length ? stats.materialNames.join(', ') : 'Not named'],
        ['Textures', Array.isArray(stats.textureNames) && stats.textureNames.length ? stats.textureNames.join(', ') : 'None']
      ]});
    }
    for (const geom of authored) sections.push({ title: `MJCF geom · ${geom.name || 'Geometry'}`, rows: [
      ['Role', geom.collisionOnly ? 'Collision' : 'Visual'], ['Type', geom.type || '—'],
      ['Mesh asset', geom.mesh || 'Procedural primitive'], ['Material', geom.material || 'Inherited / default'],
      ['Local position', geom.position || '0 0 0'], ['Local quaternion', geom.quaternion || '1 0 0 0'],
      ['Size', geom.size || 'Defined by mesh'], ['RGBA', geom.rgba || 'Inherited'], ['Group', geom.group || '0'],
      ['Collision type / affinity', [geom.contype, geom.conaffinity].filter(Boolean).join(' / ') || 'Inherited'],
      ['Friction', geom.friction || 'Inherited'], ['Density / mass', [geom.density, geom.mass].filter(Boolean).join(' / ') || 'Inherited']
    ]});
    return sections;
  }

  function wrapCanvasText(ctx, text, maxWidth) {
    const words = String(text ?? '—').split(/\s+/);
    const lines = [];
    let line = '';
    for (const word of words) {
      const trial = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(trial).width > maxWidth) { lines.push(line); line = word; }
      else line = trial;
    }
    if (line) lines.push(line);
    return lines.length ? lines : ['—'];
  }
  async function imageFromSource(source) {
    return new Promise(resolve => {
      if (!source) return resolve(null);
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = source;
    });
  }
  async function downloadTechnicalSheet(record) {
    if (!record?.node) return false;
    const node = record.node;
    const sections = componentSheetSections(record);
    const width = 2200;
    const margin = 130;
    const labelWidth = 470;
    const contentWidth = width - margin * 2;
    const estimateLines = sections.reduce((sum, section) => sum + 2 + section.rows.reduce((n, row) => n + Math.max(1, Math.ceil(String(row[1] ?? '').length / 72)), 0), 0);
    const height = Math.max(1800, Math.min(12000, 700 + estimateLines * 62 + sections.length * 92));
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f4f8f9'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#0ea5a6'; ctx.fillRect(0, 0, width, 300);
    ctx.fillStyle = '#ffffff'; ctx.font = '900 66px Arial';
    const componentName = node.name || record.linkName || 'Component';
    ctx.fillText('AutoMind · Component technical sheet', margin, 105);
    ctx.font = '800 48px Arial';
    const nameLines = wrapCanvasText(ctx, componentName, contentWidth - 480);
    nameLines.slice(0, 2).forEach((line, index) => ctx.fillText(line, margin + 440, 205 + index * 54));
    ctx.font = '500 25px Arial'; ctx.fillStyle = 'rgba(255,255,255,.86)';
    const pathNames = [...(record.ancestors || []).map(a => a.node?.name || a.linkName).filter(Boolean), componentName];
    ctx.fillText(pathNames.join('  ›  ').slice(0, 130), margin + 440, 275);
    const image = await imageFromSource(record.thumb?.src || thumbnailCache.get(record.linkName) || '');
    if (image) {
      ctx.fillStyle = '#ffffff'; ctx.fillRect(margin, 135, 360, 220);
      const scale = Math.min(340 / image.width, 200 / image.height);
      const iw = image.width * scale, ih = image.height * scale;
      ctx.drawImage(image, margin + (360 - iw) / 2, 145 + (200 - ih) / 2, iw, ih);
    }
    let y = 410;
    for (const section of sections) {
      const sectionColor = section.color || '#0f766e';
      ctx.fillStyle = sectionColor; ctx.font = '900 30px Arial';
      if (section.color) { ctx.fillRect(margin, y - 24, 18, 18); }
      ctx.fillText(String(section.title || '').toUpperCase(), margin + (section.color ? 32 : 0), y);
      y += 28;
      ctx.fillStyle = '#ffffff';
      const sectionStart = y;
      y += 24;
      for (const [label, rawValue] of section.rows || []) {
        ctx.font = '700 24px Arial';
        const lines = wrapCanvasText(ctx, rawValue, contentWidth - labelWidth - 70);
        const rowHeight = Math.max(62, lines.length * 31 + 24);
        ctx.fillStyle = (Math.floor((y - sectionStart) / 62) % 2 === 0) ? '#ffffff' : '#f8fbfb';
        ctx.fillRect(margin, y - 17, contentWidth, rowHeight);
        ctx.fillStyle = '#64748b'; ctx.font = '700 22px Arial'; ctx.fillText(String(label), margin + 24, y + 19);
        ctx.fillStyle = '#102a2b'; ctx.font = '700 23px Arial';
        lines.forEach((line, index) => ctx.fillText(line, margin + labelWidth, y + 19 + index * 31));
        y += rowHeight;
      }
      ctx.strokeStyle = '#cbdfe0'; ctx.lineWidth = 2; ctx.strokeRect(margin, sectionStart, contentWidth, y - sectionStart);
      y += 64;
    }
    ctx.fillStyle = '#64748b'; ctx.font = '500 20px Arial';
    ctx.fillText(`Generated ${new Date().toLocaleString()}`, margin, Math.min(height - 45, y + 10));
    const outputHeight = Math.min(height, Math.max(1000, y + 90));
    const output = document.createElement('canvas'); output.width = width; output.height = outputHeight;
    output.getContext('2d').drawImage(canvas, 0, 0, width, outputHeight, 0, 0, width, outputHeight);
    const blob = await new Promise(resolve => output.toBlob(resolve, 'image/png'));
    if (!blob) return false;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${componentName.replace(/[^a-z0-9._-]+/gi, '_') || 'component'}_technical_sheet.png`;
    anchor.style.display = 'none'; document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    return true;
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
    heading.append(name, path); hero.append(img, heading); ui.detailView.appendChild(hero);

    const parent = record.ancestors?.length ? record.ancestors[record.ancestors.length - 1] : null;
    const children = Array.isArray(node.children) ? node.children : [];
    const directJoints = Array.isArray(node.directJoints) ? node.directJoints : [];
    const childConnections = Array.isArray(node.childConnections) ? node.childConnections : [];
    const physics = node.physics || null;
    const geometry = node.geometry || null;
    const assets = Array.isArray(node.assets) ? node.assets : [];

    ui.detailView.appendChild(sectionTitle('Overview'));
    ui.detailView.appendChild(relationshipChipsRow('Parent body', [parent?.node?.name || parent?.linkName || 'Root'], RELATION_COLORS.parent));
    ui.detailView.appendChild(relationshipChipsRow('Child bodies', children.map(c => c.name || c.linkName).filter(Boolean), RELATION_COLORS.child));
    ui.detailView.appendChild(infoRow('Contained objects', String(Math.max(0, Number(node.objectCount ?? node.directMeshCount) || 0))));
    ui.detailView.appendChild(infoRow('Direct joints', String(directJoints.length)));
    ui.detailView.appendChild(infoRow('Direct degrees of freedom', String(Math.max(0, Number(node.directDOF) || 0))));
    ui.detailView.appendChild(infoRow('Joints in subtree', String(Math.max(0, Number(node.subtreeJointCount) || 0))));
    ui.detailView.appendChild(infoRow('Degrees of freedom in subtree', String(Math.max(0, Number(node.subtreeDOF) || 0))));

    ui.detailView.appendChild(sectionTitle('Joints to parent'));
    if (directJoints.length) directJoints.forEach(joint => ui.detailView.appendChild(jointCard(joint)));
    else ui.detailView.appendChild(jointCard({ name: 'Fixed to parent', type: 'fixed' }));

    ui.detailView.appendChild(sectionTitle('Child connections'));
    if (childConnections.length) {
      for (const connection of childConnections) ui.detailView.appendChild(childConnectionCard(connection));
    } else ui.detailView.appendChild(infoRow('Connections', 'None'));

    ui.detailView.appendChild(sectionTitle('Physics'));
    if (physics?.explicitInertial) {
      ui.detailView.appendChild(infoRow('Mass', Number.isFinite(Number(physics.mass)) ? `${Number(physics.mass).toFixed(6).replace(/\.?0+$/, '')} kg` : 'Not specified'));
      ui.detailView.appendChild(infoRow('Center of mass', vecText(physics.centerOfMass)));
      if (physics.diagonalInertia) ui.detailView.appendChild(infoRow('Diagonal inertia', vecText(physics.diagonalInertia)));
      if (physics.fullInertia) ui.detailView.appendChild(infoRow('Full inertia', physics.fullInertia.map(v => Number(v).toFixed(6).replace(/\.?0+$/, '')).join(', ')));
    } else {
      ui.detailView.appendChild(infoRow('Inertial properties', 'Not explicitly authored in this body'));
    }
    if (Number.isFinite(Number(physics?.gravcomp))) ui.detailView.appendChild(infoRow('Gravity compensation', String(physics.gravcomp)));
    if (physics?.mocap) ui.detailView.appendChild(infoRow('Motion capture body', 'Yes'));

    ui.detailView.appendChild(sectionTitle('Visual geometry'));
    ui.detailView.appendChild(infoRow('Direct visual objects', String(Math.max(0, Number(node.directMeshCount) || 0))));
    ui.detailView.appendChild(infoRow('Visual asset files', String(assets.length)));
    appendTechnicalGeometry(ui.detailView, node);
  }

  async function loadThumbnailJob(job, generation) {
    if (disposed || generation !== thumbnailGeneration || !job?.img?.isConnected) return false;
    try {
      const source = app.assets.bodyThumbnail?.(job.record.linkName) || app.assets.thumbnail?.(job.thumbnailKey);
      const url = await promiseWithTimeout(Promise.resolve(source), 12000, '');
      if (disposed || generation !== thumbnailGeneration || !job.img.isConnected) return false;
      if (typeof url === 'string' && /^data:image\//i.test(url) && url.length > 64) {
        job.img.src = url;
        job.img.dataset.thumbnailReady = '1';
        thumbnailCache.set(job.record.linkName, url);
        publishThumbnailCache();
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
      const workerCount = Math.min(1, queue.length);
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
    if (showDetails) {
      try { app.startComponentInspection?.(record.linkName, childLinkNames(record)); } catch (_) {}
    }
    if (reveal) revealRecord(record, true);
    if (showDetails) showDetail(record);
    if (openPanel) setPanelOpen(true);
    return true;
  }

  function selectComponent(_assetKey = '', linkName = '', options = {}) {
    return linkName ? selectBody(linkName, options) : false;
  }

  function showAllAndClearSelection({ clearChildHighlights = false } = {}) {
    try { app.showAll?.(); } catch (_) {}
    try { app.clearSelection?.(); app.interaction?.clearHover?.(); } catch (_) {}
    if (clearChildHighlights) {
      try { app.endComponentInspection?.(); } catch (_) {}
    }
    clearSelectionBubble();
  }
  function returnToTreeAndShowAll() {
    showAllAndClearSelection({ clearChildHighlights: true });
    showTree({ revealSelection: false });
  }

  ui.btn.addEventListener('pointerdown', ev => { ev.preventDefault(); ev.stopPropagation(); });
  ui.btn.addEventListener('click', ev => {
    ev.preventDefault();
    ev.stopPropagation();
    if (open) setPanelOpen(false);
    else {
      showTree();
      setPanelOpen(true);
    }
  });
  ui.backBtn.addEventListener('pointerdown', ev => { ev.preventDefault(); ev.stopPropagation(); });
  ui.backBtn.addEventListener('click', ev => {
    ev.preventDefault();
    ev.stopPropagation();
    returnToTreeAndShowAll();
  });
  ui.downloadSheetBtn.addEventListener('pointerdown', ev => { ev.preventDefault(); ev.stopPropagation(); });
  ui.downloadSheetBtn.addEventListener('click', async ev => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!detailRecord) return;
    const oldText = ui.downloadSheetBtn.textContent;
    ui.downloadSheetBtn.disabled = true;
    ui.downloadSheetBtn.textContent = 'Preparing…';
    try { await downloadTechnicalSheet(detailRecord); }
    catch (error) { console.error('[Component technical sheet] failed:', error); alert('The technical sheet could not be downloaded.'); }
    finally { ui.downloadSheetBtn.disabled = false; ui.downloadSheetBtn.textContent = oldText; }
  });
  ui.showAllBtn.addEventListener('pointerdown', ev => { ev.preventDefault(); ev.stopPropagation(); });
  ui.showAllBtn.addEventListener('click', ev => {
    ev.preventDefault();
    ev.stopPropagation();
    showAllAndClearSelection({ clearChildHighlights: false });
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
        returnToTreeAndShowAll();
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
    try { app.endComponentInspection?.(); } catch (_) {}
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
    getThumbnailCache: () => Object.fromEntries(Array.from(thumbnailCache.entries()).filter(([key, value]) => !String(key).startsWith('__body__:') && typeof value === 'string' && /^data:image\//i.test(value))),
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
