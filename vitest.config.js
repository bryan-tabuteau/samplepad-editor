import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      component: resolve(process.cwd(), 'src/component'),
      state: resolve(process.cwd(), 'src/state'),
      actions: resolve(process.cwd(), 'src/actions'),
      menu: resolve(process.cwd(), 'src/menu'),
      util: resolve(process.cwd(), 'src/util'),
      css: resolve(process.cwd(), 'src/css'),
      const: resolve(process.cwd(), 'src/const.js')
    }
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.js']
  }
})
