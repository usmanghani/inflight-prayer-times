import './style.css';
import { mountApp } from './ui/app';

const root = document.getElementById('app');
if (root) {
  mountApp(root).catch((err: unknown) => {
    root.textContent = `The app could not start: ${err instanceof Error ? err.message : String(err)}`;
  });
}

const env = (import.meta as unknown as { env?: { PROD?: boolean; BASE_URL?: string } }).env;
if (env?.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${env.BASE_URL ?? './'}sw.js`).catch(() => {
      /* offline support is optional */
    });
  });
}
