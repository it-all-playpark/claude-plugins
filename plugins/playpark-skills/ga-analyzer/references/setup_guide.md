# GA4 API Setup Guide

GA4 Data APIを使用するための初期設定手順。

## 認証方式の選択

| 方式 | 推奨環境 | 特徴 |
|-----|---------|------|
| **OAuth 2.0** | 個人/チーム利用 | ブラウザ認証、キー作成不要 |
| Service Account | サーバー間通信 | JSONキー必要（組織で禁止の場合あり） |

## OAuth 2.0 Setup（推奨）

### Step 1: Google Cloud Project

1. [Google Cloud Console](https://console.cloud.google.com/) にアクセス
2. プロジェクトを選択または新規作成

### Step 2: Analytics Data API 有効化

```bash
# gcloud CLI
gcloud services enable analyticsdata.googleapis.com
# イベント作成ルール・キーイベント等を追加する場合
gcloud services enable analyticsadmin.googleapis.com

# または Cloud Console > APIs & Services > Library で手動有効化
```

### Step 3: OAuth同意画面の設定

1. Cloud Console > APIs & Services > OAuth consent screen
2. User Type: 「Internal」（組織内）または「External」
3. 必要情報を入力:
   - App name: `GA Analyzer` など
   - User support email: 自分のメール
   - Developer contact: 自分のメール
4. Scopes: 「ADD OR REMOVE SCOPES」
   - `https://www.googleapis.com/auth/analytics.readonly` を追加
   - `https://www.googleapis.com/auth/analytics.edit` を追加（Admin API でイベント作成ルール・キーイベント等を追加する）
   - `https://www.googleapis.com/auth/webmasters.readonly` を追加（Search Console と token を共有する）
5. 「SAVE AND CONTINUE」

**External の場合**: Test users に自分のメールを追加

### Step 4: OAuth Client ID 作成

1. APIs & Services > Credentials
2. 「+ CREATE CREDENTIALS」 > 「OAuth client ID」
3. Application type: **Desktop app**
4. Name: `ga-analyzer-cli` など
5. 「CREATE」
6. **JSONをダウンロード** → `client_secret.json` として保存

### Step 5: GA4 Property ID 確認

1. [Google Analytics](https://analytics.google.com/) にアクセス
2. Admin > Property Settings
3. 「PROPERTY ID」をメモ（数字のみ、例: 123456789）

### Step 6: Python環境セットアップ

```bash
pip install google-analytics-data google-auth-oauthlib
```

### Step 7: 動作確認

```bash
ga-analyzer-fetch \
  --property-id YOUR_PROPERTY_ID \
  --oauth-client /path/to/client_secret.json \
  --start-date 7daysAgo \
  --end-date today \
  --report-type traffic \
  --output test_report.json
```

初回実行時:
1. ブラウザが開く
2. Googleアカウントでログイン
3. 権限を許可
4. トークンが `~/.config/ga4/token.json` に保存される

2回目以降はブラウザ認証不要。

---

## Service Account Setup（代替）

組織でサービスアカウントキー作成が許可されている場合のみ。

### Step 1-2: 同上

### Step 3: サービスアカウント作成

1. IAM & Admin > Service Accounts
2. 「+ CREATE SERVICE ACCOUNT」
3. Name: `ga-analyzer`
4. 「CREATE AND CONTINUE」→「DONE」

### Step 4: キーファイル作成

1. 作成したサービスアカウントをクリック
2. 「KEYS」タブ > 「ADD KEY」 > 「Create new key」
3. 「JSON」選択 → ダウンロード

### Step 5: GA4アクセス権付与

1. Google Analytics > Admin > Property Access Management
2. サービスアカウントのメールを追加（`xxx@project.iam.gserviceaccount.com`）
3. 権限: 「Viewer」

### Step 6: 実行

```bash
ga-analyzer-fetch \
  --property-id YOUR_PROPERTY_ID \
  --credentials /path/to/service-account.json \
  --output test_report.json
```

---

## Troubleshooting

### OAuth: "Access blocked: This app's request is invalid"
- OAuth同意画面でアプリが「Testing」状態
- Test usersに自分を追加、または「PUBLISH APP」

### OAuth: "redirect_uri_mismatch"
- OAuth Client IDのタイプが「Desktop app」になっているか確認

### "Permission denied" / "User does not have sufficient permissions"
- GA4プロパティへのアクセス権があるか確認
- OAuth: ログインしたアカウントがGA4にアクセスできるか
- Service Account: サービスアカウントをGA4に追加したか

### "API not enabled"
- Analytics Data APIが有効か確認

### "Invalid property ID"
- 数字のみを指定（`GA4-` や `properties/` は不要）

## Security Best Practices

1. **client_secret.json**: `.gitignore`に追加、共有しない
2. **トークンファイル** (`~/.config/ga4/token.json`): 自動生成、削除すれば再認証
3. **定期的な確認**: Cloud Console > Credentialsで不要なクライアントを削除
