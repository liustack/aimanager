<p align="center">
  <img src="https://raw.githubusercontent.com/liustack/aimanager/main/assets/banner.jpg" width="100%" alt="AIManager" />
</p>

<h1 align="center">AIManager</h1>

<p align="center"><b>一键安装启动 DeepSeek Harness。</b></p>

<p align="center">🥇 <b>全网最傻瓜 DeepSeek Harness 启动器</b> 🥇</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="CHANGELOG.md">更新日志</a> ·
  <a href="CONTRIBUTING.md">参与方式</a> ·
  <a href="https://github.com/liustack/modlens"><b>👁️ ModLens(视觉)</b></a> ·
  <a href="https://github.com/liustack/modsearch"><b>🔎 ModSearch(联网搜索)</b></a>
</p>

<p align="center">
  <a href="https://x.com/liustack"><img src="https://img.shields.io/badge/follow-%40liustack-black?style=flat-square&logo=x&logoColor=white" alt="Follow @liustack on X"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/price-free%20forever-brightgreen?style=flat-square" alt="Free forever">
  <img src="https://img.shields.io/badge/Not%20backed%20by-Y%20Combinator-FF6600?style=flat-square&logo=ycombinator&logoColor=white" alt="Not backed by Y Combinator">
  <img src="https://img.shields.io/badge/users-unknown-lightgrey?style=flat-square" alt="Users unknown">
</p>

DeepSeek Harness(dsh)没有自己的桌面应用,安装要走终端。AIManager 给它补上一个。**点一下鲸鱼,dsh 装好、跑起来、直接开聊**——零终端、零命令、零设置。Claude Desktop 和 Codex(ChatGPT)应用也从同一屏启动。

## 实测截图

启动台——任意图标一键直达:

<img src="assets/screenshot-launchpad.png" width="100%" alt="AIManager 启动台" />

DeepSeek Harness 在 AIManager 里运行:

<img src="assets/screenshot-dsh.png" width="100%" alt="DeepSeek Harness 在 AIManager 内运行" />

## 交流

欢迎随时提 [issue](https://github.com/liustack/aimanager/issues/new),中英文都行。也欢迎来 X 上聊:**[@liustack](https://x.com/liustack)**——下一个该一键支持哪个 harness、哪里坏了、接下来该做什么,新版本也是那边先发。

## 亮点

- **一键装好即开聊。** 鲸鱼图标包办一切:私有 Node.js 运行时、dsh 本体、启动、聊天界面直接在应用内打开。零终端,零命令。
- **官方应用直通。** Claude Desktop、Codex(ChatGPT)应用装了即启动,没装则一键安装,自带 App Store 式进度环。
- **与手动安装完全兼容。** 托管的 dsh 复用官方状态目录,网上的教程照常有效,你自己装过的副本原样能用。
- **永远免费。** MIT 开源。没有付费版,没有「专业版」,没有广告。

## 安装

去 [Releases](https://github.com/liustack/aimanager/releases) 下载:Mac 选 `.dmg`,Windows 选 `.exe`。

安装包暂未过苹果公证。Mac 首次打开会提示「无法验证…」——点「完成」,再到 系统设置 → 隐私与安全性 → **仍要打开**(macOS 14 及更早版本直接右键应用 →「打开」)。如果看到的是「已损坏,无法打开」,在终端里跑一次这条命令即可:

```bash
xattr -cr /Applications/AIManager.app
```

Windows 如果弹出蓝色提示,点「更多信息」→「仍要运行」。

v0.1 在 macOS 上端到端验证过;Windows 真机验证排在下一步。

开发者也可以从源码运行:

```bash
pnpm install
pnpm dev
```

## 参与方式

aimanager 不接受 pull request。项目由单一作者维护、逐行审阅,这是为可靠性做的刻意选择。两种真正有效的参与方式:

- **[提 issue](https://github.com/liustack/aimanager/issues)。** bug、建议、看不懂的报错、写得不清楚的文档。issue 都会被认真读,并决定接下来做什么。
- **Fork。** MIT 协议下你的副本完全属于你,随意修改、随意发布。

细节(包括代码怎么组织)见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 顺手安利

本项目的开发跑在 LIUSTACK Skills 上:动手前 `shaping`,动手时 `coding`,坏了 `dig`,交接用 `snapshot`。比 Superpowers 更轻,也更强。

```bash
npx -y skills add liustack/vibemaster -g
```

⭐ 如果对你有帮助,给 [aimanager](https://github.com/liustack/aimanager) 和 [VibeMaster](https://github.com/liustack/vibemaster) 点个 star。star 是下一个开发者找到它们的方式。

## 生态伙伴

DeepSeek Harness 生态里值得推荐的项目。

- 👁️ **[ModLens](https://github.com/liustack/modlens)** —— 为纯文本 DeepSeek / GLM 模型补上视觉能力的外挂插件,图片直接粘贴进对话就能读。
- 🔎 **[ModSearch](https://github.com/liustack/modsearch)** —— 为没有联网能力的模型补上网页搜索、X 搜索和页面抓取。

## Star History

<a href="https://www.star-history.com/?repos=liustack%2Faimanager&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=liustack/aimanager&type=date&theme=dark&legend=top-left&sealed_token=J8Ty12u3tzeBqJYzwA1DXO8ggEERZWc42zz9Nlr1ZjWrKzZnyaELmthABUwMc4LKHcqZ1Lq76LX-elmCQgUf2IAhlo2DkhKD_qhb5_yBAc_yWMi6D_mp0g" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=liustack/aimanager&type=date&legend=top-left&sealed_token=J8Ty12u3tzeBqJYzwA1DXO8ggEERZWc42zz9Nlr1ZjWrKzZnyaELmthABUwMc4LKHcqZ1Lq76LX-elmCQgUf2IAhlo2DkhKD_qhb5_yBAc_yWMi6D_mp0g" />
 </picture>
</a>

## 免责声明

本项目按下方 MIT 协议原样提供,作者不作任何担保,也不为任何特定用途背书。aimanager 所安装的 AI 应用与运行时(DeepSeek Harness、Node.js、Claude Desktop、Codex 应用等)归各自厂商所有,受其各自条款约束,由你自行负责。

## 协议

MIT
