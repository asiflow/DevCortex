/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Absolute origin of the DevCortex daemon API, e.g. "http://127.0.0.1:4823".
   * When unset the client uses relative "/api/*" paths, which resolve against
   * the origin that serves the dashboard (the daemon in production, the Vite
   * dev-server proxy in development).
   */
  readonly VITE_DEVCORTEX_API?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
