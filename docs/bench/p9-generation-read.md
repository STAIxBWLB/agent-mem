# P9 generation read receipt

Synthetic homes only, measured after the P9-1 review fixes. This is a read-path receipt, with no before/after speedup claim and no real-home or deployed-runtime evidence.

Runner: linux 6.8.0-90-generic, x64, Bun 1.4.2. Ten samples per size and workload; p95 is the maximum of those ten samples.

| Entries | Workload | p50 ms | p95 ms | Segment I/O and hashing |
| --- | --- | ---: | ---: | --- |
| 2,000 | Warm unchanged | 6.06 | 8.53 | 0 data bytes read or hashed |
| 2,000 | Unchanged reopen + list | 6.84 | 8.20 | 0 data bytes read or hashed |
| 2,000 | Seeded live append + list | 21.04 | 28.69 | 1,302,432-1,308,300 bytes read; 326-326 hashed |
| 2,000 | Cold changed open + list | 23.09 | 26.25 | 1,308,952-1,314,820 bytes read; 654,476-657,410 hashed |
| 20,000 | Warm unchanged | 61.98 | 73.42 | 0 data bytes read or hashed |
| 20,000 | Unchanged reopen + list | 59.94 | 63.03 | 0 data bytes read or hashed |
| 20,000 | Seeded live append + list | 247.02 | 256.11 | 13,058,434-13,064,320 bytes read; 327-327 hashed |
| 20,000 | Cold changed open + list | 262.85 | 281.83 | 13,064,974-13,070,860 bytes read; 6,532,487-6,535,430 hashed |

Counters measure SegmentReader data I/O and prefix/suffix hashing. They exclude small metadata reads and validation hashes for parsed rows. The core read path makes no Git calls, as retained by the fake-Git tripwire regression. Live SHA state is seeded by an untimed rebuild before the append samples. Changed live segments still read and compare prefix bytes, so these results do not claim suffix-only disk I/O. A cold changed handle verifies the prefix once before advancing its SHA state. The measured list projection still scans lifecycle metadata; no revision cache is added.

Harness SHA-256: `a00d4649d52be6dd61f8113dbde5049347b9603d0433176cb72d7b8bf59774f9`.

Memory source SHA-256: `1718354b51666bd6db51c74daefea7a6098e6d9ad7fa33218c4bd2ee4c89429f` (the harness hashes the sorted source filenames and their content digests).

Raw samples: [p9-generation-read.json](p9-generation-read.json). Rebuild with `bun scripts/generation-read-bench.ts`; it writes only stdout and disposable synthetic temporary homes, which it removes after the run.

Ordinary immutable legacy snapshots keep no historical full-body heap cache. Their on-disk copies remain local because migration and previous-commit receipts may refer to them; journal-aware cleanup or content-addressed reuse is a declared future improvement, not implemented here.
