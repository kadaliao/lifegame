import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { llmEnvProxy } from './llm-proxy.js';

export default defineConfig({
  plugins: [react(), llmEnvProxy()],
  server: { port: 5180 },
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
