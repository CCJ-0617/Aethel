# Aethel Packing Feature Implementation Plan

> Git-style Google Drive sync with intelligent directory packing

---

## Executive Summary

本文件詳述 Aethel 專案的「目錄打包同步」功能實作計畫，旨在解決大量小檔案同步效能問題。透過將特定目錄打包成單一壓縮檔上傳，可將 API 呼叫次數從數萬次降至數十次，大幅提升同步速度。

**預估效益**
| 指標 | 現狀 | 目標 |
|------|------|------|
| 掃描 10,000 個檔案 | 30 秒 | < 3 秒 |
| 上傳 node_modules | 30+ 分鐘 | < 2 分鐘 |
| API 呼叫次數 | ~10,000 | ~100 |

---

## 現有架構分析

### 目錄結構

```
src/
├── cli.js                    # CLI 入口，commander 定義
├── core/
│   ├── repository.js         # 統一資料存取層 ★ 主要整合點
│   ├── config.js             # workspace 設定、state 持久化
│   ├── snapshot.js           # 本地掃描、MD5、快照建立
│   ├── diff.js               # 變更偵測（local vs remote）
│   ├── staging.js            # stage/unstage 操作
│   ├── sync.js               # 執行同步（上傳/下載/刪除）
│   ├── drive-api.js          # Google Drive API 封裝
│   ├── local-fs.js           # 本地檔案操作
│   └── ignore.js             # .aethelignore 處理
└── tui/                      # 終端 UI（Ink/React）
```

### 關鍵整合點

| 模組 | 角色 | 修改需求 |
|------|------|----------|
| `repository.js` | 所有操作的統一入口 | 新增 pack 相關方法 |
| `config.js` | 設定持久化 | 新增 pack manifest |
| `snapshot.js` | 掃描邏輯 | 跳過 packed 目錄，改用 tree hash |
| `sync.js` | 執行同步 | 處理 pack 上傳/下載 |
| `diff.js` | 變更偵測 | 支援 pack 層級比對 |

---

## Stage 1: Foundation（基礎建設）

**目標**：建立打包基礎設施，不改變現有行為

**Duration**：3-5 天

### 1.1 設定檔擴展

**檔案**：`src/core/config.js`

**新增功能**：
- `loadPackConfig(root)` - 讀取打包設定
- `savePackManifest(root, manifest)` - 儲存 manifest
- `loadPackManifest(root)` - 讀取 manifest
- `PACK_MANIFEST_FILE = '.aethel/pack-manifest.json'`

**設定格式** `.aethelconfig`：

```yaml
packing:
  enabled: true
  
  compression:
    default:
      algorithm: zstd    # gzip | zstd | brotli | xz | none
      level: 6           # 演算法特定範圍
      
    overrides:
      - path: assets/images
        algorithm: none
      - path: src
        algorithm: zstd
        level: 12
        
  rules:
    - path: node_modules
      strategy: full
    - path: .git
      strategy: full
    - path: vendor
      strategy: full
```

### 1.2 Pack 核心模組

**新檔案**：`src/core/pack.js`

**Exports**：

| 函數 | 說明 |
|------|------|
| `createPack(sourcePath, destPath, options)` | tar + 壓縮打包 |
| `extractPack(packPath, destPath)` | 解壓到目標 |
| `getTreeHash(dirPath)` | 快速目錄指紋（mtime + size） |
| `isPackStale(localHash, manifestHash)` | 比對是否需要重新打包 |

**Tree Hash 演算法**（關鍵優化）：

```javascript
async function getTreeHash(dirPath) {
  const entries = await fs.readdir(dirPath, { 
    recursive: true, 
    withFileTypes: true 
  });
  
  // 只用 metadata，不讀檔案內容
  const fingerprint = entries
    .filter(e => e.isFile())
    .map(e => {
      const stat = statSync(join(dirPath, e.name));
      return `${e.name}:${stat.mtimeMs}:${stat.size}`;
    })
    .sort()
    .join('\n');
  
  return crypto.createHash('sha256')
    .update(fingerprint)
    .digest('hex');
}
```

**效能差異**：
- MD5 逐檔（10,000 檔）：~30 秒
- Tree Hash（只讀 mtime+size）：~1-2 秒

