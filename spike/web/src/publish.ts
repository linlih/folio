declare global {
  interface Window {
    __results?: Record<string, unknown>;
    __TAURI_INTERNALS__?: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
  }
}

/** Publish a result for automation: window.__results and, in Tauri, a file. */
export async function publish(name: string, data: unknown) {
  window.__results = { ...(window.__results ?? {}), [name]: data };
  const ua = navigator.userAgent;
  const payload = { name, ua, at: new Date().toISOString(), data };
  await window.__TAURI_INTERNALS__?.invoke("save_results", { name, json: JSON.stringify(payload, null, 1) });
}
