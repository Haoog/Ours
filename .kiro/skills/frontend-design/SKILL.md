---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, artifacts, posters, or applications (examples include websites, landing pages, dashboards, React components, HTML/CSS layouts, or when styling/beautifying any web UI). Generates creative, polished code and UI design that avoids generic AI aesthetics.
---

This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

The user provides frontend requirements: a component, page, application, or interface to build. They may include context about the purpose, audience, or technical constraints.

## Design Thinking

Before coding, understand the context and commit to a BOLD aesthetic direction:
- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc. There are so many flavors to choose from. Use these for inspiration but design one that is true to the aesthetic direction.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

Then implement working code (HTML/CSS/JS, React, Vue, etc.) that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

## Frontend Aesthetics Guidelines

Focus on:
- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics; unexpected, characterful font choices. Pair a distinctive display font with a refined body font.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions. Use scroll-triggering and hover states that surprise.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Add contextual effects and textures that match the overall aesthetic. Apply creative forms like gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, and grain overlays.

NEVER use generic AI-generated aesthetics like overused font families (Inter, Roboto, Arial, system fonts), cliched color schemes (particularly purple gradients on white backgrounds), predictable layouts and component patterns, and cookie-cutter design that lacks context-specific character.

Interpret creatively and make unexpected choices that feel genuinely designed for the context. No design should be the same. Vary between light and dark themes, different fonts, different aesthetics. NEVER converge on common choices (Space Grotesk, for example) across generations.

**IMPORTANT**: Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animations and effects. Minimalist or refined designs need restraint, precision, and careful attention to spacing, typography, and subtle details. Elegance comes from executing the vision well.

Remember: Claude is capable of extraordinary creative work. Don't hold back, show what can truly be created when thinking outside the box and committing fully to a distinctive vision.

## 小程序适配（OursWXAPP）

本仓库为微信小程序，视觉原则同上，实现时注意：

- 样式写在 **WXSS**，尺寸优先 **rpx**；在 `page` 或根容器用 CSS 变量统一色板与圆角。
- 动效用 `@keyframes` + `animation`，或 `transition`；复杂交互可用 `wx.createAnimation`。
- 字体：默认系统字体；需品牌字体时用 `wx.loadFontFace` 并注意体积与版权。
- 布局用 `flex` / `grid`（基础库支持范围内）；避免依赖 Web 专属选择器与 `vh` 的坑，安全区用 `env(safe-area-inset-*)`。
- 图片用 `mode`、懒加载与合适分辨率；长列表注意性能。
- 家庭类场景可倾向温暖、可信、易读的调性，但仍需**明确一种美学方向**，避免泛用紫渐变模板脸。

## 当前项目美学：Cinema Ours

OursWXAPP 已在 `docs/产品功能说明.md` §10 定调 **Cinema Ours**：电影、胶片、场记、宽银幕、字幕。色板（CSS 变量见 `app.wxss`）：

- 影院黑 `#121110` · 胶片灰 `#1E1C19` · 暖金 `#C9A962`
- 你 `#D4A574` · TA `#8FA3AD` · 字幕白 `#E8E4DC` · 弱化 `rgba(232,228,220,0.45)`

视觉规则：letterbox 上下黑条、衬线大字天数、场记条 `SCENE 03-12 TUE`、宽银幕图片（约 2.39:1）、动效克制（慢淡入、Ken Burns 限单屏一处、合拢/打板而非弹跳）。**禁止**霓虹渐变、爱心雨、廉价粉紫、glitch、彩虹。