### 1.3 Pack Manifest 結構

**新檔案**：`src/core/pack-manifest.js`

**Manifest 格式**：

```json
{
  "version": 1,
  "packs": {
    "node_modules": {
      "packId": "pack-nm-a1b2c3",
      "driveFileId": "1ABC...",
      "localTreeHash": "sha256:...",
      "remoteTreeHash": "sha256:...",
      "fileCount": 12453,
      "originalSize": 524288000,
      "packedSize": 125829120,
      "compression": {
        "algorithm": "zstd",
        "level": 6
      },
      "lastSync": "2024-01-15T10:30:00Z"
    }
  }
}
```

**Exports**：

| 函數 | 說明 |
|------|------|
| `createManifest()` | 建立空 manifest |
| `getPack(manifest, path)` | 取得特定 pack 資訊 |
| `setPack(manifest, path, data)` | 設定 pack 資訊 |
| `removePack(manifest, path)` | 移除 pack |
| `listPacks(manifest)` | 列出所有 packs |

### 1.4 壓縮模組

**新檔案**：`src/core/compress.js`

**支援演算法**：

| 演算法 | 副檔名 | 壓縮率 | 速度 | Node.js 套件 |
|--------|--------|--------|------|--------------|
| none | `.tar` | 0% | 最快 | - |
| gzip | `.tar.gz` | 基準 | 中 | 原生 `zlib` |
| zstd | `.tar.zst` | +10-20% | 極快 | `@bokuweb/zstd-wasm` |
| brotli | `.tar.br` | +15-25% | 慢 | 原生 `zlib.brotli` |
| xz | `.tar.xz` | +25-35% | 很慢 | `lzma-native` |

**Compression Profiles**：

| Profile | 演算法 | 等級 | 適用情境 |
|---------|--------|------|----------|
| `fast` | zstd | 1 | 頻繁同步、網速快 |
| `balanced` | zstd | 6 | **預設**，一般使用 |
| `maximum` | zstd | 19 | 備份、網速慢 |
| `extreme` | xz | 6 | 歸檔、極少存取 |

### Stage 1 Deliverables

- [ ] `.aethelconfig` 解析（packing rules + compression）
- [ ] `pack.js` 模組（tar/untar + tree hash）
- [ ] `pack-manifest.js` 模組（CRUD）
- [ ] `compress.js` 模組（多演算法支援）
- [ ] 單元測試覆蓋
- [ ] Feature flag: `packing.enabled`（不影響現有功能）

---

## Stage 2: Scan Integration（掃描整合）

**目標**：讓 `aethel status` 識別 packed 目錄

**Duration**：3-4 天

### 2.1 修改 snapshot.js

**核心變更**：packed 目錄只算 tree hash，不逐檔掃描

```javascript
async function scanLocal(root, options) {
  const packConfig = loadPackConfig(root);
  const packManifest = loadPackManifest(root);
  
  for (const entry of entries) {
    const packRule = packConfig.getRule(entry.relativePath);
    
    if (packRule) {
      // Packed 目錄：只算 tree hash
      result[entry.relativePath] = {
        isPacked: true,
        treeHash: await getTreeHash(entry.fullPath),
        packRule: packRule.strategy,
      };
      continue;  // 不遞迴進入
    }
    
    // 一般檔案：照舊處理
  }
}
```

### 2.2 修改 diff.js

**新增 Pack 層級比對**：

```javascript
function detectChanges(snapshot, localFiles, remoteFiles) {
  const changes = [];
  
  for (const [path, local] of Object.entries(localFiles)) {
    if (local.isPacked) {
      const manifest = getPackManifest(path);
      
      if (local.treeHash !== manifest?.localTreeHash) {
        changes.push({
          type: 'pack_modified',
          path,
          treeHash: local.treeHash,
        });
      }
      continue;
    }
    
    // 一般檔案比對照舊
  }
}
```

### 2.3 Status 輸出調整

```bash
$ aethel status

Changes to be committed:
  modified:   src/index.js
  new file:   src/utils.js

Packed directories:
  outdated:   node_modules/    (local changed, needs push)
  synced:     .git/            (up to date)
  conflict:   vendor/          (both changed)
  
Untracked:
  temp/
```

