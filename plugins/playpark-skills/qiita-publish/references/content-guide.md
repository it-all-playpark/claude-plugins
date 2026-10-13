# Qiita Content Guide

Qiita向けクロスポスト記事の書き方・テンプレート・変換ルール。

**差別化方針:** 同一内容を Zenn / Qiita に重複投稿すると SEO 効果が分散するため、プラットフォームごとに切り口を変える（Zenn は実装 + 判断理由 + 持論の Deep How、Qiita は技術選定理由・比較検討の Why）。記事はコア版として単体で完結させ、元記事への導線では「元記事で何が読めるか」を具体的に示す。

## Qiita読者の特性

| 項目 | 特徴 |
|------|------|
| 読者層 | 幅広い技術者、背景理解重視 |
| 好む切り口 | **Why（技術選定理由）** |
| 記事スタイル | 解説先行、比較検討、判断材料 |
| トーン | 技術解説 |
| フッター | 企業紹介あり（`company_name` 設定時） |

---

## テンプレート

### tech-tips — Why中心

**切り口: 技術選定理由・背景から始まる**

```markdown
---
title: "なぜ{技術名}でこう実装するのか"
tags:
  - {Tag1}
  - {Tag2}
  - {Tag3}
private: false
---

> この記事は [{ARTICLE_TITLE}]({ORIGINAL_URL}?utm_source=qiita&utm_medium=crosspost&utm_campaign={slug}) からの転載です。

---

## この記事で分かること

- {WHY_THIS_APPROACH}の理由
- {ALTERNATIVES}との比較
- どういう場面で採用すべきか

## 背景: こういう課題があった

{読者が共感できる課題の説明 - 150-200字}

## 選択肢の検討

{検討した選択肢とその特徴 - 200-300字}

| アプローチ | メリット | デメリット |
|-----------|---------|-----------|
| {選択肢1} | {メリット} | {デメリット} |
| {選択肢2} | {メリット} | {デメリット} |
| **採用した方法** | {メリット} | {デメリット} |

## なぜこのアプローチを選んだか

{判断基準と理由 - 200-300字}

### 実装例

```{lang}
{CODE_EXAMPLE: 動作する完全なコード}
```

{コードのポイント解説 - 100-150字}

## まとめ: どういう場面で使うべきか

{結論と判断基準 - 100-150字}

---

## さらに深掘りしたい方へ

この記事では{CORE_TOPIC}の選定理由を解説しました。

:page_facing_up: **[{ARTICLE_TITLE}]({ORIGINAL_URL}?utm_source=qiita&utm_medium=crosspost&utm_campaign={slug})** ではさらに：

- {DEPTH_1: 実運用での知見}
- {DEPTH_2: 失敗パターンと対処法}
- {DEPTH_3: 応用・発展的な内容}

---

### {COMPANY_NAME} について

:link: [お問い合わせ]({CONTACT_URL}) | [ブログ]({BLOG_URL})
```

### lab-reports — 背景・動機中心

**切り口: なぜこの検証をしたか・思考プロセスから始まる**

```markdown
---
title: "なぜ{検証テーマ}を検証したか"
tags:
  - {Tag1}
  - {Tag2}
  - {Tag3}
private: false
---

> この記事は [{ARTICLE_TITLE}]({ORIGINAL_URL}?utm_source=qiita&utm_medium=crosspost&utm_campaign={slug}) からの転載です。

---

## この記事で分かること

- {検証テーマ}に取り組んだ背景
- 検証設計の考え方
- 結果から得られた判断材料

## 背景: こういう疑問があった

{検証に至った経緯・動機 - 150-200字}

「{読者の心の声・疑問}」

## 仮説

{検証前に立てた仮説 - 100-150字}

- 仮説1: {内容}
- 仮説2: {内容}

## 検証設計

{何をどう検証したか - 200-300字}

| 項目 | 内容 |
|-----|------|
| 検証対象 | {対象} |
| 測定方法 | {方法} |
| 成功基準 | {基準} |

### 検証コード

```{lang}
{CODE_EXAMPLE: 検証コード}
```

## 結果

| 仮説 | 結果 | 判定 |
|-----|------|------|
| 仮説1 | {結果} | ○/× |
| 仮説2 | {結果} | ○/× |

{結果の解釈 - 100-150字}

## 結論: どう判断すべきか

{この検証結果をどう使うか - 100-150字}

---

## さらに深掘りしたい方へ

この記事では{CORE_TOPIC}の検証背景と設計を解説しました。

:page_facing_up: **[{ARTICLE_TITLE}]({ORIGINAL_URL}?utm_source=qiita&utm_medium=crosspost&utm_campaign={slug})** ではさらに：

- {DEPTH_1: 詳細データと追加分析}
- {DEPTH_2: 他の検証パターン}
- {DEPTH_3: 今後の展望}

---

### {COMPANY_NAME} について

:link: [お問い合わせ]({CONTACT_URL}) | [ブログ]({BLOG_URL})
```

### 企業紹介フッター

`{COMPANY_NAME}` / `{CONTACT_URL}` / `{BLOG_URL}` は qiita-publish の設定（`skill-config.json` の
`qiita-publish` セクション）の `company_name` / `contact_url` / `blog_url` で埋める。会社名・URL を
テンプレートに直書きしない。

- `company_name` が空 → 企業紹介セクション（直前の `---` から末尾まで）を丸ごと出力しない
- `contact_url` が空 → 「お問い合わせ」リンクだけを省く

---

## Frontmatter変換ルール

```yaml
---
title: "記事タイトル"
tags:
  - name: Next.js
    version: "16"
  - name: React
private: false
---
```

| Field | Source | Rule |
|-------|--------|------|
| title | title | Why型に再構成（「なぜ〜」） |
| tags | tags | タグ名保持、バージョン分離（可能なら） |
| private | - | false |

### Tags変換

```yaml
# Original → Qiita
- name: Next.js
  version: "16"
- name: React
- name: TypeScript
- name: MDX
```

ルール: 元のタグ名を保持、バージョン情報があれば分離、最大5個

### Canonical URL

記事**冒頭**に追加:

```markdown
> この記事は [{ARTICLE_TITLE}]({ORIGINAL_URL}?utm_source=qiita&utm_medium=crosspost&utm_campaign={slug}) からの転載です。

---
```

---

## SEO

### タイトル最適化

```
【Next.js 16】MDXブログを自作した話 - ISRと予約投稿で「ちょうどいい」を目指す
```

- Why型（「なぜ〜」「〜を選んだ理由」）
- 【】でカテゴリ/技術を明示
- タグでキーワード補完

### Qiita固有SEO

- **Tags**: バージョン情報付きで検索精度向上
- **LGTM/ストック**: 初期の反応が検索順位に影響
- **限定共有 → 公開**: 下書き期間で内容精査

### キーワード傾向

| ユーザー傾向 | キーワード例 |
|-------------|-------------|
| 入門、ハウツー | 〇〇のやり方, 〇〇入門, 初心者 |

### 文字数ガイドライン

| セクション | 目安 |
|-----------|------|
| 学べること | 100-150字 |
| 背景・課題 | 200-300字 |
| 本文（解説中心） | 600-1000字 |
| まとめ | 100-150字 |
| 深掘り導線 | 150-200字 |
| **合計** | **1200-2000字** |

### 転載後チェックリスト

- [ ] 記事冒頭に転載元テキストリンク明記済み
- [ ] タグ適切に設定（5個以内、バージョン分離）
- [ ] 元記事への導線あり
- [ ] `company_name` 設定時は企業紹介セクションあり
