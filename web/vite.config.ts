import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API = process.env.API_URL || 'http://localhost:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.WEB_PORT || 5173),
    host: true,
    proxy: { '/api': API, '/socket.io': { target: API, ws: true } },
    fs: { allow: ['..'] },
  },
});
