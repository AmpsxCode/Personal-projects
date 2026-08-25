// One source of truth, shared by the Worker and the browser. Wrangler's bundler
// follows this relative import out of src/ at build time, and the browser loads
// the same file as a module, so there is no second copy to drift.
export * from '../public/shared/config.js';
