// OpenCV.js is loaded with a plain <script async> tag. Depending on the build,
// window.cv is either a module that gains cv.Mat once its runtime is ready, or a
// real Promise that resolves to the module. Poll until cv.Mat exists.
export function loadOpenCv(timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    let awaiting = false;
    const tick = () => {
      const c = window.cv;
      if (c && c.Mat) {
        // The Emscripten module is a thenable that resolves to itself. Resolving a
        // Promise with it loops forever and freezes the page, so drop .then first.
        if (typeof c.then === 'function') delete c.then;
        resolve(c);
        return;
      }
      if (c instanceof Promise && !awaiting) {
        awaiting = true;
        c.then((m) => { window.cv = m; });
      }
      if (performance.now() - start > timeoutMs) {
        reject(new Error('OpenCV.js did not load'));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}
