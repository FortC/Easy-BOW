import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'fastllm-worker': resolve(__dirname, 'src/main/fastllm-worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          'ocr-worker': resolve(__dirname, 'src/main/ocr/worker-preload.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [react()],
    server: {
      // dev server 钉死 IPv4 回环：Node 24 下 vite 默认只绑 [::1]，而 Chromium 解析
      // localhost 走 127.0.0.1 → UI 窗口 ERR_CONNECTION_REFUSED（渲染层挂 → 浏览器
      // 区域坐标不上报 → 元素全被可见性过滤，自测大面积假失败）
      host: '127.0.0.1'
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@': resolve(__dirname, 'src/renderer/src')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
})
