# ResultShield – Self-Healing Results Portal

A university results portal that automatically detects failures, recovers from errors, and keeps serving student results.

## Getting Started

**Requirements:** Node.js 22.5 or newer.

```bash
npm install
npm start
```

- **Student Portal:** http://localhost:5100
- **Admin Panel:** http://localhost:5100/admin
- **Health Console:** http://localhost:5200

**Demo admin password:** `admin123`  
Set your own password using the `ADMIN_KEY` environment variable.

## Key Features

- Student marksheet with total, percentage, grade, and pass/fail status.
- Download and print marksheets as PDF.
- Admin login with session security.
- Upload results using Excel or CSV.
- Add, edit, search, delete, publish, and export student records.
- Dashboard with system health and incident history.
- Light and dark themes with responsive layouts.

## Self-Healing Mechanisms

| Mechanism | Purpose |
|---|---|
| Health checks and automatic restart | Recovers from crashes and freezes |
| Retry with exponential backoff | Handles temporary database failures |
| Circuit breaker | Detects database outages |
| Cache fallback | Serves saved results during outages |
| Data repair | Detects corrupted records and restores backups |
| Load shedding | Handles traffic spikes |

Incidents are recorded in `logs/incidents.jsonl` and displayed in the health console.

## Technology Stack

- **Backend:** Node.js, Express
- **Frontend:** HTML, CSS, JavaScript
- **Database:** SQLite
- **Features:** PDF generation, Excel/CSV upload, checksums, automatic recovery

## AI Declaration

AI assistants (ChatGPT,Claude and Cline) were used during development and documentation.
