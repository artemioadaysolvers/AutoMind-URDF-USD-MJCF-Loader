// /USD_Viewer/interaction/SelectionAndDrag.js
// MJCF BUILD247 interaction: original translucent duplicate-geometry hover, indexed picking and nonblocking drag commits.
/* global THREE */


const THREE = globalThis.THREE;
const HOVER_COLOR = 0x0ea5a6;
const HOVER_OPACITY = 0.28;
const CHILD_HIGHLIGHT_COLOR = 0xff1744;
const CHILD_HIGHLIGHT_OPACITY = 0.58;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function isMovable(j) {
  const t = String(j?.jointType || j?.type || '').toLowerCase();
  if (!j || !t) return false;
  if (j.exportedMovable === true && !/FixedJoint/i.test(j.schema || '')) return true;
  if (/revolute|continuous|hinge|prismatic/i.test(t)) return true;
  if (/RevoluteJoint|PrismaticJoint/i.test(j.schema || '')) return true;
  return false;
}
function isPrismatic(j) { return /prismatic/i.test(String(j?.jointType || j?.type || '')) || /Prismatic/i.test(j?.schema || ''); }
function getJointValue(j) { return Number(j?.value ?? (isPrismatic(j) ? j?.position : j?.angle) ?? 0) || 0; }
function setJointValue(robot, j, v) {
  if (!robot || !j) return false;
  let ok = false;
  if (typeof j.setJointValue === 'function') { j.setJointValue(v); ok = true; }
  else if (typeof robot.setJointValue === 'function') ok = robot.setJointValue(j.name, v) !== false;
  // MJCFCore performs one full matrix propagation only after the constrained pose
  // is committed. Calling updateMatrixWorld again here duplicated the most
  // expensive visual-tree traversal on every pointer frame.
  if (ok && typeof robot._refreshLinkMatrices !== 'function') robot.updateMatrixWorld?.(true);
  return ok;
}
function collectMeshesInLink(linkObj) {
  const out = [];
  linkObj?.traverse?.(o => { if (o?.isMesh && o.geometry && !o.userData.__isHoverOverlay) out.push(o); });
  return out;
}
function materialList(mat) {
  if (!mat) return [];
  return Array.isArray(mat) ? mat.filter(Boolean) : [mat];
}
function meshOpacityForPicking(mesh) {
  const mats = materialList(mesh?.material);
  if (!mats.length) return 1;
  let best = 0;
  for (const m of mats) {
    if (!m) continue;
    const op = Number.isFinite(m.opacity) ? m.opacity : 1;
    best = Math.max(best, op);
  }
  return best;
}
function meshCandidateForRaycast(mesh) {
  if (!mesh || !mesh.isMesh || !mesh.geometry) return false;
  if (mesh.visible === false || mesh.userData?.__isHoverOverlay) return false;
  // Visibility transactions mark the logical final target immediately. During a
  // fade-out, the object may still be visually present for a few frames, but it
  // must already behave as non-pickable to avoid stale hover/click/drag states.
  if (mesh.userData?.__automindVisibilityTarget === false) return false;
  return meshOpacityForPicking(mesh) > 0.035;
}
function meshPickableNow(mesh, plane) {
  return meshCandidateForRaycast(mesh) && meshVisibleBySection(mesh, plane);
}
function linkPickableNow(link, plane, getMeshes = collectMeshesInLink) {
  return getMeshes(link).some(m => meshPickableNow(m, plane));
}
function computeUnionBox(meshes) {
  const box = new THREE.Box3(); let has = false; const tmp = new THREE.Box3();
  for (const m of meshes || []) { if (!m) continue; tmp.setFromObject(m); if (!has) { box.copy(tmp); has = true; } else box.union(tmp); }
  return has ? box : null;
}
function sectionKeepsPoint(point, plane, eps = 1e-7) {
  // Three.js material clipping keeps the positive side of a Plane and discards
  // fragments with negative signed distance. The raycaster does not know that,
  // so every hover/click/drag hit must pass this same half-space test manually.
  return !plane || !point || plane.distanceToPoint(point) >= -eps;
}
function boxHasAnyVisibleSideByPlane(box, plane, eps = 1e-7) {
  if (!box || !plane) return true;
  const min = box.min, max = box.max;
  const corners = [
    new THREE.Vector3(min.x, min.y, min.z), new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(min.x, max.y, min.z), new THREE.Vector3(min.x, max.y, max.z),
    new THREE.Vector3(max.x, min.y, min.z), new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(max.x, max.y, min.z), new THREE.Vector3(max.x, max.y, max.z)
  ];
  return corners.some(c => sectionKeepsPoint(c, plane, eps));
}

