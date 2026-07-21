import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0', // 這是關鍵：允許從外部 IP 進行存取
    port: 8010,      // 指定 Port
    strictPort: true,
  }
})
