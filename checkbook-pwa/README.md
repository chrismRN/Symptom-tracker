# Checkbook — Install on Your iPhone

A checkbook register in the style of ClearCheckbook. It runs fully offline and keeps your data on your phone.

## What it does

- **Named accounts**: Checking, Savings, Credit Card, Cash or Other, each with its own starting balance.
- **Register**: withdrawals, deposits, check numbers, payees, categories and memos. A running balance shows on every line.
  Search, and filter by cleared/uncleared.
- **Balances**: current, cleared (what the bank has posted) and projected (counts post-dated items).
  There's a net total across all accounts.
- **Transfers** between accounts (for example Checking → Savings) are recorded in both registers.
- **Reconcile**: enter your statement's ending balance, tick off the items, and the app shows the difference.
- **Bills & reminders**: weekly, every 2 weeks, monthly, quarterly, every 6 months, yearly or one-time.
  - Overdue and upcoming bills show on the home screen and as a badge on the Bills tab.
  - **Pay** records the transaction and moves the bill to its next due date. **Skip** moves it without paying.
  - **📅 Add to phone calendar** puts the bill on your iPhone calendar as a repeating event with alerts,
    so you get reminders even when the app is closed.
  - A 30-day outlook shows each account's balance after the bills that are coming up.
- **Reports**: money in/out and spending by category for each month. You can print or save it as a PDF.
- **Backup**: export/restore a JSON file and export a CSV for spreadsheets.

## Step 1: Host it (free)

**GitHub Pages:**
1. In this repository, go to **Settings → Pages**. Under "Branch", select the branch → **/(root)** → **Save**.
2. After about a minute the app is at `https://YOUR-USERNAME.github.io/Symptom-tracker/checkbook-pwa/`

You can also put the files from this folder in a repository of their own, as was done for RespiTrack.

## Step 2: Install on your iPhone

1. Open the URL in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.

## Important notes

- **Your data stays on your phone.** Nothing is sent anywhere. Clearing Safari website data erases it,
  so use **More → Export backup** regularly and keep the file in iCloud Drive / Files.
- Data isn't shared between devices. To move to a new phone, export a backup and restore it there.
