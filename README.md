# Log Labeling Study

A static website for a log-labeling study. Students enter their name, read one worked example per dataset (BGL, Thunderbird, HDFS), and then label groups of raw log lines (or HDFS blocks) semi-automatically: one judgment for a whole group, a split by a field value, or judgments on ticked messages. Submitting a group locks it and immediately shows its true labels. The site times effective labeling with a visible clock and keeps all progress in the student's own browser (any number of windows can be open).

There is no server and no database. Everything under `site/` is served as-is by GitHub Pages.

## Pages

`index.html` is the only page: name entry, tasks, worked examples, labeling (each group's answer is shown after it is submitted), and **Results & backup**.

On **Results & backup** each student sees, per task, the three numbers they report — effective labeling time, accuracy, and the share labeled “Can't tell” — and can copy them as text or download them as CSV. Accuracy counts the lines (HDFS: blocks) labeled Normal or Anomalous in submitted groups; time spent reviewing answers or examples is not labeling time. A backup file keeps every raw judgment and time record.

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
  index.html, css/, js/              the application (plain JavaScript modules, no build step)
  examples.json                      the three worked-example groups (excluded from all queues and metrics)
  rules.json                         rule list shown in the judgment form (replace with the final list)
  guide.md                           labeling guide shown on the Guide page (replace with the final guide)
  data/                              generated task data (see below)
```

`rules.json` and `guide.md` can be replaced at any time without touching the code. Each rule has `id`, `dataset` (`bgl`, `tb`, `hdfs` or `*`), `label` (`normal`, `anomaly`, `unknown` or `*`), `title`, `text` and `note_required`.

## Data

`site/data/` is produced by the PI's private build script and committed as-is. It contains, per task: a group index, one file per group, raw lines in files of 2,000 lines (HDFS: block traces), and one answer file per group. Answer files are AES-256-GCM encrypted only so they cannot be read at a glance; the site fetches a group's answer after the group is submitted. Task names in the data are opaque keys and display names only.

The build is deterministic, so students' saved progress stays valid as long as the data version (shown on the PI page) does not change.

## Notes for students

- Use your own name; it only separates your work from other students' in the same browser.
- Do not use a private / incognito window and do not clear browsing data. Export a backup regularly.
- The datasets and their labels are public. Look at a group's answer only after submitting it.