### Stage 2 Deliverables

- [ ] `snapshot.js` 跳過 packed 目錄
- [ ] `diff.js` 支援 pack 層級比對
- [ ] `status` 命令顯示 pack 狀態
- [ ] 掃描速度測試（目標：10x 提升）

---

## Stage 3: Sync Integration（同步整合）

**目標**：`push` / `pull` 支援 pack 上傳下載

**Duration**：5-7 天

### 3.1 Pack Upload Flow

**流程圖**：

```
1. 掃描打包目錄
   └─ 計算 tree hash

2. 比對 manifest
   └─ hash 變了？需要重新打包

3. 打包變動的目錄
   └─ tar + compress → /tmp/pack-xxx.tar.zst

4. 上傳 pack 檔
   └─ 1 次 API 呼叫

5. 更新 manifest
   └─ 記錄新的 packId、driveFileId、hash
```

**修改 `sync.js`**：

```javascript
async function executePush(drive, root, staged) {
  const packConfig = loadPackConfig(root);
  const manifest = loadPackManifest(root);
  
  // 1. 處理需要打包的目錄
  for (const rule of packConfig.rules) {
    const localHash = await getTreeHash(rule.path);
    const packInfo = manifest.packs[rule.path];
    
    if (localHash !== packInfo?.localTreeHash) {
      // 需要重新打包上傳
      const packPath = await createPack(rule.path, tmpDir, {
        compression: rule.compression
      });
      const driveFile = await uploadFile(drive, packPath, ...);
      
      updateManifest(manifest, rule.path, {
        driveFileId: driveFile.id,
        localTreeHash: localHash,
        remoteTreeHash: localHash,
      });
    }
  }
  
  // 2. 處理一般檔案（現有邏輯）
  for (const entry of staged.filter(e => !isPacked(e.path))) {
    // ...existing upload logic...
  }
}
```

### 3.2 Pack Download Flow

```javascript
async function executePull(drive, root) {
  const manifest = loadPackManifest(root);
  const remoteManifest = await fetchRemoteManifest(drive);
  
  for (const [path, remote] of Object.entries(remoteManifest.packs)) {
    const local = manifest.packs[path];
    
    if (remote.remoteTreeHash !== local?.remoteTreeHash) {
      // 1. 下載 pack 檔
      const packPath = await downloadFile(
        drive, remote.driveFileId, tmpDir
      );
      
      // 2. 清空本地目錄
      await fs.rm(path, { recursive: true, force: true });
      
      // 3. 解包
      await extractPack(packPath, path);
      
      // 4. 更新 manifest
      updateManifest(manifest, path, {
        localTreeHash: remote.remoteTreeHash,
        remoteTreeHash: remote.remoteTreeHash,
      });
    }
  }
}
```

### 3.3 Repository.js 整合

```javascript
class Repository {
  // 新增方法
  async getPackStatus() { }
  async pushPacks() { }
  async pullPacks() { }
  
  // 修改現有方法
  async push(options) {
    if (this.packConfig.enabled) {
      await this.pushPacks();  // 先處理 packs
    }
    // ...existing push logic...
  }
  
  async pull(options) {
    if (this.packConfig.enabled) {
      await this.pullPacks();  // 先處理 packs
    }
    // ...existing pull logic...
  }
}
```

### Stage 3 Deliverables

- [ ] Pack 上傳流程
- [ ] Pack 下載流程
- [ ] Manifest 同步（本地 ↔ 遠端）
- [ ] `repository.js` 整合
- [ ] 錯誤處理（上傳中斷、解包失敗）
- [ ] 進度顯示

---

## Stage 4: Auto-Pack Detection（自動偵測）

**目標**：智慧判斷哪些目錄適合打包

**Duration**：4-5 天

### 4.1 判斷維度

```
目錄是否適合打包？
       │
       ├─ 檔案數量 ─────────→ > 100 個？
       ├─ 平均檔案大小 ────→ < 100KB？
       ├─ 變更頻率 ────────→ 整體變動 vs 單檔變動？
       ├─ 存取模式 ────────→ 需要單檔預覽/分享？
       ├─ 檔案類型 ────────→ 已壓縮？可壓縮？
       └─ 目錄特徵 ────────→ 已知模式？
```

