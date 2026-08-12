# Captured evidence

These JSON files are retained raw outputs from the audit. They are not all
valid large-production paired comparisons:

| File                                                  | Meaning                                                                            | Status                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `confirmatory-6d5d8b1-vs-7e62092.json`                | Exact baseline/candidate report with 12 paired blocks on the small/medium fixtures | Valid for confirmatory conclusions                     |
| `confirmatory-summary.json`                           | Deterministic summary of the exact report                                          | Valid for confirmatory conclusions                     |
| `reearth-dense-40-paired-fixed.json`                  | Exact baseline/candidate report for the 1+ GB Re:Earth Meshopt route             | Valid large-route paired comparison                    |
| `reearth-dense-40-paired-summary.json`                | Deterministic summary of the Re:Earth paired route                               | Valid large-route paired comparison                    |
| `reearth-dense-40-inventory.json`                     | Per-GLB sizes, checksums, decoded-byte estimates, and glTF inventories            | Valid production route inventory                        |
| `ion-4547222-full-transfer.json`                      | Per-content hashes and sizes for all 3,410 SPZ GLBs                                | Valid transfer inventory                               |
| `spz-concurrency-4547222.json`                        | Selected-view SPZ task and frame diagnostic                                        | Valid task-pressure diagnostic                         |
| `ion-spz-paired-route-validation-n10-superseded.json` | Earlier production SPZ route comparison                                            | Superseded because it used the wrong baseline worktree |
| `meshopt-task-shape-study.json`                       | Synthetic equal-byte Meshopt bufferView-count study                                | Synthetic diagnostic only                              |

The Re:Earth Meshopt route now has a valid exact-ref 1 GB paired report. No
exact-ref 1 GB SPZ, Draco/KTX2, Meshopt-terrain, or I3S-Draco paired report
exists yet; those gaps are recorded in `../large-asset-corpus.json`.