const __sectionVertexTmp = new THREE.Vector3();
function meshHasKeptGeometryBySection(mesh, plane, eps = 1e-7) {
  if (!plane) return true;
  if (!mesh || !mesh.geometry) return false;
  const pos = mesh.geometry.attributes?.position;
  if (!pos || !pos.count) return meshVisibleBySectionBBox(mesh, plane, eps);
  // Do not rely only on Box3 corners: long/thin CAD parts can have a bounding box
  // crossing the section plane even when every real triangle is clipped away.
  // Sample actual vertices in world space. If at least one real vertex is on the
  // kept side, the body is partially visible and can still be selected; if all
  // vertices are on the clipped side, it is fully hidden and must be unpickable.
  const count = pos.count;
  const step = Math.max(1, Math.floor(count / 768));
  for (let i = 0; i < count; i += step) {
    __sectionVertexTmp.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    if (sectionKeepsPoint(__sectionVertexTmp, plane, eps)) return true;
  }
  // Always check the last vertex too, in case the sampling step skipped a tiny end.
  __sectionVertexTmp.fromBufferAttribute(pos, count - 1).applyMatrix4(mesh.matrixWorld);
  return sectionKeepsPoint(__sectionVertexTmp, plane, eps);
}
function meshVisibleBySectionBBox(mesh, plane, eps = 1e-7) {
  if (!plane) return true;
  const box = new THREE.Box3().setFromObject(mesh);
  if (box.isEmpty()) return false;
  return boxHasAnyVisibleSideByPlane(box, plane, eps);
}
function meshVisibleBySection(mesh, plane) {
  if (!plane) return true;
  mesh.updateMatrixWorld?.(true);
  return meshHasKeptGeometryBySection(mesh, plane);
}
function pointVisibleBySection(point, plane, eps = 1e-6) {
  return sectionKeepsPoint(point, plane, eps);
}
function findAncestorLink(o, linkSet) { while (o) { if (linkSet.has(o)) return o; o = o.parent; } return null; }
function buildHoverOverlay({ color = HOVER_COLOR, opacity = HOVER_OPACITY, renderOrder = 9999, getSectionPlane = null, getMeshesInLink = collectMeshesInLink } = {}) {
  const overlays = [];
  function clear() {
    overlays.splice(0).forEach(o => {
      try { o.parent?.remove(o); o.material?.dispose?.(); } catch (_) {}
    });
  }
  function overlayFor(mesh) {
    if (!mesh?.isMesh || !mesh.geometry) return null;
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthTest: false,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: 1
    });
    const plane = typeof getSectionPlane === 'function' ? getSectionPlane() : null;
    if (plane) {
      mat.clippingPlanes = [plane];
      mat.clipIntersection = false;
      mat.needsUpdate = true;
    }
    const ov = new THREE.Mesh(mesh.geometry, mat);
    ov.renderOrder = renderOrder;
    ov.userData.__isHoverOverlay = true;
    ov.userData.__automindNonPickable = true;
    ov.raycast = () => {};
    return ov;
  }
  function showMesh(mesh) {
    const plane = typeof getSectionPlane === 'function' ? getSectionPlane() : null;
    if (!meshPickableNow(mesh, plane)) return;
    const ov = overlayFor(mesh);
    if (ov) { mesh.add(ov); overlays.push(ov); }
  }
  function showLink(link) {
    const plane = typeof getSectionPlane === 'function' ? getSectionPlane() : null;
    for (const m of getMeshesInLink(link)) {
      if (meshPickableNow(m, plane)) showMesh(m);
    }
  }
  return { clear, showMesh, showLink };
}

