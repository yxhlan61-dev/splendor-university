# 线上多人模式说明

本项目现在支持两种模式：

1. **本地多人轮流游玩**：沿用原有玩法，2-4 名玩家共用同一浏览器轮流操作，可保存到浏览器本地存储。
2. **线上多人游玩**：玩家通过同一个 Node.js 房间服务器创建、查看、进入房间，并实时同步游戏状态。

## 启动线上房间服务器

在项目根目录运行：

```bash
npm run serve
```

等价于：

```bash
node server.js
```

浏览器访问：

```text
http://127.0.0.1:5500/
```

同一局域网内的其他玩家可访问房主电脑的局域网 IP，例如：

```text
http://192.168.1.23:5500/
```

> 如果使用 `python -m http.server` 或纯静态部署，仍可玩本地模式，但线上房间列表/创建/加入需要 `server.js` 提供 API。

## 线上模式流程

1. 进入首页，选择「线上多人房间」。
2. 房主填写房间名称、自己的名称、房间人数和先手规则，点击「创建线上房间」。
3. 其他玩家在「已有房间」中点击「进入房间」，填写自己的名称。
4. 所有座位坐满后，房主点击「开始线上游戏」。
5. 游戏中只有当前回合玩家可以执行动作；其他玩家会实时看到棋盘更新。
6. 已开始或满员的房间仍可进入观战，但观战者不能执行动作。

## 注意事项

- 当前房间数据存储在 `server.js` 进程内存中；服务器重启后线上房间会清空。
- 房间 12 小时无更新会自动过期清理。
- 若要跨公网游玩，需要把运行 `server.js` 的机器/服务暴露为公网可访问地址。

## Cloudflare Workers 动态部署

本项目已增加 `wrangler.jsonc` 和 `worker/index.js`，可作为 Cloudflare Workers 动态站点部署：

```bash
npm run deploy
```

部署后，静态页面由 Workers Assets 托管，线上房间 API 由 Worker + Durable Object 托管。这样线上房间不依赖本地 `server.js` 进程，适合公开网页多人游玩。

## GitHub Actions 自动部署

已添加 `.github/workflows/deploy.yml`。当 `main` 分支收到新的 push，或在 GitHub Actions 页面手动点击 `Run workflow` 时，会自动：

1. 检出代码。
2. 使用 Node.js 22。
3. 运行规则测试 `npm test`。
4. 构建静态资源 `npm run build`。
5. 使用 Wrangler 部署到 Cloudflare Workers。

需要在 GitHub 仓库的 `Settings -> Secrets and variables -> Actions` 中添加：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

API Token 需要允许部署 Workers、读取/写入 Workers Scripts，并能访问 Durable Objects 相关配置。
