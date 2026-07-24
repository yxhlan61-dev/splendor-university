# 璀璨宝石之大学模拟器 v0.1

基于 `docs/university_splendor_design.md` 制作的第一版本地多人浏览器原型。

## 运行方式

推荐使用 Python Launcher 启动静态服务器。请在项目目录运行：

```powershell
cd /d "F:\splendor"
py -m http.server 8000 --bind 127.0.0.1
```

然后浏览器访问：

```text
http://127.0.0.1:8000/index.html
```

如果 8000 端口被占用，可以换一个端口：

```powershell
py -m http.server 5173 --bind 127.0.0.1
```

然后访问 `http://127.0.0.1:5173/index.html`。

也可以直接运行：

```powershell
.\start_game.bat
```

## 已实现

- 2-4 人本地多人。
- 五类任务卡与万能卡供应。
- 一级/二级发展卡：按设计文档“数量”列生成，一级 75 张，二级 36 张。
- 每级市场最多展示 5 张。
- 拿 3 个不同任务卡、拿 2 个相同任务卡。
- 预留公开卡、盲预留、预留上限 3、预留得万能卡。
- 赢取发展卡、固定成本折扣、万能卡补足。
- 保研上岸、宿舍领袖弹性成本与折扣。
- 开心值、15 分终局、补齐回合、胜负判定。
- 机遇卡触发、奖励、弃牌区洗回循环。
- 10 张资源上限与强制弃还。
- 浏览器本地存储保存/继续。
- 紧凑式页面布局，方便宽屏下一览主要元素。

## 测试

```powershell
npm test
```

## 主要文件

- `index.html`：入口页面。
- `src/data.js`：卡牌、资源、数值配置。
- `src/game.js`：纯规则逻辑。
- `src/main.js`：界面渲染与交互。
- `src/styles.css`：界面样式。
- `tests/rules.test.js`：规则验收测试。