export function attachInteraction({ scene, camera, renderer, controls, robot, selectMode = 'link', getSectionPlane = null, onSelectLink = null, onKinematicCommit = null, invalidate = null }) {
  if (!scene || !camera || !renderer || !controls) throw new Error('[USD SelectionAndDrag] Missing core objects');
  let robotModel = robot || null;
  let linkSet = new Set(Object.values(robotModel?.links || {}));
  const getCamera = (typeof camera === 'function') ? camera : () => camera;
  const getPlane = (typeof getSectionPlane === 'function') ? getSectionPlane : () => null;
  const raycaster = new THREE.Raycaster();
  // three-mesh-bvh honors this flag when present; regular Three.js safely ignores it.
  raycaster.firstHitOnly = true;
  const pointerNdc = new THREE.Vector2();
  const requestRender = () => { try { if (typeof invalidate === 'function') invalidate(); } catch (_) {} };
  let selectableMeshes = [];
  let pickablesScratch = [];
  let meshToLink = new WeakMap();
  let linkMeshes = new Map();
  const worldPickBoxes = new WeakMap();
  const raycastCandidates = [];
  const singleObjectHits = [];
  const rayBoxPoint = new THREE.Vector3();
  const meshesForLink = (link) => linkMeshes.get(link) || [];
  const hover = buildHoverOverlay({ getSectionPlane: getPlane, getMeshesInLink: meshesForLink });
  const childHighlight = buildHoverOverlay({
    color: CHILD_HIGHLIGHT_COLOR,
    opacity: CHILD_HIGHLIGHT_OPACITY,
    renderOrder: 9998,
    getSectionPlane: getPlane,
    getMeshesInLink: meshesForLink
  });
  let lastHover = null;
  let selectedMeshes = [];
  let selectedLink = null;
  let selectionHelper = null;
  let isolated = false;
  let activeDrag = null;
  let pendingClickSelect = null;
  let lastHoverRaycastAt = 0;
  let hoverMoveRAF = 0;
  let pendingHoverMove = null;
  let dragCommitRAF = 0;
  let endingDrag = false;
  let destroyed = false;

  const dragPlane = new THREE.Plane();
  const dragAxisWorld = new THREE.Vector3();
  const dragPivotWorld = new THREE.Vector3();
  const dragPrevHit = new THREE.Vector3();
  const dragNewHit = new THREE.Vector3();
  const dragProjectedStart = new THREE.Vector3();
  const dragProjectedEnd = new THREE.Vector3();
  const dragTmp = new THREE.Vector3();
  const dragTmp2 = new THREE.Vector3();
  const dragArcU = new THREE.Vector3();
  const dragArcV = new THREE.Vector3();
  const dragArcCross = new THREE.Vector3();
  const dragRayPoint = new THREE.Vector3();

  function rebuildSelectableMeshIndex() {
    selectableMeshes = [];
    pickablesScratch = [];
    meshToLink = new WeakMap();
    linkMeshes = new Map();
    robotModel?.traverse?.((o) => {
      if (!o?.isMesh || !o.geometry || o.userData?.__isHoverOverlay) return;
      selectableMeshes.push(o);
      const linkName = linkNameFromObject(o);
      const link = linkName ? robotModel?.links?.[linkName] : findAncestorLink(o, linkSet);
      if (!link) return;
      meshToLink.set(o, link);
      const arr = linkMeshes.get(link) || [];
      arr.push(o);
      linkMeshes.set(link, arr);
    });
  }
  function setRobot(r) {
    hover.clear();
    childHighlight.clear();
    lastHover = null;
    isolated = false;
    robotModel = r;
    linkSet = new Set(Object.values(robotModel?.links || {}));
    rebuildSelectableMeshIndex();
    clearSelection();
    requestRender();
  }
  function ensureSelectionHelper() {
    if (!selectionHelper) {
      selectionHelper = new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(-.5,-.5,-.5), new THREE.Vector3(.5,.5,.5)), new THREE.Color(HOVER_COLOR));
      selectionHelper.visible = false; selectionHelper.renderOrder = 10001; scene.add(selectionHelper);
    }
    return selectionHelper;
  }
  function refreshSelectionMarker() {
    const h = ensureSelectionHelper();
    const plane = getPlane();
    const visibleMeshes = (selectedMeshes || []).filter(m => meshPickableNow(m, plane));
    const box = computeUnionBox(visibleMeshes);
    if (!box || !boxHasAnyVisibleSideByPlane(box, plane)) {
      h.visible = false;
      requestRender();
      return;
    }
    h.box.copy(box); h.updateMatrixWorld(true); h.visible = true;
    requestRender();
  }
  function setSelected(link, mesh = null) {
    selectedLink = link || null;
    if (selectMode === 'mesh' && mesh) selectedMeshes = [mesh];
    else selectedMeshes = link ? meshesForLink(link).slice() : [];
    refreshSelectionMarker();
  }
  function clearSelection() {
    childHighlight.clear();
    selectedMeshes = [];
    selectedLink = null;
    if (selectionHelper) selectionHelper.visible = false;
    requestRender();
  }
  function selectLink(linkOrName, { notify = true } = {}) {
    const link = typeof linkOrName === 'string' ? robotModel?.links?.[linkOrName] : linkOrName;
    if (!link) return false;
    setSelected(link);
    if (notify) {
      try { if (typeof onSelectLink === 'function') onSelectLink(link, { programmatic: true }); } catch (_) {}
    }
    return true;
  }
  function highlightLinks(linkNames = []) {
    childHighlight.clear();
    const names = Array.isArray(linkNames) ? linkNames : [linkNames];
    const shown = new Set();
    for (const value of names) {
      const link = typeof value === 'string' ? robotModel?.links?.[value] : value;
      if (!link || shown.has(link)) continue;
      shown.add(link);
      childHighlight.showLink(link);
    }
    requestRender();
    return shown.size;
  }
  function clearRelatedHighlights() {
    childHighlight.clear();
    requestRender();
  }
  function setPointerFromEvent(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointerNdc.x = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    pointerNdc.y = -(((ev.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
    raycaster.setFromCamera(pointerNdc, getCamera());
    return raycaster.ray.clone();
  }
  function linkNameFromObject(obj) {
    let o = obj;
    while (o) { if (o.userData?.__linkName) return o.userData.__linkName; o = o.parent; }
    return '';
  }
  function pickInfoFromPointer(ev) {
    const ray = setPointerFromEvent(ev);
    const plane = getPlane();

    // BUILD234 broad phase: sort meshes by the ray entry distance into their
    // transformed local bounding box, then triangle-test only candidates that
    // can still beat the closest real hit. This is especially important while
    // the mechanism is assembled, where many component bounds overlap onscreen.
    raycastCandidates.length = 0;
    for (const mesh of selectableMeshes) {
      if (!meshCandidateForRaycast(mesh)) continue;
      const geometry = mesh.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox?.();
      if (!geometry.boundingBox || geometry.boundingBox.isEmpty()) continue;

      let worldBox = worldPickBoxes.get(mesh);
      if (!worldBox) {
        worldBox = new THREE.Box3();
        worldPickBoxes.set(mesh, worldBox);
      }
      worldBox.copy(geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
      if (!ray.intersectBox(worldBox, rayBoxPoint)) continue;
      raycastCandidates.push({ mesh, entryDistance: ray.origin.distanceTo(rayBoxPoint) });
    }
    raycastCandidates.sort((a, b) => a.entryDistance - b.entryDistance);

    let best = null;
    for (const candidate of raycastCandidates) {
      if (best && candidate.entryDistance > best.hit.distance + 1e-6) break;
      singleObjectHits.length = 0;
      raycaster.intersectObject(candidate.mesh, false, singleObjectHits);
      for (const hit of singleObjectHits) {
        if (best && hit.distance >= best.hit.distance) break;
        if (!pointVisibleBySection(hit.point, plane)) continue;
        const link = meshToLink.get(hit.object) || findAncestorLink(hit.object, linkSet);
        if (!link || !meshCandidateForRaycast(hit.object)) continue;
        const linkName = linkNameFromObject(hit.object) || link.userData?.__linkName || link.name;
        best = { link, linkName, hit, ray };
        break;
      }
    }
    return best;
  }
  function getManipulableJointForLink(link) {
    if (!link || !robotModel) return null;
    const name = link.userData?.__linkName || link.name;
    if (typeof robotModel.getManipulableJointForLinkName === 'function') return robotModel.getManipulableJointForLinkName(name);
    let n = link;
    while (n) { const j = n.userData?.__joint; if (isMovable(j)) return j; n = n.parent; }
    return null;
  }
  function getJointWorldPivot(j) {
    if (robotModel?.getJointWorldPivot) return robotModel.getJointWorldPivot(j);
    return j?.getWorldPosition ? j.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();
  }
  function getJointWorldAxis(j) {
    if (robotModel?.getJointWorldAxis) return robotModel.getJointWorldAxis(j);
    const q = j?.getWorldQuaternion ? j.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
    return (j?.axis || new THREE.Vector3(1,0,0)).clone().normalize().applyQuaternion(q).normalize();
  }
  function getRevoluteDragDelta(j, startPoint, endPoint, initialGrabPoint) {
    dragAxisWorld.copy(getJointWorldAxis(j));
    dragPivotWorld.copy(getJointWorldPivot(j));
    dragPlane.setFromNormalAndCoplanarPoint(dragAxisWorld, dragPivotWorld);
    dragTmp.copy(getCamera().position).sub(initialGrabPoint).normalize();
    if (Math.abs(dragTmp.dot(dragPlane.normal)) > 0.3) {
      dragPlane.projectPoint(startPoint, dragProjectedStart);
      dragPlane.projectPoint(endPoint, dragProjectedEnd);
      dragProjectedStart.sub(dragPivotWorld); dragProjectedEnd.sub(dragPivotWorld);
      if (dragProjectedStart.lengthSq() < 1e-12 || dragProjectedEnd.lengthSq() < 1e-12) return 0;
      dragTmp.crossVectors(dragProjectedStart, dragProjectedEnd);
      const direction = Math.sign(dragTmp.dot(dragPlane.normal)) || 1;
      return direction * dragProjectedEnd.angleTo(dragProjectedStart);
    }
    dragTmp.set(0,0,-1).transformDirection(getCamera().matrixWorld);
    dragTmp.cross(dragPlane.normal).normalize();
    dragTmp2.subVectors(endPoint, startPoint);
    return dragTmp.dot(dragTmp2) * 4.0;
  }
  function getPrismaticDragDelta(j, startPoint, endPoint) {
    dragAxisWorld.copy(getJointWorldAxis(j));
    dragTmp.subVectors(endPoint, startPoint);
    return dragTmp.dot(dragAxisWorld);
  }
  function rayPointOnPlane(ray, plane, fallbackDistance, fallback, out = dragRayPoint) {
    if (ray && plane && ray.intersectPlane(plane, out)) return out;
    if (ray && Number.isFinite(fallbackDistance)) return ray.at(fallbackDistance, out);
    if (fallback) return out.copy(fallback);
    return out.set(0, 0, 0);
  }
  function signedArcDelta(pivot, axis, previous, next) {
    dragArcU.copy(previous).sub(pivot);
    dragArcV.copy(next).sub(pivot);
    dragArcU.addScaledVector(axis, -dragArcU.dot(axis));
    dragArcV.addScaledVector(axis, -dragArcV.dot(axis));
    if (dragArcU.lengthSq() < 1e-12 || dragArcV.lengthSq() < 1e-12) return 0;
    dragArcU.normalize(); dragArcV.normalize();
    return Math.atan2(dragArcCross.crossVectors(dragArcU, dragArcV).dot(axis), THREE.MathUtils.clamp(dragArcU.dot(dragArcV), -1, 1));
  }
  function startJointDrag(ev, pick) {
    if (!pick || ev.button !== 0) return false;
    const joint = getManipulableJointForLink(pick.link);
    if (!joint) return false;
    setSelected(pick.link, pick.hit?.object || null);
    // Capture the physical input plane once. Passive closure projection may move
    // the visible link, but pointer mapping cannot jump with its downstream frame.
    const pivot = getJointWorldPivot(joint).clone();
    const axis = getJointWorldAxis(joint).clone().normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(axis, pivot);
    const startPoint = rayPointOnPlane(pick.ray, plane, pick.hit.distance, pick.hit.point);
    activeDrag = {
      link: pick.link, linkName: pick.linkName, joint,
      type: isPrismatic(joint) ? 'prismatic' : 'revolute',
      hitDistance: pick.hit.distance, initialGrabPoint: pick.hit.point.clone(),
      inputPivot: pivot, inputAxis: axis, inputPlane: plane,
      lastInputPoint: startPoint.clone(),
      requestedInitialValue: getJointValue(joint), accumulatedDelta: 0,
      pendingTarget: null, nextPoint: startPoint.clone(), lastVisibilityCheckAt: 0,
      prevRay: pick.ray.clone()
    };
    robotModel?.beginInteractiveDrag?.(joint);
    controls.enabled = false;
    renderer.domElement.style.cursor = 'grabbing';
    try { renderer.domElement.setPointerCapture?.(ev.pointerId); } catch (_) {}
    return true;
  }

  function flushPendingJointCommit({ force = false } = {}) {
    if (dragCommitRAF) {
      cancelAnimationFrame(dragCommitRAF);
      dragCommitRAF = 0;
    }
    const d = activeDrag;
    if (!d || d.pendingTarget == null) return false;
    const desired = d.pendingTarget;
    d.pendingTarget = null;
    // Coalesced pointer events can be far apart when the solver consumed most of
    // a frame. Feed the mechanism bounded increments so warm-started loop closure
    // stays on the same assembly branch instead of receiving one large jump.
    const current = getJointValue(d.joint);
    // Even the final pointer-up commit stays bounded.  The previous Infinity
    // step could send one large command into the closure solver and make all
    // passive bodies jump at once.
    const maxStep = d.type === 'prismatic'
      ? (force ? 0.014 : 0.009)
      : (force ? 0.11 : 0.075);
    const target = current + clamp(desired - current, -maxStep, maxStep);
    const accepted = setJointValue(robotModel, d.joint, target);
    if (accepted) {
      if (Math.abs(desired - target) > 1e-8) d.pendingTarget = desired;
      if (typeof onKinematicCommit === 'function') {
        try { onKinematicCommit(robotModel, d.joint); } catch (_) {}
      } else {
        refreshSelectionMarker();
      }
    }
    if (!force && d.pendingTarget != null) schedulePendingJointCommit();
    return accepted;
  }

  function schedulePendingJointCommit() {
    if (destroyed || dragCommitRAF || !activeDrag) return;
    dragCommitRAF = requestAnimationFrame(() => {
      dragCommitRAF = 0;
      flushPendingJointCommit();
    });
  }

  function cancelActiveDrag(ev) {
    const d = activeDrag;
    if (!d || endingDrag) return;
    endingDrag = true;
    try {
      if (dragCommitRAF) { cancelAnimationFrame(dragCommitRAF); dragCommitRAF = 0; }
      if (hoverMoveRAF) { cancelAnimationFrame(hoverMoveRAF); hoverMoveRAF = 0; }
      pendingHoverMove = null;
      d.pendingTarget = null;
      // Clear the transaction before releasing pointer capture: some browsers fire
      // lostpointercapture synchronously from releasePointerCapture.
      activeDrag = null;
      pendingClickSelect = null;
      try { robotModel?.endInteractiveDrag?.(d.joint); } catch (_) {}
      try { renderer.domElement.releasePointerCapture?.(ev?.pointerId); } catch (_) {}
      controls.enabled = true;
      renderer.domElement.style.cursor = 'auto';
      try { if (typeof onKinematicCommit === 'function') onKinematicCommit(robotModel, d.joint); } catch (_) {}
    } finally {
      endingDrag = false;
    }
  }
  function updateJointDrag(ev) {
    const d = activeDrag; if (!d) return false;
    const planeNow = getPlane();
    // Section visibility is expensive because it samples CAD vertices. During a
    // drag it is checked only when clipping is active and at a low frequency.
    const now = performance.now();
    if (planeNow && now - d.lastVisibilityCheckAt > 140) {
      d.lastVisibilityCheckAt = now;
      if (d.link && !linkPickableNow(d.link, planeNow, meshesForLink)) {
        cancelActiveDrag(ev);
        clearSelection(); hover.clear(); lastHover = null;
        return false;
      }
    }
    if (pendingClickSelect) {
      const dx = Number(ev.clientX || 0) - pendingClickSelect.x;
      const dy = Number(ev.clientY || 0) - pendingClickSelect.y;
      if ((dx * dx + dy * dy) > 25) pendingClickSelect.moved = true;
    }
    const ray = setPointerFromEvent(ev);
    const nextPoint = rayPointOnPlane(ray, d.inputPlane, d.hitDistance, d.lastInputPoint, d.nextPoint);
    let delta = d.type === 'prismatic'
      ? dragTmp2.copy(nextPoint).sub(d.lastInputPoint).dot(d.inputAxis)
      : signedArcDelta(d.inputPivot, d.inputAxis, d.lastInputPoint, nextPoint);
    delta = clamp(delta, -(d.type === 'prismatic' ? 0.02 : 0.16), d.type === 'prismatic' ? 0.02 : 0.16);
    if (Number.isFinite(delta) && Math.abs(delta) > 1e-9) {
      d.accumulatedDelta += delta;
      d.pendingTarget = d.requestedInitialValue + d.accumulatedDelta;
      schedulePendingJointCommit();
    }
    d.lastInputPoint.copy(nextPoint);
    d.prevRay.copy(ray);
    return true;
  }

  function endJointDrag(ev) {
    if (!activeDrag || endingDrag) return;
    endingDrag = true;
    try {
      const joint = activeDrag?.joint || null;
      const pending = pendingClickSelect;
      pendingClickSelect = null;
      if (dragCommitRAF) { cancelAnimationFrame(dragCommitRAF); dragCommitRAF = 0; }

      // Commit at most one bounded final increment. Any remaining closure error is
      // reduced asynchronously by the model; pointer-up must never run a solver
      // loop on the browser's main thread.
      flushPendingJointCommit({ force: true });

      robotModel?.endInteractiveDrag?.(joint);
      try { if (typeof onKinematicCommit === 'function') onKinematicCommit(robotModel, joint); } catch (_) {}
      activeDrag = null;
      controls.enabled = true;
      renderer.domElement.style.cursor = 'auto';
      refreshSelectionMarker();
      if (pending && !pending.moved) {
        try { if (typeof onSelectLink === 'function') onSelectLink(pending.link, pending.pick); } catch (_) {}
      }
      try { renderer.domElement.releasePointerCapture?.(ev?.pointerId); } catch (_) {}
    } finally {
      endingDrag = false;
    }
  }
  function isolateSelected() {
    if (!robotModel || !selectedLink) return;
    if (isolated) {
      for (const mesh of selectableMeshes) mesh.visible = true;
      isolated = false;
      refreshSelectionMarker();
      requestRender();
      return;
    }
    const keep = new Set(meshesForLink(selectedLink));
    for (const mesh of selectableMeshes) mesh.visible = keep.has(mesh);
    isolated = true;
    refreshSelectionMarker();
    requestRender();
  }

  function processHoverMove(ev) {
    const planeNow = getPlane();
    if (lastHover && !linkPickableNow(lastHover, planeNow, meshesForLink)) {
      hover.clear();
      lastHover = null;
      renderer.domElement.style.cursor = 'auto';
      requestRender();
    }

    const now = performance.now();
    if (now - lastHoverRaycastAt < 40) return;
    lastHoverRaycastAt = now;

    const pick = pickInfoFromPointer(ev);
    const key = pick?.link || null;
    if (key !== lastHover) {
      hover.clear();
      lastHover = key;
      if (pick?.link) hover.showLink(pick.link);
      requestRender();
    }
    renderer.domElement.style.cursor = pick?.link
      ? (getManipulableJointForLink(pick.link) ? 'grab' : 'pointer')
      : 'auto';
  }

  function onMove(ev) {
    if (activeDrag) {
      ev.preventDefault();
      updateJointDrag(ev);
      return;
    }
    // Keep only the newest pointer position. Browser pointermove can fire much
    // faster than rendering; synchronous raycasts make the UI queue grow and lag.
    pendingHoverMove = {
      clientX: Number(ev.clientX || 0),
      clientY: Number(ev.clientY || 0),
      pointerId: ev.pointerId,
      pointerType: ev.pointerType
    };
    if (!hoverMoveRAF) {
      hoverMoveRAF = requestAnimationFrame(() => {
        hoverMoveRAF = 0;
        const latest = pendingHoverMove;
        pendingHoverMove = null;
        if (latest && !activeDrag && !destroyed) processHoverMove(latest);
      });
    }
  }

  function onLeave() {
    pendingHoverMove = null;
    if (hoverMoveRAF) {
      cancelAnimationFrame(hoverMoveRAF);
      hoverMoveRAF = 0;
    }
    if (lastHover) {
      hover.clear();
      lastHover = null;
      renderer.domElement.style.cursor = 'auto';
      requestRender();
    }
  }
  function onDown(ev) {
    if (ev.button !== 0) return;
    renderer.domElement.focus?.();
    const pick = pickInfoFromPointer(ev);
    if (!pick) { clearSelection(); return; }
    setSelected(pick.link, pick.hit?.object || null);
    if (startJointDrag(ev, pick)) {
      pendingClickSelect = { link: pick.link, pick, x: Number(ev.clientX || 0), y: Number(ev.clientY || 0), moved: false };
      ev.preventDefault(); ev.stopPropagation();
    } else {
      pendingClickSelect = null;
      try { if (typeof onSelectLink === 'function') onSelectLink(pick.link, pick); } catch (_) {}
    }
  }
  function onUp(ev) { if (activeDrag) { ev?.preventDefault?.(); endJointDrag(ev); } }
  function onLostPointerCapture(ev) { if (activeDrag && !endingDrag) endJointDrag(ev); }
  function onWindowBlur() { if (activeDrag && !endingDrag) endJointDrag(null); }
  function onVisibilityChange() { if (document.hidden && activeDrag && !endingDrag) endJointDrag(null); }
  function onKey(ev) { if (String(ev.key || '').toLowerCase() === 'i') isolateSelected(); }

  rebuildSelectableMeshIndex();
  renderer.domElement.tabIndex = 0;
  renderer.domElement.addEventListener('pointermove', onMove, { passive: false });
  renderer.domElement.addEventListener('pointerleave', onLeave, { passive: true });
  renderer.domElement.addEventListener('pointerdown', onDown, { passive: false });
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onUp, true);
  renderer.domElement.addEventListener('lostpointercapture', onLostPointerCapture, true);
  window.addEventListener('blur', onWindowBlur, true);
  document.addEventListener('visibilitychange', onVisibilityChange, true);
  window.addEventListener('keydown', onKey, true);

  return {
    setRobot,
    get selectedLink() { return selectedLink; },
    clearSelection,
    selectLink,
    clearHover() { hover.clear(); lastHover = null; requestRender(); },
    highlightLinks,
    clearRelatedHighlights,
    refreshSelectionMarker,
    destroy() {
      destroyed = true;
      if (dragCommitRAF) { cancelAnimationFrame(dragCommitRAF); dragCommitRAF = 0; }
      hover.dispose?.(); childHighlight.dispose?.(); if (selectionHelper) scene.remove(selectionHelper);
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.domElement.removeEventListener('pointerleave', onLeave);
      renderer.domElement.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      renderer.domElement.removeEventListener('lostpointercapture', onLostPointerCapture, true);
      window.removeEventListener('blur', onWindowBlur, true);
      document.removeEventListener('visibilitychange', onVisibilityChange, true);
      window.removeEventListener('keydown', onKey, true);
    }
  };
}
export default { attachInteraction };
