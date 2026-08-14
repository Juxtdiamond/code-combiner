# 📦 Code Combiner for AI

A lightweight, 100% local, single-page web app to incrementally drag, drop, and merge multiple source code files (`.js`, `.kt`, `.py`, `.ts`, etc.) into a single structured text block ready for LLM prompts (Gemini, ChatGPT, Claude).

![License](https://img.shields.io/badge/license-MIT-green.svg)
![Dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)

---

## ✨ Features

* **Incremental Staging:** Drag and drop one file now, add three more later—no accidental overwrites or lost files.
* **100% Private & Local:** All processing happens entirely in your browser using standard HTML5 APIs. Zero server uploads.
* **Auto-Save Resilience:** Built-in `localStorage` support preserves your staged files across page reloads and browser restarts.
* **Storage Limit Indicator:** Built-in size monitor alerts you if your file payload exceeds the 5MB browser auto-save limit.
* **File Management Cards:** View line counts, character sizes, and quickly delete individual files from the stack.
* **AI-Optimized Output:** Automatically formats merged code with clean file markers for easy AI parsing.

---

## 🚀 Quick Start

### Option 1: Use Locally
1. Clone or download this repository:
   ```bash
   git clone [https://github.com/YOUR_USERNAME/code-combiner.git](https://github.com/YOUR_USERNAME/code-combiner.git)
