import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  plugins: [
    // 自动生成自签名证书，启用 HTTPS
    // 移动端 AR 必须 HTTPS：摄像头权限 + CDN 资源均要求安全上下文
    basicSsl(),
  ],
  server: {
    https: true,
    host: true,   // 暴露到局域网，手机可通过 IP 访问
    port: 5173,
  },
  preview: {
    https: true,
    host: true,
    port: 4173,
  },
})
