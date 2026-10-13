export type ThemeId = 'lavender' | 'peach' | 'mint' | 'sky'

export interface ThemeOption {
  id: ThemeId
  label: string
  hint: string
  swatch: string
}

interface ThemeDefinition extends ThemeOption {
  navText: '#000000' | '#ffffff'
  tabText: string
  vars: Record<string, string>
}

const STORAGE_KEY = 'OURS_THEME_ID'

const THEME_DEFINITIONS: ThemeDefinition[] = [
  {
    id: 'lavender',
    label: '淡紫',
    hint: '安静柔和',
    swatch: 'linear-gradient(135deg, #9B8ECF, #6E62A8)',
    navText: '#000000',
    tabText: '#9A94A8',
    vars: {
      '--c-bg': '#F5F3FA',
      '--c-surface': '#FFFFFF',
      '--c-surface-soft': '#EDE9F6',
      '--c-accent': '#8B7EC8',
      '--c-accent-light': '#9B8ECF',
      '--c-accent-deep': '#6E62A8',
      '--c-accent-soft': 'rgba(139, 126, 200, 0.22)',
      '--c-you': '#7B8CB5',
      '--c-them': '#9B8ECF',
      '--c-text': '#4A4458',
      '--c-muted': 'rgba(74, 68, 88, 0.52)',
      '--c-divider': 'rgba(110, 98, 168, 0.12)',
      '--c-shadow': '0 12rpx 36rpx rgba(110, 98, 168, 0.12)',
      '--c-accent-gradient': 'linear-gradient(160deg, #9B8ECF 0%, #6E62A8 100%)',
      '--c-accent-shadow': 'rgba(110, 98, 168, 0.35)',
      '--c-grain-dot': 'rgba(139, 126, 200, 0.07)',
    },
  },
  {
    id: 'peach',
    label: '暖杏',
    hint: '温暖有一点甜',
    swatch: 'linear-gradient(135deg, #E7A184, #B76552)',
    navText: '#000000',
    tabText: '#B29A91',
    vars: {
      '--c-bg': '#FFF8F3',
      '--c-surface': '#FFFFFF',
      '--c-surface-soft': '#F9EDE4',
      '--c-accent': '#D88E72',
      '--c-accent-light': '#E7A184',
      '--c-accent-deep': '#A95F4E',
      '--c-accent-soft': 'rgba(216, 142, 114, 0.22)',
      '--c-you': '#6F93A4',
      '--c-them': '#D88E72',
      '--c-text': '#5C4540',
      '--c-muted': 'rgba(92, 69, 64, 0.52)',
      '--c-divider': 'rgba(169, 95, 78, 0.14)',
      '--c-shadow': '0 12rpx 36rpx rgba(169, 95, 78, 0.12)',
      '--c-accent-gradient': 'linear-gradient(160deg, #E7A184 0%, #B76552 100%)',
      '--c-accent-shadow': 'rgba(169, 95, 78, 0.32)',
      '--c-grain-dot': 'rgba(216, 142, 114, 0.08)',
    },
  },
  {
    id: 'mint',
    label: '薄荷',
    hint: '清爽轻一点',
    swatch: 'linear-gradient(135deg, #8FC2A9, #568C76)',
    navText: '#000000',
    tabText: '#82A295',
    vars: {
      '--c-bg': '#F2F9F6',
      '--c-surface': '#FFFFFF',
      '--c-surface-soft': '#E5F1EC',
      '--c-accent': '#70AD96',
      '--c-accent-light': '#8FC2A9',
      '--c-accent-deep': '#4E7F6B',
      '--c-accent-soft': 'rgba(112, 173, 150, 0.22)',
      '--c-you': '#6C8BA3',
      '--c-them': '#7EAE9B',
      '--c-text': '#3E5148',
      '--c-muted': 'rgba(62, 81, 72, 0.52)',
      '--c-divider': 'rgba(78, 127, 107, 0.14)',
      '--c-shadow': '0 12rpx 36rpx rgba(78, 127, 107, 0.12)',
      '--c-accent-gradient': 'linear-gradient(160deg, #8FC2A9 0%, #568C76 100%)',
      '--c-accent-shadow': 'rgba(78, 127, 107, 0.32)',
      '--c-grain-dot': 'rgba(112, 173, 150, 0.08)',
    },
  },
  {
    id: 'sky',
    label: '天蓝',
    hint: '轻盈清透',
    swatch: 'linear-gradient(135deg, #8CC9E8, #4D91C5)',
    navText: '#000000',
    tabText: '#7C9FB5',
    vars: {
      '--c-bg': '#F2F8FC',
      '--c-surface': '#FFFFFF',
      '--c-surface-soft': '#E5F1F8',
      '--c-accent': '#6EAED2',
      '--c-accent-light': '#8CC9E8',
      '--c-accent-deep': '#4D82A9',
      '--c-accent-soft': 'rgba(110, 174, 210, 0.22)',
      '--c-you': '#668DA9',
      '--c-them': '#78A9C7',
      '--c-text': '#3E5362',
      '--c-muted': 'rgba(62, 83, 98, 0.52)',
      '--c-divider': 'rgba(77, 130, 169, 0.14)',
      '--c-shadow': '0 12rpx 36rpx rgba(77, 130, 169, 0.12)',
      '--c-accent-gradient': 'linear-gradient(160deg, #8CC9E8 0%, #4D91C5 100%)',
      '--c-accent-shadow': 'rgba(77, 130, 169, 0.32)',
      '--c-grain-dot': 'rgba(110, 174, 210, 0.08)',
    },
  },
]

