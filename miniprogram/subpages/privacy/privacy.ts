// subpages/privacy/privacy.ts — 隐私政策（静态说明）

import { getThemeStyle, syncTheme } from '../../services/theme'

Page({
  data: {
    themeStyle: getThemeStyle(),
  },

  onLoad() {
    syncTheme(this)
  },
})
