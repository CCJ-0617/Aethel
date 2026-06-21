# Aethel 如何運作

這份文件用繁體中文說明 Aethel 的同步模型。Aethel 不是即時同步程式，也不是單純把本機覆蓋到 Google Drive；它採用接近 Git 的流程：

```text
snapshot -> diff -> stage -> commit
```

也就是先建立共同基準，再比較本機與 Drive 的變化，最後才執行你明確暫存的同步動作。

## 核心概念

Aethel 每次判斷狀態時會看三份資料：

- 上一次成功同步後的 snapshot
- 目前本機檔案狀態
- 目前 Google Drive 檔案狀態

它不是只比較「本機 vs Drive」。snapshot 是判斷變更方向的基準線。

## Workspace 狀態

初始化後，workspace 裡會有 `.aethel/`：

```text
.aethel/
  config.json
  index.json
  .hash-cache.json
  pack-manifest.json
  snapshots/
    latest.json
    history/
.aethelignore
.aethelconfig
```

主要用途：

- `config.json`：記錄本機路徑與 Drive folder id
- `index.json`：staging area，記錄準備執行的同步動作
- `.hash-cache.json`：本機 hash 快取
- `snapshots/latest.json`：最新同步基準
- `snapshots/history/`：歷史 snapshots
- `.aethelignore`：忽略規則
- `.aethelconfig`：進階設定，例如 directory packing

## Diff 如何判斷

Aethel 會把變更分類為：

| 類型 | 意義 | 預設動作 |
| --- | --- | --- |
| `remote_added` | Drive 新增 | download |
| `remote_modified` | Drive 修改 | download |
| `remote_deleted` | Drive 刪除 | delete_local |
| `local_added` | 本機新增 | upload |
| `local_modified` | 本機修改 | upload |
| `local_deleted` | 本機刪除 | delete_remote |
| `conflict` | 兩邊都改了同一路徑 | 需要 resolve |

如果同一個檔案在本機和 Drive 都已刪除，Aethel 會視為已同步，不會再顯示變更。

## Stage 與 Commit

`aethel add` 會掃描本機、讀 snapshot、取得遠端狀態並重新計算 diff，然後把符合條件的動作寫入：

```text
.aethel/index.json
```

`aethel commit` 會真正執行 staged operations：

- `download`：從 Drive 下載到本機
- `upload`：從本機上傳到 Drive
- `delete_local`：刪除本機檔案或資料夾
- `delete_remote`：把 Drive 檔案或資料夾移到垃圾桶

成功後會重新保存 snapshot。若有操作失敗，失敗項目會留在 staging area。

## Pull 與 Push

`pull` 偏向接受 Drive 的變更：

```bash
aethel pull -m "pull"
```

`push` 偏向接受本機的變更：

```bash
aethel push -m "push"
```

`push --force` 會讓本機更具權威性，可能把 Drive-only additions 轉成 remote delete。使用前建議先看：

```bash
aethel status --detail
aethel diff --side all --detail
```

## Rename 的處理方式

Aethel 主要用 path 變化描述 rename，所以 rename 常會表示為：

```text
old path deleted + new path added
```

Drive 端如果同一個 file id 改了路徑，Aethel 會把它視為舊路徑刪除與新路徑新增，讓同步後本機也更新名稱。

## Conflict

當本機和 Drive 都相對於 snapshot 改了同一路徑時，Aethel 會顯示 conflict。

常用解法：

```bash
aethel resolve <path> --keep local
aethel resolve <path> --keep remote
aethel resolve <path> --keep both
aethel commit -m "resolve"
```

## Remote Cache 與 Remote Memo

Aethel 有兩種遠端加速機制：

- remote cache：本機 `.aethel/.remote-cache.json`，短期快取遠端列表
- remote memo：Drive 上的 `.aethel-remote-memo-*.json`，用於大型 Drive folder 的增量掃描

如果懷疑狀態來自舊 cache，可以刪除本機 remote cache：

```bash
rm -f .aethel/.remote-cache.json
```

如果懷疑 remote memo 過舊，可以暫時關閉 memo 重新抓遠端：

```bash
AETHEL_REMOTE_MEMO=off aethel fetch
```

## 建議日常流程

```bash
aethel status
aethel diff
aethel add -A
aethel diff --staged
aethel commit -m "sync"
```

第一次完整下載或需要重新補齊本機檔案時：

```bash
aethel pull --all -m "initial pull"
```

## 總結

Aethel 的心智模型是：

```text
last snapshot + current local + current Drive
        -> compute diff
        -> stage operations
        -> execute commit
        -> write next snapshot
```

重點不是自動同步所有東西，而是讓每一次同步都有可檢查、可暫存、可回溯的狀態。
