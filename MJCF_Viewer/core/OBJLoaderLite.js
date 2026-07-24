// AutoMind local OBJ parser for Three.js r132.
// Parses the subset used by Inventor/MJCF CAD exports without loading third-party scripts.

const THREE = globalThis.THREE;

function indexValue(raw, length) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value === 0) return -1;
  return value > 0 ? value - 1 : length + value;
}

function parseVertexToken(token, positionCount, uvCount, normalCount) {
  const parts = String(token || '').split('/');
  return {
    v: indexValue(parts[0], positionCount),
    vt: parts.length > 1 && parts[1] !== '' ? indexValue(parts[1], uvCount) : -1,
    vn: parts.length > 2 && parts[2] !== '' ? indexValue(parts[2], normalCount) : -1
  };
}

export class OBJLoaderLite {
  constructor(manager = null) {
    this.manager = manager || THREE?.DefaultLoadingManager || null;
    this.materials = null;
  }

  setMaterials(materials) {
    this.materials = materials || null;
    return this;
  }

  parse(text) {
    if (!THREE?.BufferGeometry || !THREE?.Float32BufferAttribute || !THREE?.Mesh || !THREE?.Group) {
      throw new Error('[OBJLoaderLite] Three.js is unavailable.');
    }

    const vertices = [];
    const normals = [];
    const uvs = [];
    const outPositions = [];
    const outNormals = [];
    const outUvs = [];
    let emittedNormals = 0;
    let emittedUvs = 0;
    let objectName = '';

    const lines = String(text || '').replace(/\\\r?\n/g, '').split(/\r?\n/);

    const emit = ref => {
      const pi = ref.v * 3;
      if (ref.v < 0 || pi + 2 >= vertices.length) return false;
      outPositions.push(vertices[pi], vertices[pi + 1], vertices[pi + 2]);

      if (ref.vn >= 0) {
        const ni = ref.vn * 3;
        if (ni + 2 < normals.length) {
          outNormals.push(normals[ni], normals[ni + 1], normals[ni + 2]);
          emittedNormals++;
        } else {
          outNormals.push(0, 0, 0);
        }
      } else {
        outNormals.push(0, 0, 0);
      }

      if (ref.vt >= 0) {
        const ti = ref.vt * 2;
        if (ti + 1 < uvs.length) {
          outUvs.push(uvs[ti], uvs[ti + 1]);
          emittedUvs++;
        } else {
          outUvs.push(0, 0);
        }
      } else {
        outUvs.push(0, 0);
      }
      return true;
    };

    for (let line of lines) {
      line = line.trim();
      if (!line || line[0] === '#') continue;
      const firstSpace = line.search(/\s/);
      const keyword = firstSpace < 0 ? line : line.slice(0, firstSpace);
      const payload = firstSpace < 0 ? '' : line.slice(firstSpace + 1).trim();

      if (keyword === 'v') {
        const values = payload.split(/\s+/).map(Number);
        if (values.length >= 3 && values.slice(0, 3).every(Number.isFinite)) {
          vertices.push(values[0], values[1], values[2]);
        }
      } else if (keyword === 'vn') {
        const values = payload.split(/\s+/).map(Number);
        if (values.length >= 3 && values.slice(0, 3).every(Number.isFinite)) {
          normals.push(values[0], values[1], values[2]);
        }
      } else if (keyword === 'vt') {
        const values = payload.split(/\s+/).map(Number);
        if (values.length >= 2 && values.slice(0, 2).every(Number.isFinite)) {
          uvs.push(values[0], values[1]);
        }
      } else if (keyword === 'o' || keyword === 'g') {
        if (!objectName && payload) objectName = payload;
      } else if (keyword === 'f') {
        const tokens = payload.split(/\s+/).filter(Boolean);
        if (tokens.length < 3) continue;
        const refs = tokens.map(token => parseVertexToken(token, vertices.length / 3, uvs.length / 2, normals.length / 3));
        for (let i = 1; i + 1 < refs.length; i++) {
          const tri = [refs[0], refs[i], refs[i + 1]];
          if (tri.every(ref => ref.v >= 0)) tri.forEach(emit);
        }
      }
    }

    const group = new THREE.Group();
    group.name = objectName || 'OBJ';
    if (!outPositions.length) return group;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(outPositions, 3));
    if (emittedUvs > 0) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(outUvs, 2));
    if (emittedNormals === outPositions.length / 3) {
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(outNormals, 3));
    } else {
      geometry.computeVertexNormals();
    }
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const material = new THREE.MeshPhongMaterial({ color: 0xffffff, side: THREE.FrontSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = objectName || 'OBJMesh';
    group.add(mesh);
    return group;
  }
}

export function installOBJLoaderLite() {
  if (!THREE) throw new Error('[OBJLoaderLite] THREE is not defined.');
  if (!THREE.OBJLoader) THREE.OBJLoader = OBJLoaderLite;
  return THREE.OBJLoader;
}
