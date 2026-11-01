import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

const app = mount(App, {
  target: document.getElementById('app')!,
});

// Dev-only bridge that lets E2E tests (and future external tooling) drive the
// app programmatically — e.g. opening an OPFS-backed project without the
// native picker. Never installed in production builds.
if (import.meta.env.DEV) {
  void import('./lib/debug').then(({ installDebugHook }) => installDebugHook());
}

export default app;
