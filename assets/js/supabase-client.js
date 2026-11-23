/* Lady K ★ Fih AdoptShop — Supabase browser client
 * This file contains only the public publishable key.
 * Never place the service_role or secret keys in browser code.
 */
(() => {
  'use strict';

  const SUPABASE_URL = 'https://nzobepexodnbirivsxtm.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_J7_Ys9E_KgK_L3BP5wyI6Q_krGP6ut_';

  if (!window.supabase?.createClient) {
    console.error('[Lady K ★ Fih] Supabase JS library did not load.');
    window.LKFBackend = {
      ready: false,
      error: 'Supabase library unavailable.',
    };
    return;
  }

  const client = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: { 'X-Client-Info': 'lady-k-fih-adoptshop-web' },
      },
    },
  );

  const TOKEN_KEY = 'lkf_admin_session_token';

  function getToken() {
    try {
      return sessionStorage.getItem(TOKEN_KEY) || '';
    } catch {
      return '';
    }
  }

  function setToken(token) {
    try {
      if (token) sessionStorage.setItem(TOKEN_KEY, token);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      throw new Error('This browser does not allow session storage.');
    }
  }

  async function invoke(functionName, body) {
    const { data, error } = await client.functions.invoke(functionName, {
      body,
    });

    if (error) {
      const message = data?.error || error.message || 'Request failed.';
      throw new Error(message);
    }

    if (!data?.ok) {
      throw new Error(data?.error || 'The server rejected the request.');
    }

    return data;
  }

  const backend = {
    ready: true,
    client,

    async login(password) {
      const result = await invoke('admin-auth', {
        action: 'login',
        password,
      });
      if (!result.token) throw new Error('The server did not return a session token.');
      setToken(result.token);
      return result;
    },

    async verify() {
      const token = getToken();
      if (!token) return false;

      try {
        const result = await invoke('admin-auth', {
          action: 'verify',
          token,
        });
        return result.authenticated === true;
      } catch {
        setToken('');
        return false;
      }
    },

    async logout() {
      const token = getToken();
      try {
        if (token) {
          await invoke('admin-auth', {
            action: 'logout',
            token,
          });
        }
      } finally {
        setToken('');
      }
    },

    async admin(action, params = {}) {
      const token = getToken();
      if (!token) throw new Error('Administrator session is missing.');

      return await invoke('admin-api', {
        ...params,
        action,
        token,
      });
    },

    async publicRequest(action, params = {}) {
      // Public submission endpoint will be added as a separate Edge Function.
      return await invoke('public-api', {
        ...params,
        action,
      });
    },

    clearLocalSession() {
      setToken('');
    },
  };

  window.LKFBackend = backend;
  console.info('[Lady K ★ Fih] Supabase client initialized.');
})();
