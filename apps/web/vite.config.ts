import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  const target = process.env.PTVAULT_API_ORIGIN ?? 'http://127.0.0.1:3210';
  return {
    plugins: [react()],
    server: { proxy: { '/api': { target } } },
    preview: { proxy: { '/api': { target } } },
  };
});
