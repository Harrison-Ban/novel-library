// 앱 설치와 새 버전 반영 (F15)
// 새 버전이 준비되면: 앱을 연 직후라면 바로 적용하고, 사용 중이면 새로고침 알림을 띄운다.
import { h } from './ui.js';

const AUTO_APPLY_MS = 10_000;
let installPrompt = null;
let applying = false;

export function setupPwa({ isBusy, beforeReload }) {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
  });
  window.addEventListener('appinstalled', () => (installPrompt = null));

  // localhost 개발 중에는 옛 파일이 남지 않도록 쓰지 않는다
  if (!('serviceWorker' in navigator) || location.hostname === 'localhost') return;
  const openedAt = Date.now();
  const fresh = () => Date.now() - openedAt < AUTO_APPLY_MS;
  // 처음 설치할 때가 아니라, 이미 앱 파일을 쓰던 중에 새 버전이 넘겨받은 경우만 새로고침이 필요하다
  const hadController = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (applying) location.reload();
    else if (hadController && fresh() && !isBusy()) {
      applying = true;
      location.reload();
    } else if (hadController) showUpdateBanner(() => location.reload());
  });

  async function apply(worker) {
    if (applying) return;
    applying = true;
    try {
      await beforeReload?.();
    } finally {
      worker.postMessage('SKIP_WAITING');
    }
  }

  function onWaiting(worker) {
    if (fresh() && !isBusy()) apply(worker);
    else showUpdateBanner(() => apply(worker));
  }

  navigator.serviceWorker.register('sw.js').then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) onWaiting(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) onWaiting(worker);
      });
    });
    // 휴대폰에서 앱을 다시 꺼냈을 때도 새 버전을 확인한다
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch((e) => console.warn('서비스 워커 등록 실패', e));
}

function showUpdateBanner(onApply) {
  if (document.getElementById('update-banner')) return;
  document.body.append(
    h('div', { id: 'update-banner', class: 'update-banner', role: 'status' },
      h('span', { class: 'grow' }, '새 버전이 있습니다'),
      h('button', { type: 'button', class: 'primary', onclick: onApply }, '새로고침'),
      h('button', { type: 'button', 'aria-label': '나중에', onclick: (e) => e.currentTarget.parentElement.remove() }, '나중에'),
    ),
  );
}

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export const canInstall = () => !!installPrompt;

export async function promptInstall() {
  if (!installPrompt) return false;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  return outcome === 'accepted';
}
