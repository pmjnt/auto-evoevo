# Auto EvoEvo Extension

Extension Chrome MV3 thay thế Playwright runner. Cài vào Chrome thường (không cần profile riêng, không cần Node chạy nền), extension đóng vai trò ví trên `https://evoevo.ai`: tự bấm `ADD TO MEMORY`, kiểm tra mỗi giao dịch bằng guard, ký bằng key đã unlock và broadcast lên 0G RPC.

> Spec: `docs/superpowers/specs/2026-05-22-auto-evoevo-extension-design.md`
> Plan: `docs/superpowers/plans/2026-05-22-auto-evoevo-extension.md`

---

## Yêu cầu trước khi cài

| | Cần |
|---|---|
| Node.js | ≥ 20 (extension build dùng esbuild + ESM) |
| Chrome | ≥ 120 |
| Rabby (hoặc ví khác) | Đã add network 0G — cần copy `RPC URL` và `Chain ID` từ đó sang. |
| Ví burner | **Nên tạo ví mới riêng cho automation**, nạp ít OG đủ dùng. Đừng dùng ví chính. |
| Function selector | 4 byte đầu (`0x` + 8 hex) của `data` từ một giao dịch ADD TO MEMORY thật trên 0G explorer (xem [Phụ lục A](#phụ-lục-a-lấy-function-selector)). |

---

## 1. Build extension

```powershell
cd extension
npm install
npm run build
```

Sau khi build xong, thư mục `extension/dist/` chứa các file:

```
dist/
├── manifest.json
├── background.js
├── content.js
├── inpage.js
├── popup.html
├── popup.js
├── options.html
└── options.js
```

Đây là thư mục bạn sẽ load vào Chrome ở bước tiếp theo.

> Nếu PowerShell chặn `npm.ps1` vì execution policy, dùng `npm.cmd` thay cho `npm`.

---

## 2. Cài extension vào Chrome (unpacked)

1. Mở Chrome → vào URL `chrome://extensions`.
2. Bật toggle **Developer mode** ở góc phải trên.
3. Bấm **Load unpacked** → chọn thư mục `extension/dist` (tuyệt đối, không chọn `extension/` bao ngoài).
4. Extension xuất hiện trong danh sách với tên **Auto EvoEvo** version `0.1.0`.
5. Ghim extension lên thanh công cụ: bấm icon mảnh ghép cạnh thanh địa chỉ → ghim **Auto EvoEvo**.

Nếu Chrome báo lỗi load:
- Kiểm tra `extension/dist/manifest.json` có tồn tại (nếu không thì build chưa xong).
- Mở DevTools của service worker (link "Errors" bên cạnh extension trong `chrome://extensions`) để xem chi tiết.

---

## 3. Cấu hình lần đầu

Bấm chuột phải lên icon extension → **Options** (hoặc vào `chrome://extensions` → Details → Extension options).

Trang options yêu cầu các trường sau:

| Field | Giá trị mẫu | Ghi chú |
|---|---|---|
| **0G RPC URL** | `https://evmrpc-testnet.0g.ai` (hoặc URL từ Rabby) | Copy nguyên xi từ network 0G trong Rabby. |
| **Chain id** | `16601` testnet, hoặc số tương ứng từ Rabby | Phải khớp chain id trong Rabby, sai → tx bị reject. |
| **Max fee (OG)** | `0.001` | Cap fee tối đa cho 1 tx. Vượt → guard reject. |
| **Allowed contracts** | `0x61bb710000000000000000000000000000e937f9` | Cách nhau bằng dấu phẩy nếu có nhiều. Copy nguyên xi (lower-case OK, extension tự normalize). |
| **Allowed function selectors** | `0xd0e30db0` | 4 byte đầu của data. Xem [Phụ lục A](#phụ-lục-a-lấy-function-selector) để biết cách lấy. |
| **Idle-lock minutes** | `30` | Sau X phút không ký → tự khoá vault, phải nhập password lại. |
| **Dry-run mode** | ☑ tick (default) | **Lần đầu LUÔN để dry-run ON.** Bỏ tick chỉ khi đã smoke test xong. |
| **Private key** | `0x...` (32-byte hex) | **CHỈ dùng burner wallet.** Sau khi save sẽ tự clear khỏi form. |
| **Master password** | (tối thiểu 8 ký tự) | Dùng để mã hoá vault AES-GCM. Quên password = mất key, phải import lại. |

Bấm **Save**. Status hiển thị "Saved" màu xanh.

> Sau khi save thành công, private key đã được mã hoá AES-GCM với password và lưu trong `chrome.storage.local`. Field "Private key" tự clear, không lưu nguyên text.

---

## 4. Tắt Rabby trên `evoevo.ai`

Cả Rabby và Auto EvoEvo đều muốn làm `window.ethereum`. Để extension thắng, tắt Rabby riêng cho site này:

**Rabby:** Settings → Connected Sites → tìm `evoevo.ai` → Disconnect, hoặc:
- Rabby settings → "Inject script" → Disable cho `evoevo.ai`.

Hoặc disable Rabby toàn cục khi automation đang chạy (`chrome://extensions` → tắt toggle Rabby).

> Nếu sau này muốn dùng lại Rabby trên evoevo.ai → bật lại, nhưng nhớ disable Auto EvoEvo nếu không cần.

---

## 5. Chạy thử (Dry-run)

**Mục đích:** xác nhận extension đọc đúng giao dịch EvoEvo build mà KHÔNG thực sự ký.

1. Mở tab `https://evoevo.ai/feed`. Đăng nhập nếu cần.
2. Bấm icon extension → popup hiện form nhập password.
3. Nhập master password đã set ở bước 3 → bấm **Unlock**.
4. Popup chuyển sang trạng thái unlocked, hiện địa chỉ ví + dòng **Status** + counter `Signed/Dry-run/Manual/Rejected`.
5. Bấm **Start** trong popup. Dòng status chuyển sang `running` (màu xanh), và popup hiện `Started on N EvoEvo tab(s).` ở dưới.

   > Nếu thấy `No evoevo.ai tab open`: mở `https://evoevo.ai/feed` trước, rồi bấm Start lại.

6. Extension bắt đầu click ADD TO MEMORY. Trên popup, counter **Dry-run** tăng dần (auto-refresh 2s/lần).
7. Muốn tạm dừng: bấm **Pause** — nút đổi thành **Resume**, status → `paused` (vàng). Bấm Resume tiếp tục.
8. Mở Service Worker DevTools (`chrome://extensions` → Auto EvoEvo → "service worker" link) → Console hiển thị log entries:
   ```
   { status: "dry_run", reason: "Wallet request matches EvoEvo memory guardrails", ... }
   ```
9. Kiểm tra trên [0G explorer](https://chainscan-newton.0g.ai) — **không có giao dịch mới** xuất hiện cho địa chỉ ví.

Nếu mọi thứ OK ở bước 9: dry-run đã verify guard đọc đúng params. Sang bước 6 production.

### Sự cố thường gặp ở bước dry-run

| Triệu chứng | Nguyên nhân | Cách xử lý |
|---|---|---|
| Popup không hiện sau khi bấm icon | Service worker đang ngủ | Mở `chrome://extensions` → Auto EvoEvo → bấm "service worker" để wake. Hoặc reload tab. |
| Click ADD TO MEMORY → popup pause với "rejected" | Rabby vẫn intercept; Auto EvoEvo bị overshadow | Xem bước 4, tắt Rabby chắc chắn. Reload tab. |
| Pause với reason "Function selector not whitelisted: 0x..." | Selector của EvoEvo khác với cái bạn nhập | Copy selector từ reason → cập nhật Options → Save. |
| Pause với reason "Estimated fee ... exceeds cap" | Gas tăng cao hơn `maxFeeNative` | Tăng `Max fee (OG)` trong Options nếu fee thật sự cần cao hơn. Hoặc check gasPrice trên 0G. |

---

## 6. Chạy thật (Production)

Chỉ làm sau khi dry-run sạch.

1. Options → bỏ tick **Dry-run mode** → Save.
2. Click 1 card EvoEvo (hoặc trigger automation cho 1 vòng).
3. Mở 0G explorer → kiểm tra giao dịch mới với `to = contract whitelist` và fee ≤ cap.
4. Verify trên popup: counter **Signed** = 1.

**Test guardrail còn hoạt động không:** Options → giảm `Max fee` xuống `0.00001` (rất thấp) → Save → trigger 1 lần nữa. Extension PHẢI pause với reason "Estimated fee X exceeds cap 0.00001", không được ký.

Nếu pass cả 2 test → bật lại `maxFeeNative` về 0.001, để dry-run OFF, và chạy automation full feed.

---

## 7. Cách dừng / khoá

- **Tạm dừng tự động:** popup → nút **Pause**. Mọi `eth_sendTransaction` sau đó sẽ bị router reject với code 4001 "Automation paused".
- **Khoá vault:** popup → nút **Lock**. Key biến khỏi RAM, ký lần sau cần unlock lại.
- **Tự khoá:** sau `idleLockMinutes` không có activity, vault tự lock.
- **Đóng Chrome:** vault tự lock (state in-memory).
- **Stop hoàn toàn:** `chrome://extensions` → tắt toggle Auto EvoEvo.

---

## 8. Update khi có version mới

```powershell
cd extension
git pull
npm install
npm run build
```

Sau đó vào `chrome://extensions` → Auto EvoEvo → bấm nút Reload (icon mũi tên tròn).

Config và vault đã lưu trong `chrome.storage.local` không mất qua reload.

---

## Phụ lục A — Lấy function selector

1. Mở [0G explorer](https://chainscan-newton.0g.ai) cho mainnet hoặc testnet tương ứng.
2. Tìm địa chỉ ví bạn — phần "Transactions".
3. Lọc các transaction tới contract EvoEvo (`0x61bb71...`).
4. Bấm vào 1 tx ADD TO MEMORY thành công.
5. Trong tab **Input Data**, lấy **10 ký tự đầu tiên** (gồm `0x`):
   ```
   0xd0e30db0a1b2c3d4...
   ↑─────────↑
   10 chars = 0x + 8 hex = function selector
   ```
6. Paste vào field "Allowed function selectors" của Options.

Nếu thấy nhiều selector khác nhau ở các tx khác nhau → liệt kê tất cả, cách nhau dấu phẩy.

---

## Phụ lục B — Architecture nhanh

```
Tab evoevo.ai           Service worker (background)
┌──────────────┐         ┌─────────────────────────┐
│ inpage.js    │←postMsg→│ router                  │
│ (window.     │         │   ├─ wallet (key RAM)   │
│  ethereum)   │         │   ├─ guard              │
│              │         │   ├─ pipeline           │←─ 0G RPC
│ content.js   │←runtime→│   ├─ session log        │
│ (auto-click) │         │   └─ inflight reconc.   │
└──────────────┘         └─────────────────────────┘
                                    ▲
                                    │ messages
                         ┌──────────┴───────┐
                         │ popup / options  │
                         └──────────────────┘
```

- Private key chỉ tồn tại trong service worker sau khi unlock — **không bao giờ** rơi vào tab EvoEvo.
- Origin verify dựa trên `sender.tab.url` (Chrome-controlled), không tin field do content script gửi.
- Mọi tx phải qua guard: origin + chain + contract + value=0 + fee ≤ cap + function selector whitelist.
- Reject về EvoEvo luôn là code 4001 — không leak guard reason ra trang.

---

## Phụ lục C — Known gaps (v0.1.0)

Các điểm chưa hoàn thiện, ghi để bạn nắm:

1. **`postMessage` dùng `"*"` targetOrigin** (defense-in-depth chưa tight). Risk thấp vì content vẫn filter qua field `source`.
2. **Service worker bị Chrome kill khi rảnh.** Sau khi wake lại, vault locked → phải unlock lại. Inflight reconciliation đã có để không double-broadcast tx đã pending.
3. **Manifest có `scripting` permission nhưng codebase chưa dùng.** Có thể xoá khi không cần.
4. **Schema có `export-log` nhưng router chưa wire.** Không gây lỗi, chỉ trả `Unhandled type`. (`start`/`stop` đã wire.)
5. **Chưa poll receipt trên 0G** sau khi broadcast — log entry `signed` ngay sau broadcast, không biết tx có revert on-chain hay không. Cần thêm task nếu muốn.

---

## Test + build local

```powershell
cd extension
npm test          # 55 tests across 12 files
npm run typecheck # tsc --noEmit, exit 0
npm run build     # bundle vào dist/
```

Mọi PR/commit phải pass cả 3.