export const THEME_OPTIONS: ThemeOption[] = THEME_DEFINITIONS.map(({ id, label, hint, swatch }) => ({
  id,
  label,
  hint,
  swatch,
}))

function findTheme(id: ThemeId): ThemeDefinition {
  return THEME_DEFINITIONS.find(theme => theme.id === id) ?? THEME_DEFINITIONS[0]
}

export function getThemeId(): ThemeId {
  try {
    const stored = wx.getStorageSync(STORAGE_KEY)
    if (stored === 'lavender' || stored === 'peach' || stored === 'mint' || stored === 'sky') return stored
  } catch {
    /* use the default */
  }
  return 'lavender'
}

export function getThemeStyle(id: ThemeId = getThemeId()): string {
  const theme = findTheme(id)
  const rgb = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(',')
  return Object.entries({
    ...theme.vars,
    '--c-accent-rgb': rgb(theme.vars['--c-accent']),
    '--c-deep-rgb': rgb(theme.vars['--c-accent-deep']),
    '--c-text-rgb': rgb(theme.vars['--c-text']),
  })
    .map(([name, value]) => `${name}:${value}`)
    .join(';')
}

export function getMapTheme(): { accent: string; text: string } {
  const theme = findTheme(getThemeId())
  return { accent: theme.vars['--c-accent-deep'], text: theme.vars['--c-text'] }
}

export function setTheme(id: ThemeId): string {
  const theme = findTheme(id)
  try {
    wx.setStorageSync(STORAGE_KEY, theme.id)
  } catch {
    /* a theme still applies for this page even if storage is unavailable */
  }
  applyThemeChrome(theme.id)
  return getThemeStyle(theme.id)
}

export function syncTheme(page: { setData: (data: { themeStyle: string }) => void }): void {
  const id = getThemeId()
  applyThemeChrome(id)
  page.setData({ themeStyle: getThemeStyle(id) })
}

export function applyThemeChrome(id: ThemeId = getThemeId()): void {
  const theme = findTheme(id)
  const bg = theme.vars['--c-bg']
  const accent = theme.vars['--c-accent']
  try {
    wx.setNavigationBarColor({
      frontColor: theme.navText,
      backgroundColor: bg,
    })
    wx.setBackgroundColor({ backgroundColor: bg, backgroundColorTop: bg, backgroundColorBottom: bg })
    wx.setTabBarStyle({
      color: theme.tabText,
      selectedColor: accent,
      backgroundColor: theme.vars['--c-surface'],
      borderStyle: 'white',
    })
  } catch {
    /* APIs can be unavailable in older base libraries or test environments */
  }
}
