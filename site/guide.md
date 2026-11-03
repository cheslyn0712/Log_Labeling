# Labeling guide

*Draft. The PI will replace this file with the final guide.*

## What you are deciding

Every log line (BGL, Thunderbird) or every block (HDFS) gets one label:

- **Normal** — routine system behaviour.
- **Anomalous** — matches a published alert rule, or clearly shows a failure.
- **Can't tell** — the evidence does not settle it. Use sparingly; it counts as a miss in recall.

Each judgment cites at least one rule from the [rule list](#/rules). Some rules require a note.

## How a group works

A *group* collects raw lines that share one event template (BGL: template + component + level; Thunderbird: service + template; HDFS: the event-count vector of a block).

1. **Look first.** Read the template, the Messages list and the Fields tab. Mark fields that are only identifiers (counters, addresses, node names, PIDs) as *instance info* — messages that differ only there collapse into one kind.
2. **Read raw lines** of several kinds, including the most frequent one and a rarer one, and open at least one context.
3. **Decide.**
   - All messages say the same thing → **Whole group** (one judgment).
   - A key field changes the meaning → **Split by field**: put values into parts, one judgment per part, plus “all other values”.
   - Otherwise → **Selected items**: judge one or more messages (blocks) at a time.
   - The same template appears in other groups of your task → **Merge** them into one judgment.
4. **Submit** when every message (block) is covered. Submitted groups are locked.

The site checks a minimum amount of looking before it lets you propagate a label to a whole group, and tells you what is still missing.

## BGL hints

- All published BGL alerts come from **FATAL** or **FAILURE** levels. INFO / WARNING / ERROR / SEVERE lines are normal even if they contain the word “error” (rule B-N01).
- A FATAL line is not automatically an alert: check it against rules B-P01 … B-P12.
- Example alert: `RAS KERNEL FATAL data TLB error interrupt` (B-P01).
- Example alert: `RAS APP FATAL ciod: Error reading message prefix after LOAD_MESSAGE on CioStream socket to 172.16.96.116:33569: Link has been severed` (B-P03).

## Thunderbird hints

- Most Thunderbird traffic is routine: ssh sessions, cron, service start/stop, dhcp. Use T-D0 and say what the routine operation is.
- Example alert: `kernel: [KERNEL_IB][ib_mad_dispatch][…] … EVAPI_process_local_mad failed, return code = -254 (Fatal error (Local Catastrophic Error))` (T-P01).
- Example alert: `kernel: EXT3-fs error (device sda5): ext3_journal_start_sb: Detected aborted journal` (T-P04).

## HDFS hints

- A healthy block is allocated, written to three replicas, possibly read and verified, and deleted. Different event orders are normal.
- `Got exception while serving` during reads is part of normal reading.
- Write-path exceptions, broken replica bookkeeping and failed deletes are anomalies (H-A01 … H-A03).

## Good practice

- Label at most 2–3 effective hours per day, and no more than 90 minutes in one sitting.
- Export a backup regularly (the site reminds you).
- Do not look up the public labels of these datasets.
