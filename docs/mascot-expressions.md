# 桌面插画资源

| 文件（src/assets/qoder/） | 用途 | 来源 |
| --- | --- | --- |
| expert-body.gif | 首页、头像与专家套件身体动画 | 参考应用资源地址 |
| expert-hand.gif | 专家套件手部叠层 | 参考应用资源地址 |
| presentation.svg | 技能演示文稿插画 | 参考应用 renderer 资源 |
| infographic.svg | 技能信息图插画 | 参考应用 renderer 资源 |
| research.svg | 技能研究插画 | 参考应用 renderer 资源 |
| connectors.svg | 连接器横幅 | 参考应用 renderer 资源 |

知识库横幅由 `src/KnowledgeHeroArt.tsx` 绘制阅读姿态与书本、资料卡，沿用参考形象的绿色身体、卷发和眼睛；动作由 CSS 控制，减少动态效果时不播放动画。该组件不依赖外部 GIF。

参考应用：Qoder Work CN 0.9.15。本地导入工具：`node scripts/import-qoder-visuals.mjs [app.asar 路径]`。脚本只读应用归档，不执行或修改参考应用；GIF 从归档中声明的公开资源地址获取。

导入将 SVG 的主题色变量替换为固定色值，并把 HTML 风格的布尔属性规范为 XML 属性，使资源可以作为独立图片加载。验证：`xmllint --noout src/assets/qoder/*.svg`。

GIF 来源：

- [身体动画](https://img.alicdn.com/imgextra/i1/O1CN01d4Bc4l1ji9VRAdfFs_!!6000000004581-1-tps-460-460.gif)
- [手部动画](https://img.alicdn.com/imgextra/i3/O1CN01styB411hL8MwO8769_!!6000000004260-1-tps-460-460.gif)

以上素材属于上游参考产品，不表示项目取得了品牌或素材所有权。开发预览与公开分发的授权范围需分别确认。
