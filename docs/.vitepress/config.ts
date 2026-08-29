import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'pi-freeflow Docs',
  description: '25 free models. Up to 1M context. Zero API keys. Infinite scale via your own relay pool.',
  themeConfig: {
    sidebar: [
      { text: 'Home', link: '/' },
      { text: 'Architecture', link: '/pages/architecture' },
      { text: 'Model Catalog', link: '/pages/models' },
      { text: 'Multi-Cloud Relays', link: '/pages/relays' },
      { text: 'Commands & Troubleshooting', link: '/pages/commands' },
    ],
    nav: [
      { text: 'Home', link: '/' },
      { text: 'GitHub', link: 'git+https://github.com/trefeon/pi-freeflow' },
    ],
  },
  lang: 'en-US',
})
