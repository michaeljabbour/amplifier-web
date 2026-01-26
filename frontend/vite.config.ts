import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // Set VITE_HOST=0.0.0.0 in .env.local to allow external access
    host: process.env.VITE_HOST || 'localhost',
    // Allow any hostname when serving externally (for dev only)
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:8000',
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
      },
    },
  },
})
