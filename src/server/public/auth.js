// Clerk bootstrap for the no-bundler SPA. Plain JS on purpose — it must run
// before any Babel-compiled page code and gate the whole app on auth state.
//
// Exposes:
//   window.authReady — Promise<Clerk> resolving once clerk-js is loaded.
//
// Also wraps window.fetch so every same-origin /api request carries the Clerk
// session token as a Bearer header. Dev instances (pk_test) don't set
// first-party cookies reliably, so header auth is the dependable path — and
// it covers every existing call site (api.js + the raw NDJSON fetches)
// without touching them.
(function () {
  function installFetchAuth() {
    const original = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const sameOrigin = url.startsWith('/') && !url.startsWith('//');
      if (!sameOrigin || !(url.startsWith('/api/') || url.startsWith('/auth/me'))) {
        return original(input, init);
      }
      let token = null;
      try {
        token = window.Clerk && window.Clerk.session
          ? await window.Clerk.session.getToken()
          : null;
      } catch (err) {
        console.warn('auth: getToken failed', err);
      }
      if (!token) return original(input, init);
      const opts = init ? { ...init } : {};
      const headers = new Headers(
        opts.headers || (typeof input !== 'string' && input.headers) || {},
      );
      headers.set('Authorization', 'Bearer ' + token);
      opts.headers = headers;
      return original(typeof input === 'string' ? input : url, opts);
    };
  }

  async function loadClerk() {
    const res = await fetch('/auth/config');
    if (!res.ok) throw new Error('auth config unavailable: HTTP ' + res.status);
    const { clerkPublishableKey } = await res.json();
    if (!clerkPublishableKey) {
      throw new Error('CLERK_PUBLISHABLE_KEY is not configured on the server');
    }

    // The publishable key encodes the frontend-API host (base64 of "host$"),
    // which is also the CDN that serves the matching clerk-js build.
    const encodedHost = clerkPublishableKey.split('_')[2] || '';
    const frontendApi = atob(encodedHost).replace(/\$$/, '');

    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://' + frontendApi + '/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.setAttribute('data-clerk-publishable-key', clerkPublishableKey);
      s.onload = resolve;
      s.onerror = () => reject(new Error('failed to load clerk-js from ' + frontendApi));
      document.head.appendChild(s);
    });

    await window.Clerk.load();
    installFetchAuth();
    return window.Clerk;
  }

  window.authReady = loadClerk();
})();
