import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // darekore.jp（独自ドメイン）で配信するため、base は / のままにする。
  // '/darenano/' にすると、独自ドメイン側で CSS/JS を読み込めなくなる。
  base: '/',
})
