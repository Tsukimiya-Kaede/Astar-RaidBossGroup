# RJPQ Tool — GitHub Pages + Render 部署版

這份專案已拆成：

- `frontend/`：靜態前端，部署到 **GitHub Pages**
- `backend/`：WebSocket 後端，部署到 **Render**

## 功能

- 建立 / 加入房間
- 房間密碼
- `#/房號` 直接進房
- 顏色不可重複
- 10 × 4 平台共享標記
- 左鍵共享標記
- 右鍵私人錯誤標記（僅自己看得到）
- 清空共享標記
- 複製房間資訊

## 一、部署後端到 Render

1. 把這份專案推到 GitHub。
2. 到 Render 建立 **New Web Service**，連接你的 GitHub Repo。
3. Root Directory 填：`backend`
4. Build Command：`npm install`
5. Start Command：`npm start`
6. 部署完成後，記下你的 Render 網址，例如：
   `https://your-rjpq-backend.onrender.com`

Render 免費方案可能會休眠，第一次連線會比較慢。

## 二、部署前端到 GitHub Pages

專案已附好 `.github/workflows/deploy-pages.yml`。

1. 把專案 push 到 GitHub 的 `main` 分支。
2. 到 Repo → **Settings** → **Pages**
3. Build and deployment 選 **GitHub Actions**
4. push 一次或手動執行 workflow

## 三、設定前端連線到 Render

做法 A：改 `frontend/config.js`

```js
window.APP_CONFIG = {
  backendUrl: "https://your-rjpq-backend.onrender.com"
};
```

做法 B：進網站後手動填「連線設定」欄位並儲存。

## 四、本機測試

後端：
```bash
cd backend
npm install
npm start
```

前端：
直接打開 `frontend/index.html`，然後在頁面上方填：
`http://localhost:8080`

## 五、注意事項

- 私人錯誤標記只存在各自瀏覽器。
- 共享資料存在 Render 後端記憶體；服務重啟就會清空。
- 這是輕量版，不含資料庫。
