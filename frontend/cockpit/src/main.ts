import './app.css';
import App from './App.svelte';
import { initPwa } from './pwa';

const target = document.getElementById('app');
if (!target) throw new Error('#app mount node missing');

const app = new App({ target });

// Register the service worker + "new version → refresh" update flow (P3).
initPwa();

export default app;
