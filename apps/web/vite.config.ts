import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5180 },
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
