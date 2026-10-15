---
name: suica-to-csv
description: >
  Convert モバイルSuica残高ご利用明細 PDF to マネーフォワードクラウド経費 CSV import format.
  Use when: (1) user has a Suica PDF statement and wants CSV for expense reporting,
  (2) keywords like "Suica", "suica", "交通費CSV", "経費CSV", "MFクラウド", "マネーフォワード",
  "Suica CSV", "Suica変換", "交通費インポート",
  (3) user wants to convert IC card transaction history to expense CSV.
  Accepts args: PDF_PATH [-o output.csv]
model: haiku
effort: low
---

# suica-to-csv

Convert モバイルSuica残高ご利用明細 PDF → マネーフォワードクラウド経費 CSV.

## Usage

```
/suica-to-csv <pdf-path> [-o output.csv]
```

| Arg | Description |
|-----|-------------|
| pdf-path | Path to Suica PDF statement. The PDF is read by Claude, not by the script |
| -o | Output CSV path, passed through to the script's `-o` (default: CWD/suica_transactions.csv) |

PDF → text → script: Claude extracts transaction lines from the PDF into a temp text file, then the script converts that text file to CSV.

## Workflow

1. **Read PDF** → Use Read tool to extract text from the Suica PDF (`pdf-path`)
2. **Parse transactions** → Extract structured data from text using the parsing logic below
3. **Detect year** → Infer start/end year from PDF filename pattern `_YYYYMMDD_YYYYMMDDHHMMSS` or ask user (the temp file name carries no date, so the years must be passed explicitly)
4. **Write temp text file** → Save parsed transaction lines (one per line) to a temp file
5. **Run converter** → `python3 ${CLAUDE_PLUGIN_ROOT}/suica-to-csv/scripts/suica_to_csv.py <temp-file> --start-year YYYY --end-year YYYY [-o output.csv]` (forward `-o` only when the user gave it)
6. **Report results** → Show summary (row count, total amount, operator breakdown)
7. **Cleanup** → Remove temp file

## PDF Text Format

The PDF contains lines in these formats:

```
MM DD 入 STATION_IN 出 STATION_OUT AMOUNT      # Train
MM DD ＊入 STATION_IN 出 STATION_OUT AMOUNT     # Train (transfer)
MM DD ﾊﾞｽ等 COMPANY AMOUNT                      # Bus
```

Amounts are negative integers (e.g., `-1,980`). Amount `0` entries are excluded.

## Parsing Rules

### Transaction text extraction from PDF

Extract only data lines matching the patterns above. Skip header/footer text like:
- `モバイル Ｓｕｉｃａ 残高ご利用明細`
- `利用履歴 （N件）`
- `月 日 種別 利用駅 種別 利用駅 入金・利用額`
- `ご利用ありがとうございます。`
- Lines with only `*`

Each data line should be normalized to: `MM DD TYPE STATION_INFO AMOUNT`

### Year detection

PDF filename pattern: `JE..._YYYYMMDD_YYYYMMDDHHMMSS.pdf`
- First YYYYMMDD = statement start date
- Second YYYY = export year
- Months >= 7 → start year, Months < 7 → end year

### Operator classification

| Station prefix | Operator | Example |
|---------------|----------|---------|
| 地 / 地　 | 東京メトロ | 地恵比寿, 地　新橋 |
| 都 / 都　 | 都営地下鉄 | 都　新橋 |
| 京王 | 京王電鉄 | 京王渋谷, 京王橋本 |
| 京急 | 京急電鉄 | 京急品川, 京急横浜 |
| JW / ＪＷ | JR西日本 | JW徳山, JW柳井 |
| ＭＲ / MR | モノレール | ＭＲＣＤ |
| 小　 | 小田急電鉄 | 小　新宿, 小　町田 |
| 東武 / 東武　 | 東武鉄道 | 東武宇都, 東武　柏 |
| FC / ＦＣ | 福岡市地下鉄 | FC福岡空, FC博多 |
| JK / ＪＫ | JR九州 | JK博多, JK鳥栖 |
| KS / ＫＳ | 京成電鉄 | KS空港２ |
| (none) | JR東日本 | 宇都宮, 大崎, 新橋 |

The payee is the entry station's operator. Stations without a prefix (including private-railway stations such as おもちゃ or 西調布) fall back to JR東日本.

### Bus classification

| Raw name | Payee |
|----------|-------|
| 関東自動 | 関東自動車 |
| 神奈中 | 神奈中バス |
| 八戸市交 | 八戸市交通部 |
| 岩手県北 | 岩手県北バス |
| (others) | Use raw name |

### 経費科目

- Train (入/出) → `電車代`
- Bus (ﾊﾞｽ等) → `バス代`

## Output CSV

UTF-8 with BOM. Columns:

```
日付,支払先・内容,経費科目,金額（税込）,自社出席代表者名,自社出席者人数,
他社出席代表者名,他社出席者人数,メモ,費用負担部門名,費用負担部門コード,
プロジェクト名,税区分,通貨,為替レート,貸方勘定科目,貸方補助科目,事前申請番号
```

| Field | Value |
|-------|-------|
| 日付 | YYYY/MM/DD |
| 支払先・内容 | Operator name (JR東日本, 東京メトロ, etc.) |
| 経費科目 | 電車代 or バス代 |
| 金額（税込） | Absolute value (positive integer) |
| メモ | Train: `入駅 → 出駅` (prefixes stripped), Bus: company name |
| 通貨 | JPY |
| 為替レート | 1 |
| Others | Empty |

## Script

Converter script: `scripts/suica_to_csv.py`

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/suica-to-csv/scripts/suica_to_csv.py <text-file> [--start-year YYYY] [--end-year YYYY] [-o output.csv]
```

The script takes the text file (one transaction per line, from Workflow step 4), not the PDF. It writes the CSV to `-o` (default: `suica_transactions.csv` in CWD). Unknown arguments exit non-zero.