### 4.2 決策矩陣

| 條件 | 分數 |
|------|------|
| 檔案數 > 100 | +30 |
| 檔案數 > 1000 | +50 |
| 平均大小 < 100KB | +20 |
| 平均大小 < 10KB | +30 |
| 已知打包模式（node_modules 等） | +80 |
| 多為文字/程式碼 | +10 |
| 多為已壓縮格式 | -20 |
| 近期單檔變更頻繁 | -30 |
| 需要協作/分享 | -50 |

**閾值**：分數 ≥ 60 → 建議打包

### 4.3 已知模式識別

```javascript
const KNOWN_PACK_PATTERNS = [
  // 依賴目錄（幾乎必定打包）
  { pattern: 'node_modules',  score: 95, reason: 'npm dependencies' },
  { pattern: 'vendor',        score: 90, reason: 'composer/go deps' },
  { pattern: '.venv',         score: 90, reason: 'Python virtualenv' },
  { pattern: '__pycache__',   score: 85, reason: 'Python cache' },
  { pattern: '.gradle',       score: 85, reason: 'Gradle cache' },
  { pattern: 'Pods',          score: 85, reason: 'CocoaPods' },
  
  // 版本控制
  { pattern: '.git',          score: 80, reason: 'Git repository' },
  { pattern: '.svn',          score: 80, reason: 'SVN repository' },
  
  // 建置輸出
  { pattern: '.next',         score: 70, reason: 'Next.js cache' },
  { pattern: '.nuxt',         score: 70, reason: 'Nuxt.js cache' },
  
  // 快取
  { pattern: '.cache',        score: 75, reason: 'Cache directory' },
  { pattern: '.parcel-cache', score: 80, reason: 'Parcel cache' },
];
```

### 4.4 分析模組

**新檔案**：`src/core/pack-analyzer.js`

**Exports**：

| 函數 | 說明 |
|------|------|
| `analyzeDirectory(dirPath)` | 分析單一目錄 |
| `analyzeWorkspace(root)` | 分析整個 workspace |
| `quickAnalyze(dirPath)` | 輕量分析（不讀內容） |

**輸出結構**：

```javascript
{
  path: 'node_modules',
  recommendation: {
    score: 92,
    shouldPack: true,
    confidence: 84,
    reasons: [
      '12,453 files (very high)',
      'avg 38KB (small files)',
      'npm dependencies (known pattern)'
    ],
    suggestedStrategy: 'full',
    suggestedCompression: { algorithm: 'zstd', level: 6 }
  },
  stats: {
    fileCount: 12453,
    totalSize: 485000000,
    avgFileSize: 38900,
    typeDistribution: { code: 0.72, json: 0.18, other: 0.10 },
    compressibility: 0.78
  }
}
```

### 4.5 CLI 介面

```bash
# 分析整個 workspace
$ aethel pack analyze

Analyzing workspace...

RECOMMENDED FOR PACKING:
┌─────────────────┬───────┬─────────┬────────┬─────────────────────────┐
│ Directory       │ Files │ Size    │ Score  │ Reason                  │
├─────────────────┼───────┼─────────┼────────┼─────────────────────────┤
│ node_modules/   │ 12453 │ 485MB   │ 95 ✓✓  │ npm dependencies        │
│ .git/           │ 3421  │ 120MB   │ 80 ✓   │ Git repository          │
│ .venv/          │ 8234  │ 312MB   │ 90 ✓✓  │ Python virtualenv       │
└─────────────────┴───────┴─────────┴────────┴─────────────────────────┘

NOT RECOMMENDED:
┌─────────────────┬───────┬─────────┬────────┬─────────────────────────┐
│ documents/      │ 45    │ 230MB   │ 25 ✗   │ few files, large size   │
│ src/            │ 89    │ 2.3MB   │ 35 ✗   │ frequent single changes │
└─────────────────┴───────┴─────────┴────────┴─────────────────────────┘

Estimated improvement:
  Current:  15,697 files → 15,697 API calls
  Packed:   489 files + 4 packs → 493 API calls
  Reduction: 97%

Apply recommendations? [Y/n/customize]
```

