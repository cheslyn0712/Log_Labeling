# Labeling Rules

Version 2.1. These rules are complete: every BGL and Thunderbird line, and every HDFS block, is decided by exactly one rule below. Rule IDs are the ones you may pick in the tool (optional). Sources are listed in the last section.

## 1. What gets a label

You give **one label to each group**: **Normal**, **Anomalous** or **Can't tell**.

| Dataset | A group is | Label the group Anomalous when | Otherwise |
|---|---|---|---|
| BGL | lines with the same template, component and level | at least one of its lines matches an alert rule B-A01 … B-A11 | Normal (B-N01, B-N02) |
| Thunderbird | lines with the same service and template | at least one of its lines matches an alert rule T-A01 … T-A10 | Normal (T-N01) |
| HDFS | blocks with the same event counts | its blocks match H-A01, H-A02 or H-A03 | Normal (H-N01, H-N02) |

Use Can't tell only in the cases of Section 7.

Fixed principles:

1. **BGL and Thunderbird:** a line is Anomalous only if an alert rule matches it. A line that matches no alert rule is Normal, whatever words it contains (`error`, `failed`, `FATAL`, `exception`, `panic` …).
2. **BGL and Thunderbird:** a rule is tested on the line's own text. Neighbouring lines, other nodes, and time do not change a line's label. Context is only for reading.
3. **HDFS:** rules are tested on the event counts of the group, which all its blocks share.

## 2. How to test a rule

- A quoted phrase must appear in the line **exactly**: same letters, case, spaces and punctuation. Anything may come before, between or after it.
- If a rule lists several phrases, **all** of them must appear.
- **BGL line layout:** `<ts> <date> <node> <time> <node> RAS|NULL <COMPONENT> <SEVERITY> <message>`. Find the word `RAS` or `NULL`; the next word is the component, the word after it is the severity, the rest is the message. Some lines show the node only once; always find the severity this way. If a group's badge shows an impossible level (for example *Level Kill*), read the severity from the raw line.
- **HDFS events** are shown as T-numbers (hover an event in the tool to see its template). `T5×3` means event T5 occurs three times in the block's trace.

## 3. BGL rules

Test in this order. The first rule that applies decides.

| ID | Condition | Label |
|---|---|---|
| B-N01 | Severity is not `FATAL` and not `FAILURE` | Normal |
| B-A01 | Message contains `data TLB error interrupt` | Anomalous |
| B-A02 | Message contains `data storage interrupt` | Anomalous |
| B-A03 | Message contains `ciod: Error reading message prefix` and `CioStream` | Anomalous |
| B-A04 | Message contains `Lustre mount FAILED` | Anomalous |
| B-A05 | Message contains `rts: kernel terminated for reason` | Anomalous |
| B-A06 | Message contains `Error receiving packet on tree network` | Anomalous |
| B-A07 | Message contains `ciod: failed to read message prefix on control stream` | Anomalous |
| B-A08 | Message contains `rts panic! - stopping execution` | Anomalous |
| B-A09 | Message contains `ciod: Error creating node map from file` | Anomalous |
| B-A10 | Message contains `machine check interrupt` | Anomalous |
| B-A11 | Component is `KERNEL` and message contains `kernel panic` | Anomalous |
| B-N02 | Severity is `FATAL` or `FAILURE` and no rule B-A01 … B-A11 applies | Normal |

Notes:

- B-A01 needs the word `data`: `instruction TLB error interrupt` is not B-A01.
- B-A10 needs the word `interrupt` right after `machine check`: `machine check enable...`, `machine check summary...`, `machine check status register: …` are B-N02.
- The B-A rules are tested only after B-N01, so they apply only to `FATAL` and `FAILURE` lines.

## 4. Thunderbird rules

Test in this order. The first rule that applies decides.

| ID | The line contains | Label |
|---|---|---|
| T-A01 | `[KERNEL_IB]` and `Local Catastrophic Error` | Anomalous |
| T-A02 | `Connection refused (111) in open_demux` | Anomalous |
| T-A03 | `mptscsih:` and `attempting task abort!` | Anomalous |
| T-A04 | `EXT3-fs error` and `Detected aborted journal` | Anomalous |
| T-A05 | `Losing some ticks... checking if CPU frequency changed.` | Anomalous |
| T-A06 | `rejecting I/O to offline device` | Anomalous |
| T-A07 | `EventID: 1404` and `Memory device` | Anomalous |
| T-A08 | `Bad file descriptor (9) in tm_request` | Anomalous |
| T-A09 | `check-disks` and `Fault Status assert` | Anomalous |
| T-A10 | `NMI received` | Anomalous |
| T-N01 | No rule T-A01 … T-A10 applies | Normal |

Notes:

- T-A01 needs both phrases: other `[KERNEL_IB]` messages are T-N01.
- T-A04 needs both phrases: `EXT3-fs error … unable to read inode block`, `EXT3-fs: mounted filesystem …` and `EXT3-fs: recovery complete.` are T-N01.
- T-A10 needs `NMI received`: `NMI watchdog`, `LAPIC_NMI` are T-N01.

## 5. HDFS rules

