// /MJCF_Viewer/mjcf_viewer_main.js
// AutoMind BUILD244 MJCF entrypoint.
// THREE is loaded and verified before the modular viewer graph is imported.
// This is required for standalone HTML files opened through file://, where the
// browser does not guarantee execution order between external defer scripts and
// the inline module bootstrap.

const THREE_CLASSIC_CDNS = [
  'https://cdn.jsdelivr.net/npm/three@0.132.2/build/three.min.js',
  'https://unpkg.com/three@0.132.2/build/three.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r132/three.min.js'
];

let coreModulePromise = null;
export let Base64Images = [];

function hasUsableThree() {
  const T = globalThis.THREE;
  return !!(
    T &&
    typeof T.WebGLRenderer === 'function' &&
    typeof T.Scene === 'function' &&
    typeof T.EventDispatcher === 'function' &&
    typeof T.Group === 'function'
  );
}

function waitForThree(timeoutMs = 4000) {
  if (hasUsableThree()) return Promise.resolve(globalThis.THREE);
  const started = Date.now();
  return new Promise(resolve => {
    const poll = () => {
      if (hasUsableThree()) return resolve(globalThis.THREE);
      if (Date.now() - started >= timeoutMs) return resolve(null);
      setTimeout(poll, 25);
    };
    poll();
  });
}

function loadClassicScript(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (hasUsableThree()) return resolve(globalThis.THREE);

    const absoluteUrl = String(url || '');
    let script = Array.from(document.scripts || []).find(node => {
      try { return node.src === absoluteUrl || node.dataset?.automindThreeSrc === absoluteUrl; }
      catch (_) { return false; }
    });

    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(pollTimer);
      try { script?.removeEventListener('load', onLoad); } catch (_) {}
      try { script?.removeEventListener('error', onError); } catch (_) {}
    };
    const finish = (ok, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      ok ? resolve(value) : reject(value);
    };
    const onLoad = () => {
      if (hasUsableThree()) finish(true, globalThis.THREE);
      else finish(false, new Error(`Three.js loaded but global THREE is unavailable: ${absoluteUrl}`));
    };
    const onError = () => finish(false, new Error(`Could not load Three.js: ${absoluteUrl}`));

    if (!script) {
      script = document.createElement('script');
      script.src = absoluteUrl;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.referrerPolicy = 'no-referrer-when-downgrade';
      script.dataset.automindThreeSrc = absoluteUrl;
      (document.head || document.documentElement).appendChild(script);
    }

    script.addEventListener('load', onLoad, { once: true });
    script.addEventListener('error', onError, { once: true });

    const pollTimer = setInterval(() => {
      if (hasUsableThree()) finish(true, globalThis.THREE);
    }, 25);
    const timer = setTimeout(() => {
      if (hasUsableThree()) finish(true, globalThis.THREE);
      else finish(false, new Error(`Timed out loading Three.js: ${absoluteUrl}`));
    }, timeoutMs);
  });
}

async function ensureThreeGlobal() {
  // Give the host HTML's existing <script defer src="...three.min.js"> a chance
  // to finish first. If it does not, load Three.js explicitly and sequentially.
  const existing = await waitForThree(2500);
  if (existing) return existing;

  const errors = [];
  for (const url of THREE_CLASSIC_CDNS) {
    try {
      await loadClassicScript(url);
      if (hasUsableThree()) return globalThis.THREE;
    } catch (error) {
      errors.push(error);
    }
  }

  const detail = errors.map(error => error?.message || String(error)).join('\n');
  throw new Error(
    'Three.js could not be initialized before importing the MJCF viewer modules.' +
    (detail ? `\n\n${detail}` : '')
  );
}

async function loadCoreModule() {
  if (!coreModulePromise) {
    coreModulePromise = (async () => {
      await ensureThreeGlobal();
      // Import only after THREE exists. ViewerCore, MJCFCore and URDFPlusCore
      // define classes that extend THREE classes during module evaluation.
      const core = await import('./mjcf_viewer_main_core.js');
      if (!core || typeof core.render !== 'function') {
        throw new Error('MJCF viewer core loaded without render(opts).');
      }
      Base64Images = core.Base64Images || Base64Images;
      return core;
    })().catch(error => {
      coreModulePromise = null;
      throw error;
    });
  }
  return coreModulePromise;
}

export function render(opts = {}) {
  let innerApp = null;
  let pendingResize = null;
  let destroyed = false;

  const proxy = {
    ready: null,
    resize(...args) {
      pendingResize = args;
      return innerApp?.resize?.(...args);
    },
    destroy(...args) {
      destroyed = true;
      return innerApp?.destroy?.(...args);
    }
  };

  proxy.ready = (async () => {
    const core = await loadCoreModule();
    if (destroyed) return proxy;

    innerApp = core.render(opts);
    if (!innerApp) throw new Error('MJCF viewer core did not return an application object.');
    if (innerApp.ready && typeof innerApp.ready.then === 'function') await innerApp.ready;

    // Preserve stable proxy methods while exposing the complete application API.
    for (const key of Reflect.ownKeys(innerApp)) {
      if (key === 'ready' || key === 'resize' || key === 'destroy') continue;
      try { proxy[key] = innerApp[key]; } catch (_) {}
    }
    proxy.innerApp = innerApp;

    if (pendingResize && typeof innerApp.resize === 'function') {
      try { innerApp.resize(...pendingResize); } catch (_) {}
    }
    if (destroyed && typeof innerApp.destroy === 'function') {
      try { innerApp.destroy(); } catch (_) {}
    }
    Base64Images = core.Base64Images || Base64Images;
    return proxy;
  })();

  return proxy;
}

export default { render };