### 4.6 自動模式設定

```yaml
# .aethelconfig
packing:
  auto:
    enabled: true
    threshold: 60              # 分數閾值
    minFiles: 50               # 最少檔案數才考慮
    excludePatterns:
      - "documents/**"
      - "shared/**"
    confirmBeforeApply: true   # 自動偵測後詢問確認
```

### Stage 4 Deliverables

- [ ] `pack-analyzer.js` 模組
- [ ] 已知模式資料庫
- [ ] 快速統計演算法
- [ ] `aethel pack analyze` 命令
- [ ] 自動偵測整合進 `status`
- [ ] 互動式確認流程

---

## Stage 5: CLI & TUI（使用者介面）

**目標**：完整的使用者操作介面

**Duration**：3-4 天

### 5.1 新增 CLI 命令

**修改**：`cli.js`

```bash
# 初始化打包設定
aethel pack init

# 分析並建議
aethel pack analyze
aethel pack analyze ./vendor --verbose

# 新增打包規則
aethel pack add node_modules
aethel pack add node_modules --strategy full
aethel pack add assets --compression zstd --level 15

# 移除打包規則
aethel pack remove node_modules

# 列出打包狀態
aethel pack status
aethel pack status --verbose

# 強制重新打包
aethel pack refresh node_modules

# 查看 pack 內容（不解包）
aethel pack list node_modules
```

### 5.2 TUI 整合

**修改**：`tui/app.js`

Pack 狀態顯示在檔案列表中：

```
┌─ Local ─────────────────┬─ Drive ──────────────────┐
│ 📁 src/                 │ 📁 src/                  │
│ 📄 README.md            │ 📄 README.md             │
│ 📦 node_modules/ [PACK] │ 📦 pack-nm-a1b2.tar.zst │
│ 📦 .git/ [PACK]         │ 📦 pack-git-d4e5.tar.zst│
└─────────────────────────┴──────────────────────────┘

[p] Pack selected  [u] Unpack  [r] Refresh pack
```

### Stage 5 Deliverables

- [ ] `aethel pack` 子命令系列
- [ ] TUI pack 狀態顯示
- [ ] 進度條（打包/上傳/下載/解包）
- [ ] `--dry-run` 支援
- [ ] 快捷鍵支援

---

## Stage 6: Polish & Edge Cases（完善）

**目標**：處理邊界情況，提升穩定性

**Duration**：3-5 天

### 6.1 衝突處理

```bash
# 情境：本地和遠端的 pack 都有變動
$ aethel status
  conflict:   node_modules/   (both changed)

$ aethel resolve node_modules --keep local
$ aethel resolve node_modules --keep remote
```

### 6.2 部分還原

```bash
# 從 pack 中抽取單一檔案（不解包整個）
$ aethel pack extract node_modules/lodash/package.json
```

### 6.3 大 Pack 處理（Chunked）

```yaml
packing:
  rules:
    - path: assets
      strategy: chunked
      chunkSize: 100MB
```

```
assets/ (350MB)
  → assets.part1.tar.zst (100MB)
  → assets.part2.tar.zst (100MB)
  → assets.part3.tar.zst (100MB)
  → assets.part4.tar.zst (50MB)
```

### 6.4 內容感知壓縮

```yaml
packing:
  contentAware: true
  rules:
    - pattern: "*.{jpg,png,mp4,zip}"
      compression: none          # 已壓縮
    - pattern: "*.{js,ts,json}"
      compression:
        algorithm: zstd
        level: 12                # 文字高壓縮
```

### Stage 6 Deliverables

- [ ] Pack 衝突偵測與解決
- [ ] 單檔抽取功能
- [ ] Chunked 大檔案處理
- [ ] 內容感知壓縮
- [ ] 完整錯誤訊息
- [ ] README / CHANGELOG 更新

---

## Timeline Summary

| Stage | 內容 | 時間 | 累計 |
|-------|------|------|------|
| 1 | Foundation | 3-5 天 | 1 週 |
| 2 | Scan Integration | 3-4 天 | 2 週 |
| 3 | Sync Integration | 5-7 天 | 3 週 |
| 4 | Auto-Pack Detection | 4-5 天 | 4 週 |
| 5 | CLI & TUI | 3-4 天 | 5 週 |
| 6 | Polish | 3-5 天 | 6 週 |

