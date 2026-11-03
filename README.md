# Log Labeling Study

A static website for a log-labeling study. Students enter their name, work through one worked example per dataset (BGL, Thunderbird, HDFS), and then label groups of raw log lines (or HDFS blocks) semi-automatically: one judgment for a whole group, a split by a field value, or judgments on selected messages. The site records effective labeling time, keeps all progress in the student's own browser, and computes accuracy once the PI hands out a per-task passphrase.

There is no server and no database. Everything under `site/` is served as-is by GitHub Pages.

## Pages

| URL | Who | What |
|---|---|---|
| `index.html` | students | name entry, tasks, worked examples, labeling, backup, report, answer review |
| `pi.html` | PI | load the students' report files, paste the passphrases, recompute every metric, export CSV |

## Run locally

Any static file server works (ES modules do not load from `file://`):

```bash
python -m http.server 8000 --directory site
# open http://localhost:8000/
```

## Deploy

The workflow in `.github/workflows/pages.yml` publishes `site/` on every push to `main`.
One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Layout

```
site/
  index.html, pi.html, css/, js/     the application (plain JavaScript modules, no build step)
  examples.json                      the three worked-example groups (excluded from all queues and metrics)
  rules.json                         rule list shown in the judgment form (replace with the final list)
  guide.md                           labeling guide shown on the Guide page (replace with the final guide)
  data/                              generated task data (see below)
```

`rules.json` and `guide.md` can be replaced at any time without touching the code. Each rule has `id`, `dataset` (`bgl`, `tb`, `hdfs` or `*`), `label` (`normal`, `anomaly`, `unknown` or `*`), `title`, `text` and `note_required`.

## Data

`site/data/` is produced by the PI's private build script and committed as-is. It contains, per task: a group index, one file per group, raw lines in files of 2,000 lines (HDFS: block traces), and the reference answers encrypted with AES-256-GCM (key derived with PBKDF2-SHA256, 310,000 iterations). Task names in the data are opaque keys and display names only. Passphrases are not in this repository.

Rebuilding the data generates new passphrases. Students' saved progress stays valid as long as the data version (shown on the PI page) does not change.

## Notes for students

- Use your own name; it only separates your work from other students' in the same browser.
- Do not use a private / incognito window and do not clear browsing data. Export a backup regularly.
- The datasets and their labels are public. The answers are encrypted only to prevent accidental viewing.
