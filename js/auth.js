// F1: Microsoft 개인 계정 로그인과 토큰 자동 갱신 (MSAL.js, 리디렉션 방식)
import { CONFIG } from './config.js';

const msal = window.msal;

// 앱이 놓인 폴더 주소. Azure에 등록한 리디렉션 URI와 정확히 같아야 한다.
export const redirectUri = new URL('.', location.href).href;

let pca = null;
let account = null;

export async function initAuth() {
  pca = new msal.PublicClientApplication({
    auth: {
      clientId: CONFIG.clientId,
      authority: CONFIG.authority,
      redirectUri,
      postLogoutRedirectUri: redirectUri,
      navigateToLoginRequestUrl: false,
    },
    // 토큰은 이 브라우저에만 보관한다
    cache: { cacheLocation: 'localStorage' },
  });
  await pca.initialize();
  const result = await pca.handleRedirectPromise();
  account = result?.account ?? pca.getAllAccounts()[0] ?? null;
  if (account) pca.setActiveAccount(account);
  return account;
}

export function getAccount() {
  return account;
}

export function login() {
  return pca.loginRedirect({ scopes: CONFIG.scopes, prompt: 'select_account' });
}

export function logout() {
  return pca.logoutRedirect({ account });
}

// 만료된 토큰은 조용히 갱신하고, 다시 로그인이 필요할 때만 로그인 화면으로 보낸다
export async function getToken() {
  try {
    const result = await pca.acquireTokenSilent({ scopes: CONFIG.scopes, account });
    return result.accessToken;
  } catch (e) {
    if (e instanceof msal.InteractionRequiredAuthError) {
      await pca.acquireTokenRedirect({ scopes: CONFIG.scopes, account });
      return new Promise(() => {}); // 페이지가 로그인 화면으로 이동한다
    }
    throw e;
  }
}
