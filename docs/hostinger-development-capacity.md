# Hostinger development release capacity

The guard admits prebuilt development releases on the existing Hostinger deployment lanes. Marketplace uses the established prebuilt AMD64 image and `deploy/install-marketplace.sh` under `/marketplace`. Admin uses its dedicated Compose project. The recovered API uses an image override layered onto its current Step 9 Compose configuration. Prepare exact, checksum-pinned artifacts on the build machine. Keep the Hybrid root, ingress, authentication and customer configuration on their existing release.

The guard is a Python 3.9+ operator tool with no package dependencies. Install the reviewed script in the restricted development release tooling directory alongside operator-owned phase plans. The local Docker socket must be accessible to the operator. Use the deployment account through its existing pinned SSH host key.

## Prepare a measured phase plan

Use a hostname-bound JSON file with `version` set to `1` and `host` set to the value of `hostname` on Hostinger. In `paths`, list the existing absolute directories for persistent database, upload and other mounted state involved in the release. Use Docker volume mountpoints or exact bind directories. The guard also discovers the local Docker root and filesystem of every retained rollback file.

In `allocations`, record every role below. Each allocation has a unique token `label`, an existing absolute directory `path` or the literal `$DOCKER_ROOT`, integer `bytes` and `inodes`, and a `basis` describing the measurement or zero allocation. Use multiple allocations when a role spans paths or artifacts. Use as many reserve entries as the affected filesystems require. In the initial plan, count the remaining peak costs from staging through activation and the intended rollback window. At each checkpoint, remove completed allocations only if the corresponding resources are already reflected in the new filesystem readback. Retain or adjust every pending allocation.

| Role | Measurement |
| --- | --- |
| `staging` | Sum `wc -c` sizes of exact source, image and configuration packages still to be transferred. Allow for filesystem block rounding, the actual temporary files created by the transfer method and the directory entries for staged files. For a streaming load, charge the storage used by the daemon and its temporary file path. |
| `extraction` | On a disposable builder, extract the exact source bundles and measure occupied blocks with `du -s -B1` and entries with `find . -printf . \| wc -c`. Charge both compressed and extracted copies when they coexist, including release directories and generated assets. |
| `image_load` | Measure the exact exports, image layers and file-entry counts. Use full unpacked layer sizes and rounded storage on the target driver or measure the peak `statvfs` delta during an isolated load on the same driver. Include temporary import space where Docker holds both content and unpacked layers. Count all layers by default. Credit layer reuse only with exact shared digests and a verified match to the target store. Include the migration operator if it needs to be loaded. |
| `migration_backup` | Use the latest verified dump sizes, current database/volume sizes and expected growth. Charge every new PostgreSQL, Mongo, receipt or private upload backup and related manifests on their actual destination filesystem. Budget for an in-progress dump and any separate verified copy that coexists. |
| `temporary_work` | Measure the workspace used for generated clients, Compose and edge snapshots, validation and migration work. Include rollback-compensation work here if it runs concurrently. Charge migration temporary files, indexes and database/WAL growth to the actual database mount. Use a rehearsal with synthetic data when the migration's storage behavior is uncertain. Host-side builds require their own isolated peak budget. |
| `rollback_recovery` | Keep all current and immediate rollback pins in place. Budget any additional archive copies, recovery materialization or isolated restore needed on Hostinger. Existing verified images and files already occupy disk and count once through the live available capacity. Record any measured external restore storage separately if the plan relies on it. |
| `operating_reserve` | Use observed bounded growth or a conservative measured application, database and log growth model for the maximum deployment and rollback window. Document the interval, workloads and basis for bytes and inodes. Every filesystem measured by the guard requires a positive reserve for both resources. |

For a zero allocation, describe the completed operation or applicable exclusion in `basis`. Use an `image_load` allocation on the discovered Docker filesystem, even for a phase where the candidate is already loaded. Add any separate containerd content, import or scratch filesystems used by the daemon. The guard adds allocations on the same filesystem and checks each distinct device independently.

Set `rollback_images` to tag/ID pairs with `tag` and full `id` from `docker image inspect --format '{{.Id}}'`. Include active images that serve as immediate rollback targets, plus other approved rollback pins. Set `rollback_artifacts` to records with `path` and `sha256` for nonempty, required restore files. Include the checksum-pinned pre-migration dump and appropriate Compose, edge or other recovery artifacts. Hash known non-secret paths in place. Keep credentials and customer data out of the plan, command arguments and evidence bundle. Record the location of any required protected environment in the restricted rollback runbook.

## Check and guard write phases

Run the check-only command through strict SSH before sending any candidate archive to Hostinger. `READY` confirms storage and rollback pins against the inputs. `BLOCKED` gives the remaining byte and inode deficits per filesystem. `ERROR` identifies unreadable capacity information, an invalid plan or missing rollback evidence. The process exits `0`, `1` or `2` respectively. In check-only mode it emits JSON on standard output and performs no writes. Treat readiness as an observation and recheck under the guard before the next write.

```bash
python3 "$release_tools/hostinger-dev-capacity.py" "$phase_plan"
```

Invoke each reviewed staged transfer, extraction, image load and migration/activation command under the guard. It acquires the same advisory lock for all three development lanes, checks live resources and rollback pins, and starts the command only after the check passes. Guarded invocations write the JSON result to standard error and return the command status after a successful gate. Keep the preflight and command on the same Docker engine and filesystem placement. Use trusted command arguments and keep the guarded operation in the foreground. The script's advisory lock protects releases run through this interface. Coordinate other host writers and copy jobs in the maintenance window.

```bash
python3 "$release_tools/hostinger-dev-capacity.py" "$before_load_plan" -- \
  docker --host unix:///var/run/docker.sock image load -i "$verified_archive"
```

For a streamed transfer, guard the receiver with the full pre-staging plan and preserve the candidate's exact checksum. For `scp`, check immediately before transfer, serialize the operator window and recheck before extraction or loading. Recheck before database backup and commit phases. Wrapper usage applies equally to the Marketplace installer and paired Compose operations when they are independently approved. The M12 activation evidence provides the release and rollback pins. Keep existing installer locks and all application health, access, data-integrity and rollback gates in force.

## Retain releases and recover capacity

At the start and end of each release, record the live and immediately previous images with exact IDs, ordered Compose paths, rollback pointers, backups and checksum receipts. Also record all active deployments and persistent mount owners on the shared host. Keep the current and immediate prior release, validated pre-migration data backup, and the specific staging directory required by the rollback runbook. Keep original transport packages and the exact commit manifest in their approved artifact store. Additional pins required by an unresolved incident or overlapping release remain protected until disposition is recorded.

Only consider deletion after a release passes verification and the appropriate rollback window has elapsed. Inspect every named candidate for active references, rollback dependencies, owner and measured allocated space. Approved removal candidates are individually verified disposable development BuildKit cache records or superseded temporary files with independently verified retained copies. Check idle, unshared and unreferenced cache identity and its dependency chain. Confirm ownership and disposable status again immediately before deletion. Record exact IDs or paths, before/after bytes and inodes, and pre/post health and pin checks. Escalate undocumented content for ownership review. Keep active images, rollback pins, databases, uploads, originals and unrelated services out of removal. Bulk Builder, Docker and volume pruning has no role in this procedure.

The isolated capacity fixtures use only temporary files and simulated filesystem and Docker measurements.

```bash
python3 -B deploy/test-hostinger-dev-capacity.py
```