**MVP（Stage 1-3）**：3 週可用
**完整版（Stage 1-6）**：6 週

---

## Dependencies

### 新增套件

```json
{
  "dependencies": {
    "tar": "^7.0.0",
    "yaml": "^2.3.0"
  },
  "optionalDependencies": {
    "@bokuweb/zstd-wasm": "^0.1.0",
    "lzma-native": "^8.0.0"
  }
}
```

| 套件 | 用途 | 必要性 |
|------|------|--------|
| `tar` | 打包/解包 | 必要 |
| `yaml` | 設定檔解析 | 必要 |
| `@bokuweb/zstd-wasm` | Zstd 壓縮 | 建議 |
| `lzma-native` | XZ 壓縮 | 可選 |

### 原生支援（無需額外安裝）

- `zlib`（gzip, brotli）：Node.js 內建
- `crypto`：Hash 計算

---

## Success Metrics

| 指標 | 目標 | 測量方式 |
|------|------|----------|
| 掃描速度 | < 3 秒 / 10,000 檔 | Benchmark |
| 上傳速度 | < 2 分鐘 / node_modules | Benchmark |
| API 呼叫減少 | > 90% | 計數 |
| 壓縮率 | > 60%（文字目錄） | 比較大小 |
| 現有測試通過 | 100% | CI |
| 新功能測試覆蓋 | > 80% | Coverage |

---

## Risk Assessment

| 風險 | 機率 | 影響 | 緩解措施 |
|------|------|------|----------|
| Tree hash 碰撞 | 低 | 中 | 加入檔案數量作為額外校驗 |
| 大 pack 上傳失敗 | 中 | 中 | 使用 resumable upload |
| 解包覆蓋重要檔案 | 低 | 高 | 解包前備份、確認提示 |
| 壓縮套件相容性 | 中 | 低 | Optional dependency + fallback |

---

## Future Considerations

### 可能的後續功能

1. **增量打包（Delta Pack）**
   - 只打包變動的檔案
   - 減少重複傳輸

2. **字典壓縮**
   - 對相似檔案建立共享字典
   - 進一步提升壓縮率

3. **P2P 同步**
   - 區網內裝置直接傳輸
   - 不經過 Google Drive

4. **多後端支援**
   - Google Cloud Storage
   - S3
   - 本地 NAS

---

## Appendix

### A. 完整設定檔範例

```yaml
# .aethelconfig
packing:
  enabled: true
  
  auto:
    enabled: true
    threshold: 60
    minFiles: 50
    excludePatterns:
      - "documents/**"
      - "shared/**"
    confirmBeforeApply: true
  
  compression:
    default:
      algorithm: zstd
      level: 6
    overrides:
      - path: assets/images
        algorithm: none
      - path: src
        algorithm: zstd
        level: 12
        
  rules:
    - path: node_modules
      strategy: full
      
    - path: .git
      strategy: full
      
    - path: vendor
      strategy: full
      compression:
        algorithm: zstd
        level: 9
        
    - path: large_assets
      strategy: chunked
      chunkSize: 100MB
```

### B. Manifest 完整範例

```json
{
  "version": 1,
  "syncedAt": "2024-01-15T10:30:00Z",
  "packs": {
    "node_modules": {
      "packId": "pack-nm-a1b2c3d4",
      "driveFileId": "1ABCdefGHIjklMNOpqrSTUvwxYZ",
      "strategy": "full",
      "localTreeHash": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "remoteTreeHash": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "fileCount": 12453,
      "originalSize": 524288000,
      "packedSize": 125829120,
      "compression": {
        "algorithm": "zstd",
        "level": 6
      },
      "createdAt": "2024-01-15T10:25:00Z",
      "lastSync": "2024-01-15T10:30:00Z"
    }
  }
}
```

### C. 參考資料

- [Google Drive API v3](https://developers.google.com/drive/api/v3/reference)
- [rclone Architecture](https://rclone.org/docs/)
- [Git Packfile Format](https://git-scm.com/book/en/v2/Git-Internals-Packfiles)
- [Zstandard Compression](https://facebook.github.io/zstd/)
