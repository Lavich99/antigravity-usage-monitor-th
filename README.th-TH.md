<div align="center">

<img src="assets/logo.svg" alt="Antigravity Usage & Speed Monitor Logo" width="84" />

# Antigravity Usage & Speed Monitor (เวอร์ชันภาษาไทย)

**[English](README.md) | [ภาษาไทย](README.th-TH.md)**

ปลั๊กอินติดตามการใช้ Token, ความเร็วสร้างคำตอบ (`tok/s`), `TTFT`, หลอด Context Window, โควต้าคงเหลือ และการทำงานของ Subagent แบบเรียลไทม์ ออกแบบสำหรับ **Google Antigravity App (Desktop)** โดยเฉพาะ — ทำงานออฟไลน์ 100% ปลอดภัย ไม่ใช้ LLM และไม่ดักแก้ Request

[![Release](https://img.shields.io/github/v/release/Lavich99/antigravity-usage-monitor-th?style=flat-square&color=2A5E76&label=release)](https://github.com/Lavich99/antigravity-usage-monitor-th/releases/latest)
[![Stars](https://img.shields.io/github/stars/Lavich99/antigravity-usage-monitor-th?style=flat-square&color=f59e0b)](https://github.com/Lavich99/antigravity-usage-monitor-th/stargazers)
[![License](https://img.shields.io/github/license/Lavich99/antigravity-usage-monitor-th?style=flat-square&color=3b82f6)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20npm%20packages-10b981?style=flat-square)](#พัฒนาต่อและบิลด์ไฟล์)
[![Supported App](https://img.shields.io/badge/รองรับเฉพาะ-Antigravity%20App%20(Desktop)-6366f1?style=flat-square)](#ขอบเขตการรองรับ)

[ขอบเขตการรองรับ](#ขอบเขตการรองรับ) · [ฟีเจอร์เด่น](#ฟีเจอร์เด่น) · [วิธีติดตั้ง](#วิธีติดตั้ง) · [วิธีใช้งาน](#วิธีใช้งาน) · [ความปลอดภัย](#ความปลอดภัยและข้อมูลส่วนตัว)

</div>

---

## ขอบเขตการรองรับ

> [!IMPORTANT]
> **ปลั๊กอินเวอร์ชันนี้ทดสอบและรองรับเฉพาะ Google Antigravity App (เวอร์ชัน Desktop) เท่านั้น** (`Windows` / `macOS` / `Linux`)
> ส่วนที่เกี่ยวข้องกับ **Antigravity CLI (`agy`)**, **Antigravity IDE (VS Code extension / `.monaco-workbench`)**, **Standalone Web Server**, ตัวอ่าน Credential และระบบอัปเดตออนไลน์ถูกถอดออกทั้งหมด เพื่อไม่ให้มีฟีเจอร์ที่ยังไม่ได้รับประกันการทำงานปะปนอยู่

โปรเจกต์นี้แยกสายพัฒนา (Hard Fork) ต่อยอดจาก [`yuhuan-dev/antigravity-usage-monitor`](https://github.com/yuhuan-dev/antigravity-usage-monitor) เพื่อปรับแต่งให้เหมาะกับการใช้งานภาษาไทยบน Antigravity App โดยตรง

---

## ฟีเจอร์เด่น

- **ภาษาไทย + ค่าเงินบาท (`฿`) ทันทีตั้งแต่เริ่มต้น:**
  - เมนูภาษาไทย (`th-TH`), ตัวอักษรขนาดกะทัดรัด (`sm`), แปลงประมาณการค่าใช้จ่ายเป็นเงินบาท (`฿`) อัตโนมัติ (สลับเป็นอังกฤษ `en-US` ได้ตลอด)
- **Capsule บนกล่องพิมพ์ (Composer) แบบ 1–2 ช่อง:**
  - แสดงเลขทศนิยม 2 ตำแหน่ง (`64.30%`, `52.87%`) แบบความกว้างช่องคงที่ ตัวเลขไม่ดิ้นไปมา
  - เลือกแสดงได้ **1–2 ช่อง** ลากสลับซ้าย-ขวา หรือปิดเหลืออันเดียวได้อิสระ (ค่าเริ่มต้น: **โควต้า Gemini 5 ชม.** + **Context (%)**)
  - ค่าเริ่มต้นวางในกล่องพิมพ์ (**Composer Mount**) พร้อมย้ายปุ่ม Permission (`Auto`/`Turbo`) มาชิดปุ่ม Model ให้อัตโนมัติ
- **แอนิเมชัน 60fps ลื่นไหล & หลอด Context หมุนเมื่อ AI ทำงาน:**
  - ตัวเลขและวงแหวน SVG เคลื่อนที่แบบ `420ms easeInOutCubic` 60fps เมื่อค่าเปลี่ยนแปลง
  - เมื่อ AI กำลังรันคำสั่ง (`is-running`) วงแหวนสีของ **Context Window** จะหมุนแบบ `ease-in-out 60fps` บน GPU เฉพาะห้องแชทที่กำลังทำงาน
  - ดึงข้อมูลแบบ **Adaptive Real-Time** (`700ms` ตอนรัน / `2000ms` ตอนพัก / `8000ms` เมื่อพับหน้าจอ) พร้อมดึงเฉพาะ Step ส่วนเพิ่ม ลดภาระ CPU/RAM
- **รองรับ Split View เต็มรูปแบบ และแยกข้อมูลแชทใหม่ชัดเจน:**
  - เปิด Split 2 หน้าต่างพร้อมกันจะได้ Capsule แยกตามแชทจริงของแต่ละฝั่ง (รวมถึงแชทใหม่ที่ยังไม่พิมพ์ข้อความแรก จะเริ่มที่ `0.00%` Context และแสดงโควต้าจริงของพูลหลักทันที)
- **จำแนก Context 10 หมวด & รองรับโมเดลตระกูลล่าสุด:**
  - แยก Token ครบ 10 ประเภท พร้อมตัวสลับดู Main Agent / Subagent และรองรับ `Gemini 4 Neon`, `Orchestrator (Neon)`, `Gemini 4 Hydrogen`, `Gemini 4 Carbon`, `Gemini 4 Argon`, `Claude & GPT` พร้อมตารางราคาออฟไลน์ในตัว

---

## วิธีติดตั้ง

**ไม่ต้องติดตั้ง `npm install` หรือไลบรารีเสริมใดๆ** (ใช้เพียงโฟลเดอร์ปลั๊กอินชื่อ **`usage-monitor`**)

### วิธีที่ 1: ติดตั้งด้วย Git Clone (แนะนำ อัปเดตง่าย)

**Windows (PowerShell):**
```powershell
git clone https://github.com/Lavich99/antigravity-usage-monitor-th.git "$env:USERPROFILE\.gemini\config\plugins\usage-monitor"
```

**macOS / Linux:**
```bash
git clone https://github.com/Lavich99/antigravity-usage-monitor-th.git ~/.gemini/config/plugins/usage-monitor
```

---

### วิธีที่ 2: ก๊อปปี้คำสั่งให้ AI ใน Antigravity ติดตั้งให้เลย

เปิด Antigravity App แล้ววางข้อความนี้ลงในช่องแชท:

```text
Clone https://github.com/Lavich99/antigravity-usage-monitor-th.git ลงไปที่ ~/.gemini/config/plugins/usage-monitor แล้วเปิดใช้งานปลั๊กอิน usage-monitor ให้หน่อย
```

---

### วิธีที่ 3: ดาวน์โหลดเป็นไฟล์ ZIP ไปวางเอง

1. ดาวน์โหลดจากหน้า [`Releases`](https://github.com/Lavich99/antigravity-usage-monitor-th/releases) (หรือกดปุ่มสีเขียว **`<> Code` → `Download ZIP`** ด้านบนของคลัง)
2. แตกไฟล์แล้วเปลี่ยนชื่อโฟลเดอร์ข้างในให้ชื่อ **`usage-monitor`** (ห้ามชื่ออื่น) นำไปวางที่:
   - **Windows:** `%USERPROFILE%\.gemini\config\plugins\usage-monitor`
   - **macOS / Linux:** `~/.gemini/config/plugins/usage-monitor`

---

## วิธีใช้งาน

1. เปิด **Antigravity App** → ไปที่ **Customizations → Plugins / Installed** แล้วเปิดใช้งาน **`usage-monitor`**
2. **การเปิดใช้งานครั้งแรกบน Windows:**
   - ปลั๊กอินจะเติม `--remote-debugging-port=0` ลงในทางลัด (`Antigravity.lnk` บน Desktop, Start Menu, Taskbar) ให้อัตโนมัติเพื่อให้แถบ Capsule เกาะกับกล่องพิมพ์ได้
   - หากเปิดใช้ครั้งแรกแล้ว Capsule ยังไม่โผล่ในกล่องพิมพ์ ให้ **ปิดแล้วเปิด Antigravity App ใหม่ผ่านทางลัดเดิม 1 ครั้ง** หลังจากนั้นจะทำงานอัตโนมัติทุกครั้ง (ถ้าอัปเดตไฟล์ใหม่ กด **Reload Window** ได้ทันที)
3. **การควบคุม Capsule:**
   - **ชี้เมาส์ (Hover):** ดูสรุป `Context Window` และ `โควต้าคงเหลือ` แบบย่อ
   - **คลิกซ้าย:** เปิดหน้าต่างสรุปเต็ม 4 แท็บ (`เรียลไทม์`, `สถิติใช้งาน`, `รายละเอียด`, `ตั้งค่า`)
   - **คลิกขวา:** บังคับดึงข้อมูลและรีเฟรชโควต้าใหม่ทันที

---

## ความปลอดภัยและข้อมูลส่วนตัว

- **ทำงานบนเครื่อง 100% (Offline & Zero-LLM):** การตั้งค่า (`settings.json`) และแคชประวัติจะถูกเก็บไว้ในเครื่องของคุณเองที่ `~/.gemini/antigravity/sidecar_data/usage-monitor/panel/data/` เท่านั้น ไม่มีไฟล์ส่วนตัวปะปนในโฟลเดอร์ปลั๊กอิน
- **ไม่ส่งข้อมูลออกเน็ตและไม่อัปเดตเองเงียบๆ:** ค่าเริ่มต้นทำงานแบบออฟไลน์ 100% (`ปิดการเช็กอัปเดต`) หากต้องการให้แจ้งเตือนเมื่อมีรีลีสใหม่ สามารถเปิดโหมด **แจ้งเตือนเวอร์ชันใหม่ (Read-Only)** ในตั้งค่าได้ ซึ่งจะส่ง `GET` แบบอ่านอย่างเดียวไปที่ `Lavich99/antigravity-usage-monitor-th/releases/latest` เท่านั้น ไม่มีการโหลดหรือแก้ไฟล์อัตโนมัติ หากต้องการอัปเดตให้รันคำสั่งนี้ด้วยตัวเอง:
  ```powershell
  # Windows (PowerShell)
  git -C "$env:USERPROFILE\.gemini\config\plugins\usage-monitor" pull --ff-only
  ```
  ```bash
  # macOS / Linux
  git -C ~/.gemini/config/plugins/usage-monitor pull --ff-only
  ```

---

## พัฒนาต่อและบิลด์ไฟล์

พัฒนาด้วย Node.js ESM (แนะนำ `v22+`) และ Web Components โดยไม่พึ่งแพ็กเกจ `npm` ภายนอก:

```bash
cd sidecars/panel
node scripts/build-bundle.mjs
```

---

## เครดิตและสัญญาอนุญาต

- แยกสายพัฒนา (Hard Fork) จาก [`yuhuan-dev/antigravity-usage-monitor`](https://github.com/yuhuan-dev/antigravity-usage-monitor)
- เผยแพร่ภายใต้สัญญาอนุญาต [GNU General Public License v3.0](LICENSE)