Terms used below (counts are taken from the group's count vector):

- **Complete write:** T22 ≥ 1, T5 ≥ 3, T9 + T6 ≥ 3, T11 ≥ 3 and T26 ≥ 3.
- **Re-replication:** T25 occurs (`ask … to replicate …`).
- **File deletion:** T23 occurs (`NameSystem.delete: … is added to invalidSet …`).

Test in this order. The first rule that applies decides.

| ID | Condition | Label |
|---|---|---|
| H-A01 | The trace contains any of T7, T8, T10, T12, T13, T14, T17, T20, T24, T27, T28, T29, T31, T32 | Anomalous |
| H-A02 | The write is not complete | Anomalous |
| H-A03 | Re-replication and file deletion both occur | Anomalous |
| H-U01 | The trace contains T1, T15 or T19 | Can't tell |
| H-N02 | Re-replication occurs and file deletion does not | Normal |
| H-N01 | Any other trace | Normal |

Notes:

- T4 (`Got exception while serving … to …`) is part of normal reading; it never makes a block Anomalous by itself.
- More than three replicas (for example about ten copies of a job file) is Normal when the write is complete and no rule above H-N01 applies.
- All blocks of one HDFS group have the same event counts, so the rules give the same result for every block of the group.

## 6. Using the tool, step by step

**Start**

1. Open the site and enter your participant code (A, B, C or D).
2. *Home* lists your three tasks with their reference time. Each dataset has two worked examples, one Normal and one Anomalous group; read both before you start. The example groups are the same for everyone and are not part of any task.
3. Open a task and click **Start labeling**, or click any group in the list.

**The labeling page**

- Top bar: the task, the group number, the **task timer**, and **← Prev** / **Next →**.
- Header: BGL / Thunderbird template with its fields (`<*>1`, `<*>2` …), component and level (BGL) or service (Thunderbird); HDFS count vector.
- Left: **Messages** (distinct messages, most frequent first; filter box) and **Fields** (values of each field; click a value to filter); HDFS: **Blocks**.
- Middle: **Raw lines** of the clicked message and **Context** of a clicked line; HDFS: the clicked block's log, and ⇆ to compare two blocks.
- Right: the **label panel**.

**For every group**

1. Read the header and go through the dataset's rule table from the top.
2. BGL / Thunderbird: if a rule phrase lies in the template's fixed text, it applies to every line of the group. If the phrase covers a `<*>` field (for example `machine check <*>` or `<*> TLB error interrupt`), open **Fields** and check whether any value completes the phrase. HDFS: the rules depend only on the count vector; open two or three blocks to see the events.
3. Click **Normal**, **Anomalous** or **Can't tell** (or press 1, 2, 3). The label is saved at once. Clicked the wrong one? Click the right label; you can come back to any group and change its label at any time.
4. Optionally pick the rule and write a note.
5. Optionally click **Check answer**: the true label of the group is shown. Make sure your label is the one you mean first: the label you have when you check is the one that is scored. You can still change the label afterwards (for example after a slip of the mouse); the change is saved and recorded.
6. Click **Next →** (or press →).

**Task timer**

- The timer belongs to the task. It runs while a group of the task is open, the page is in front, and you used the mouse or keyboard in the last minute; it stops by itself when you are idle.
- **Pause** stops it until you click **Resume** (also across groups and after a reload). Pause for every break.
- **Adjust** sets the task's time to a value you enter (hours:minutes), for example if you forgot to pause. Every pause, resume and adjustment is recorded.

**Results**

- *Results* shows, per task, the groups labeled, time, accuracy, F1 and the share of Can't tell.
- **Download Excel** produces the file you send to the PI. It contains a *Summary* sheet (per task), a *Groups* sheet (every group with your label and the true label) and a *Time log* sheet.
- **Download backup** saves everything; a backup can be restored on another computer.

## 7. Can't tell

Use Can't tell only in these cases (a note on what is missing helps but is optional):

| ID | When |
|---|---|
| U-PARSE | The raw text is empty, cut off or garbled in a way that hides whether a rule phrase is present (BGL: or the severity cannot be found). |
| H-U01 | HDFS trace under rule H-U01. |

Do not use Can't tell because a message looks serious or looks harmless: the rules decide.

## 8. Sources

| Rules | Source |
|---|---|
| Label definition; B-N02, T-N01 (no matching rule → Normal) | Oliner & Stearley, DSN 2007, §1, §3.2, Table 2 caption; Oliner, Aiken & Stearley, ICDM 2008, §1, §3.1 |
| B-N01 | DSN 2007, Table 5 and §3.2 |
| B-A01 … B-A10 | DSN 2007, Table 4 (BG/L rows) |
| B-A11 | DSN 2007, §3.2 (published BG/L rule `($5 ~ /KERNEL/ && /kernel panic/)`) |
| T-A01 … T-A10 | DSN 2007, Table 4 (Thunderbird rows); T-A04 also ICDM 2008, Table 1 |
| H-A01 … H-A03, H-N01, H-N02 | Xu et al., SOSP 2009, §6.3 and Table 7; Landauer et al., FSE 2024, §3.1, Table 1, Fig. 2 |
| Line / block granularity; groups | Landauer et al., FSE 2024, §3.1–3.3; anomaly-detection-log-datasets, commit `5296693`, templates `BGL_templates.csv`, `Thunderbird_templates.csv`, `HDFS_templates.csv` |
